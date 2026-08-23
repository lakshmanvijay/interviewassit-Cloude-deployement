const { ipcRenderer } = require('electron');
const { pathToFileURL } = require('url');
const path = require('path');
const { connectSttSession } = require('./sttSocket');
const { scrollElIntoTop } = require('./scroll');

// AudioWorklet modules load by URL, same-origin rules apply even under
// file:// — pathToFileURL handles the backslash/drive-letter conversion
// Windows paths need that a hand-built 'file://' + __dirname string wouldn't.
const VAD_WORKLET_URL = pathToFileURL(path.join(__dirname, 'vadProcessor.worklet.js')).href;

const VOICE_THRESHOLD  = 15;
const SILENCE_MS_SHORT = 650;
const SILENCE_MS_LONG  = 1800;
const MIN_STT_INTERVAL_MS = 1000;

const NOISE_PHRASES = [
  'thank you', 'thanks', 'thank you.', 'thanks.', 'thank you!',
  'mm-hmm', 'mm-hmm.', 'mmm', 'mm', 'hmm', 'uh', 'um',
  'you', 'you.', 'bye', 'bye.',
  'subscribe', 'like and subscribe', 'see you next time',
  '[blank_audio]', '[silence]', '...',
];

function downsampleTo16kPCM16(float32, inputSampleRate) {
  const targetRate = 16000;
  if (inputSampleRate === targetRate) {
    const out = new Int16Array(float32.length);
    for (let i = 0; i < float32.length; i++) {
      const s = Math.max(-1, Math.min(1, float32[i]));
      out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    return out;
  }

  const ratio = inputSampleRate / targetRate;
  const outLength = Math.round(float32.length / ratio);
  const out = new Int16Array(outLength);
  let offsetOut = 0;
  let offsetIn = 0;
  while (offsetOut < outLength) {
    const nextOffsetIn = Math.round((offsetOut + 1) * ratio);
    let sum = 0, count = 0;
    for (let i = offsetIn; i < nextOffsetIn && i < float32.length; i++) { sum += float32[i]; count++; }
    const avg = count ? sum / count : 0;
    const s = Math.max(-1, Math.min(1, avg));
    out[offsetOut] = s < 0 ? s * 0x8000 : s * 0x7fff;
    offsetOut++;
    offsetIn = nextOffsetIn;
  }
  return out;
}

function createVoiceController({ store, onTranscript, showOnScreen, onSpeechResumed }) {
  let listening       = false;
  let audioCtx        = null;
  let analyserNode    = null;
  let procNode        = null;
  let micStream       = null;
  let isSpeaking       = false;
  let silenceTimer     = null;
  let vadRafId         = null;
  let speechStartTime  = 0;
  let lastSttRequestTs = 0;
  let vadFreqBuf = null;
  let vadLastTs  = 0;
  let vadLo      = 0;
  let vadHi      = 0;
  let meterEl    = null;

  let lastQuestionAt = 0;
  const CONTINUATION_WINDOW_MS = 6000;

  let sttSession = null;

  function attachMeterEl(el) { meterEl = el; }

  function setVoiceStatus(text, cls) { store.setState({ voiceStatus: { text, cls: cls || '' } }); }
  function updateLiveTranscript(t)   { store.setState({ liveTranscript: t }); }

  let liveMsgId = null;

  let continuationBase = '';

  function showLiveQuestion(newText) {
    if (!liveMsgId) return;
    const id = liveMsgId;
    const text = continuationBase ? `${continuationBase} ${newText}`.trim() : newText;
    store.setState(s => {
      const idx = s.conversation.findIndex(m => m.id === id);
      if (idx === -1) {
        return { conversation: [...s.conversation, { id, role: 'user', content: text }] };
      }
      if (s.conversation[idx].content === text) return {};
      const conversation = s.conversation.slice();
      conversation[idx] = { ...conversation[idx], content: text };
      return { conversation };
    });
  }

  function abandonLiveQuestion(id = liveMsgId, base = continuationBase) {
    if (!id) return;
    if (liveMsgId === id) { liveMsgId = null; continuationBase = ''; }
    if (base) {
      store.setState(s => ({ conversation: s.conversation.map(m => (m.id === id ? { ...m, content: base } : m)) }));
    } else {
      store.setState(s => {
        if (!s.conversation.some(m => m.id === id)) return {};
        return { conversation: s.conversation.filter(m => m.id !== id) };
      });
    }
  }

  function detachLiveQuestion(id = liveMsgId) {
    if (liveMsgId === id) { liveMsgId = null; continuationBase = ''; }
    return id;
  }

  function setVadMeter(energy) {
    if (!meterEl) return;
    const pct = Math.min(100, (energy / 60) * 100);
    meterEl.style.width = pct + '%';
    meterEl.className = pct > 40 ? 'hot' : '';
  }

  async function toggleListen() {
    if (listening) { stopListening(); return; }

    try {
      const sources = await ipcRenderer.invoke('get-desktop-sources');
      if (!sources || !sources.length) throw new Error('No screen source');
      const sourceId = sources[0].id;

      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          mandatory: {
            chromeMediaSource: 'desktop',
            chromeMediaSourceId: sourceId,
            echoCancellation: false,
            noiseSuppression: false,
            autoGainControl: false
          }
        },
        video: {
          mandatory: {
            chromeMediaSource: 'desktop',
            chromeMediaSourceId: sourceId,
            maxWidth: 1, maxHeight: 1, maxFrameRate: 1
          }
        }
      });

      stream.getVideoTracks().forEach(t => t.stop());

      listening = true;
      store.setState({ listening: true });
      setVoiceStatus('capturing internal audio', 'live');
      await startVAD(stream);

    } catch (err) {
      setVoiceStatus('Capture failed: ' + err.message.slice(0, 45), 'err');
      setTimeout(() => setVoiceStatus('● audio off', ''), 4000);
    }
  }

  function stopListening() {
    listening = false;
    store.setState({ listening: false });
    cancelAnimationFrame(vadRafId);
    clearTimeout(silenceTimer);
    silenceTimer = null;

    if (sttSession) { sttSession.abort(); sttSession = null; }

    if (procNode) {
      try { procNode.disconnect(); } catch (e) {}
      procNode.port.onmessage = null;
      procNode = null;
    }
    if (micStream) { micStream.getTracks().forEach(t => t.stop()); micStream = null; }
    if (audioCtx)  { try { audioCtx.close(); } catch (e) {} audioCtx = null; }
    analyserNode = null; isSpeaking = false;
    setVoiceStatus('● audio off', '');
    updateLiveTranscript('');
    abandonLiveQuestion();
    setVadMeter(0);
  }

  // Was a ScriptProcessorNode — confirmed (Playwright repro + minidump
  // analysis: STATUS_ACCESS_VIOLATION inside electron.exe, isolated by
  // testing the analyser alone vs. the full graph) to reliably crash the
  // renderer outright a few seconds into every session, on machines where
  // DXGI desktop duplication isn't available so Chromium falls back to a
  // less-tested capture path. AudioWorkletNode is the modern replacement —
  // runs on the dedicated audio render thread via a separate module file
  // (vadProcessor.worklet.js) instead of ScriptProcessorNode's deprecated
  // main-thread callback machinery — and doesn't hit this crash.
  async function startVAD(stream) {
    micStream    = stream;
    audioCtx     = new AudioContext();
    analyserNode = audioCtx.createAnalyser();
    analyserNode.fftSize               = 1024;
    analyserNode.smoothingTimeConstant = 0.3;
    const source = audioCtx.createMediaStreamSource(stream);
    source.connect(analyserNode);
    vadFreqBuf = new Uint8Array(analyserNode.frequencyBinCount);
    const binHz = audioCtx.sampleRate / analyserNode.fftSize;
    vadLo = Math.max(0, Math.floor(300  / binHz));
    vadHi = Math.min(vadFreqBuf.length - 1, Math.ceil(3400 / binHz));

    await audioCtx.audioWorklet.addModule(VAD_WORKLET_URL);
    procNode = new AudioWorkletNode(audioCtx, 'vad-processor', {
      numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1,
      processorOptions: { bufferSize: 4096 }
    });
    source.connect(procNode);
    // Zero-gain — keeps this node part of the active render graph (reaching
    // destination) without the captured desktop audio actually being
    // audible, unlike the old ScriptProcessorNode which connected straight
    // to destination at full volume (a real, if secondary, feedback bug).
    const silentGain = audioCtx.createGain();
    silentGain.gain.value = 0;
    procNode.connect(silentGain);
    silentGain.connect(audioCtx.destination);
    procNode.port.onmessage = e => onAudioProcess(e.data);

    vadRafId = requestAnimationFrame(vadLoop);
  }

  // `float32` is one full render-quantum-accumulated buffer (bufferSize
  // samples, see vadProcessor.worklet.js) posted from the AudioWorklet
  // thread — same shape onAudioProcess always worked with (previously
  // e.inputBuffer.getChannelData(0) from a ScriptProcessorNode callback).
  function onAudioProcess(float32) {
    if (!isSpeaking || !sttSession) return;
    const pcm16 = downsampleTo16kPCM16(float32, audioCtx.sampleRate);
    sttSession.sendAudio(pcm16.buffer);
  }

  function beginUtterance() {
    const now = Date.now();
    if (!continuationBase && now - lastSttRequestTs < MIN_STT_INTERVAL_MS) {
      showOnScreen('Skipping extra STT request to reduce traffic');
      return;
    }

    console.log('[voice] utterance started, opening STT session');
    const session = connectSttSession('en', text => {
      if (sttSession === session) showLiveQuestion(text);
    });
    sttSession = session;
    session.ready()
      .then(() => {
        if (sttSession === session) console.log('[voice] STT session ready');
      })
      .catch(err => {
        if (sttSession === session) sttSession = null;
        console.error('[voice] STT connect failed:', err.message);
        showOnScreen('STT connect failed: ' + err.message);
      });
  }

  async function endUtterance() {
    const utteranceLiveMsgId = liveMsgId;
    const utteranceContinuationBase = continuationBase;

    const session = sttSession;
    sttSession = null;

    if (!session) {
      console.log('[voice] endUtterance: no session was open');
      updateLiveTranscript('');
      await handleTranscript('', utteranceLiveMsgId, utteranceContinuationBase);
      return;
    }

    lastSttRequestTs = Date.now();

    console.log('[voice] utterance ended, finalizing STT session');
    const finalizeStart = performance.now();
    const { text, error } = await session.finish();
    console.log(`[voice] STT finalize took ${Math.round(performance.now() - finalizeStart)}ms — text:`, JSON.stringify(text), 'error:', error);
    if (!listening) {
      abandonLiveQuestion(utteranceLiveMsgId, utteranceContinuationBase);
      return;
    }

    if (error) {
      showOnScreen('STT error: ' + error);
      setVoiceStatus('capturing internal audio', 'live');
      updateLiveTranscript('');
      await handleTranscript('', utteranceLiveMsgId, utteranceContinuationBase);
      return;
    }

    await handleTranscript(text, utteranceLiveMsgId, utteranceContinuationBase);
  }

  function vadLoop(ts) {
    if (!listening || !analyserNode) return;

    if (ts - vadLastTs < 50) { vadRafId = requestAnimationFrame(vadLoop); return; }
    vadLastTs = ts;

    analyserNode.getByteFrequencyData(vadFreqBuf);

    let sum = 0;
    for (let i = vadLo; i <= vadHi; i++) sum += vadFreqBuf[i];
    const energy = sum / (vadHi - vadLo + 1);

    setVadMeter(energy);

    if (energy > VOICE_THRESHOLD) {
      if (silenceTimer) { clearTimeout(silenceTimer); silenceTimer = null; }

      if (!isSpeaking) {
        isSpeaking      = true;
        speechStartTime = Date.now();
        setVoiceStatus('speaking', 'speaking');

        const conv = store.getState().conversation;
        const lastMsg = conv[conv.length - 1];
        const stillStreaming = !!(lastMsg && lastMsg.role === 'assistant' && lastMsg.streaming);
        const withinWindow = lastQuestionAt > 0 && (Date.now() - lastQuestionAt) < CONTINUATION_WINDOW_MS;
        const isContinuation = stillStreaming || withinWindow;

        if (isContinuation) {
          const userMsgs = conv.filter(m => m.role === 'user');
          const prevUser = userMsgs[userMsgs.length - 1];
          liveMsgId = prevUser.id;
          continuationBase = prevUser.content;
          if (onSpeechResumed) onSpeechResumed(liveMsgId);
        } else {
          liveMsgId = 'q_' + Date.now() + '_' + Math.random().toString(36).slice(2);
          continuationBase = '';
        }
        showLiveQuestion(isContinuation ? '' : '🔊 …');

        const thisLiveId = liveMsgId;
        scrollElIntoTop(() => document.querySelector(`[data-msg-id="${thisLiveId}"]`));
        beginUtterance();
      }

    } else if (isSpeaking) {
      if (!silenceTimer) {
        const spokenMs = Date.now() - speechStartTime;
        const waitMs   = spokenMs >= 900 ? SILENCE_MS_SHORT : SILENCE_MS_LONG;

        silenceTimer = setTimeout(async () => {
          isSpeaking   = false;
          silenceTimer = null;
          setVoiceStatus('capturing internal audio', 'live');
          showLiveQuestion('Transcribing…');
          console.log(`[voice] silence wait done (${waitMs}ms, spoke ${spokenMs}ms) — finalizing STT`);
          await endUtterance();
        }, waitMs);
      }
    }

    vadRafId = requestAnimationFrame(vadLoop);
  }

  async function handleTranscript(rawText, targetLiveMsgId, targetContinuationBase) {
    const text = (rawText || '').trim();
    const wasContinuation = !!targetContinuationBase;
    const base = targetContinuationBase;
    const isNoiseOrEmpty = !text || NOISE_PHRASES.includes(text.toLowerCase()) || text.split(/\s+/).length < 3;

    if (isNoiseOrEmpty && !wasContinuation) {
      console.log('[voice] transcript discarded as empty/noise:', JSON.stringify(text));
      if (listening) setVoiceStatus('capturing internal audio', 'live');
      abandonLiveQuestion(targetLiveMsgId, base);
      return;
    }

    const combinedText = wasContinuation
      ? (isNoiseOrEmpty ? base : `${base} ${text}`.trim())
      : text;

    console.log('[voice] asking:', JSON.stringify(combinedText), wasContinuation ? '(continuation)' : '');
    lastQuestionAt = Date.now();
    const liveId = detachLiveQuestion(targetLiveMsgId);
    await onTranscript(combinedText, liveId, wasContinuation);
    if (listening) setVoiceStatus('capturing internal audio', 'live');
  }

  return { toggleListen, stopListening, attachMeterEl, isListening: () => listening };
}

module.exports = { createVoiceController };
