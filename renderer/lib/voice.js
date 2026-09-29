const { ipcRenderer } = require('electron');
const path = require('path');
const { pathToFileURL } = require('url');
const { connectSttSession } = require('./sttSocket');

// audioWorklet.addModule() needs a fetchable URL, not a require()'d module —
// resolved once here relative to this file. See pcm-worklet-processor.js.
const PCM_WORKLET_URL = pathToFileURL(path.join(__dirname, 'pcm-worklet-processor.js')).href;

const VOICE_THRESHOLD  = 15;
const SILENCE_MS_SHORT = 1200;
const SPEECH_ATTACK_MS = 250;
const MIN_VOICED_MS = 450;
const PRE_ROLL_MS = 500;
const SILENCE_MS_LONG  = 1800;
const NOISE_PHRASES = [
  'thank you', 'thanks', 'thank you.', 'thanks.', 'thank you!',
  'mm-hmm', 'mm-hmm.', 'mmm', 'mm', 'hmm', 'uh', 'um',
  'you', 'you.', 'bye', 'bye.',
  'subscribe', 'like and subscribe', 'see you next time',
  '[blank_audio]', '[silence]', '...',
];

// Filter conversational filler before it reaches answer generation. Do not
// require a question mark: STT often omits punctuation, and prompts such as
// "Explain purchase orders" are valid interview questions.
function isNonQuestionSpeech(text) {
  const words = text.toLowerCase().replace(/[^\p{L}\p{N}'\s]/gu, ' ').replace(/\s+/g, ' ').trim();
  if (!words) return true;
  const remainder = words.replace(/^(?:(?:oh|yes|yeah|yep|no|nope|okay|ok|right|sure|maybe|well|hmm|um|uh|like|so|and|actually|basically|i mean|you know|all right|thank you|thanks)\b\s*)+/, '').trim();
  if (!remainder) return true;
  // A trailing article/possessive signals unfinished speech, not a request.
  if (/\b(?:the|a|an|my|your|our|their|i mean|you know)$/.test(remainder)) return true;
  return /^(?:it|that|this) (?:will|would|can|could) (?:learn|work|do|happen)$/.test(remainder);
}

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
  let workletNode     = null;
  let micStream       = null;
  let isSpeaking       = false;
  let silenceTimer     = null;
  let vadRafId         = null;
  let speechStartTime  = 0;
  let vadFreqBuf = null;
  let vadLastTs  = 0;
  let vadLo      = 0;
  let vadHi      = 0;
  let meterEl    = null;
  let candidateStart = 0;
  let audioQueue = [];
  let queuedSamples = 0;
  let noiseFloor = 0;
  let voicedMs = 0;

  let lastQuestionAt = 0;
  const CONTINUATION_WINDOW_MS = 4000;

  let sttSession = null;

  // Set while a previous utterance's endUtterance() (STT finalize +
  // handleTranscript) is still in flight — awaited by a new speech-start
  // (see vadLoop's handleSpeechStart) before it decides continuation vs.
  // new question. Without this, a quick pause-then-resume could race: STT
  // finalize is a real network round trip (session.finish()), and
  // lastQuestionAt/the conversation array only update once handleTranscript
  // actually runs — a resumption detected before that finishes would see
  // stale state and wrongly start a brand new question instead of
  // continuing the one still being finalized.
  let endUtterancePromise = null;

  function attachMeterEl(el) { meterEl = el; }

  function setVoiceStatus(text, cls) { store.setState({ voiceStatus: { text, cls: cls || '' } }); }
  function updateLiveTranscript(t)   { store.setState({ liveTranscript: t }); }

  let liveMsgId = null;

  let continuationBase = '';

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
            // 16x16, not 1x1 — Chromium's I420 desktop-capture pipeline needs
            // even width/height (chroma planes are half-resolution); a 1x1
            // frame is a degenerate size that crashed the renderer outright.
            // Track is stopped immediately below regardless, so this costs nothing.
            maxWidth: 16, maxHeight: 16, maxFrameRate: 1
          }
        }
      });

      stream.getVideoTracks().forEach(t => t.stop());

      listening = true;
      store.setState({ listening: true });
      setVoiceStatus('capturing internal audio', 'live');
      await startVAD(stream);

    } catch (err) {
      stopListening();
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

    if (workletNode) {
      try { workletNode.disconnect(); } catch (e) {}
      workletNode.port.onmessage = null;
      workletNode = null;
    }
    if (micStream) { micStream.getTracks().forEach(t => t.stop()); micStream = null; }
    if (audioCtx)  { try { audioCtx.close(); } catch (e) {} audioCtx = null; }
    analyserNode = null; isSpeaking = false;
    candidateStart = 0;
    audioQueue = [];
    queuedSamples = 0;
    lastQuestionAt = 0;
    noiseFloor = 0;
    voicedMs = 0;
    vadLastTs = 0;
    setVoiceStatus('● audio off', '');
    updateLiveTranscript('');
    abandonLiveQuestion();
    setVadMeter(0);
  }

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

    // Raw PCM tap via AudioWorkletNode, not the deprecated (and crash-prone
    // on some machines — see pcm-worklet-processor.js) ScriptProcessorNode.
    // Connecting to destination keeps it pulled/running reliably even though
    // the output is never written to (silent — mic isn't looped to speakers).
    await audioCtx.audioWorklet.addModule(PCM_WORKLET_URL);
    workletNode = new AudioWorkletNode(audioCtx, 'vad-processor', { processorOptions: { bufferSize: 4096 } });
    workletNode.port.onmessage = onAudioProcess;
    source.connect(workletNode);
    workletNode.connect(audioCtx.destination);

    vadRafId = requestAnimationFrame(vadLoop);
  }

  // Split out of vadLoop so it can await any in-flight endUtterance() before
  // deciding continuation vs. new question — see endUtterancePromise's
  // comment above for why that race existed. vadLoop itself stays a plain
  // synchronous rAF callback (fire-and-forget call below), so the meter/
  // energy sampling cadence is never blocked by this wait.
  async function handleSpeechStart() {
    if (endUtterancePromise) {
      try { await endUtterancePromise; } catch (e) {}
      // Listening may have been turned off, or this may have been a very
      // short blip that's already over, while we were waiting.
      if (!listening || !isSpeaking) return;
    }

    const conv = store.getState().conversation;
    const prevUser = conv.filter(m => m.role === 'user').pop();
    const withinWindow = lastQuestionAt > 0 && (Date.now() - lastQuestionAt) < CONTINUATION_WINDOW_MS;
    // An answer still streaming does not mean the next question belongs to it.
    const isContinuation = withinWindow && prevUser && !/[.!?]\s*$/.test(prevUser.content);

    if (isContinuation) {
      liveMsgId = prevUser.id;
      continuationBase = prevUser.content;
    } else {
      liveMsgId = 'q_' + Date.now() + '_' + Math.random().toString(36).slice(2);
      continuationBase = '';
    }
    // Reserve an ID privately. App.ask renders only after the finalized
    // transcript passes duration, noise, and filler checks.
    beginUtterance();
  }

  function onAudioProcess(e) {
    if (!listening || !audioCtx) return;
    const pcm16 = downsampleTo16kPCM16(e.data, audioCtx.sampleRate);
    if (isSpeaking && sttSession) {
      sttSession.sendAudio(pcm16.buffer);
      return;
    }
    // Preserve the first syllable during speech detection and audio arriving
    // while the previous session finalizes. Bound memory if the server stalls.
    audioQueue.push(pcm16);
    queuedSamples += pcm16.length;
    const limit = 16000 * (isSpeaking ? 10 : PRE_ROLL_MS / 1000);
    while (queuedSamples > limit && audioQueue.length > 1) {
      queuedSamples -= audioQueue.shift().length;
    }
  }

  function beginUtterance() {

    console.log('[voice] utterance started, opening STT session');
    const session = connectSttSession('en');
    sttSession = session;
    for (const pcm of audioQueue) session.sendAudio(pcm.buffer);
    audioQueue = [];
    queuedSamples = 0;
    session.ready()
      .then(() => {
        if (sttSession === session) console.log('[voice] STT session ready');
      })
      .catch(err => {
        session.abort();
        if (sttSession === session) sttSession = null;
        console.error('[voice] STT connect failed:', err.message);
        showOnScreen('STT connect failed: ' + err.message);
      });
  }

  function endUtterance() {
    const p = doEndUtterance();
    endUtterancePromise = p;
    p.finally(() => { if (endUtterancePromise === p) endUtterancePromise = null; });
    return p;
  }

  async function doEndUtterance() {
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

    // Silence waiting time must not turn a brief disturbance into speech.
    if (voicedMs < MIN_VOICED_MS) {
      session.abort();
      abandonLiveQuestion(utteranceLiveMsgId, utteranceContinuationBase);
      updateLiveTranscript('');
      return;
    }

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
    const frameMs = vadLastTs ? Math.min(ts - vadLastTs, 100) : 50;
    vadLastTs = ts;

    analyserNode.getByteFrequencyData(vadFreqBuf);

    let sum = 0;
    for (let i = vadLo; i <= vadHi; i++) sum += vadFreqBuf[i];
    const energy = sum / (vadHi - vadLo + 1);

    setVadMeter(energy);

    // Track quiet room/system noise only outside speech. A margin above that
    // floor keeps a steady background hum from repeatedly opening sessions.
    const threshold = Math.max(VOICE_THRESHOLD, noiseFloor + 10);
    if (!isSpeaking && !candidateStart && energy <= threshold) {
      noiseFloor += (Math.min(energy, 30) - noiseFloor) * 0.08;
    }

    if (energy > threshold) {
      if (!candidateStart) candidateStart = ts;
      // Short clicks and isolated noise must not start or extend an utterance.
      if (ts - candidateStart < SPEECH_ATTACK_MS) {
        vadRafId = requestAnimationFrame(vadLoop);
        return;
      }
      if (silenceTimer) { clearTimeout(silenceTimer); silenceTimer = null; }

      if (!isSpeaking) {
        isSpeaking      = true;
        voicedMs        = SPEECH_ATTACK_MS;
        speechStartTime = Date.now();
        setVoiceStatus('speaking', 'speaking');
        handleSpeechStart();
      } else {
        voicedMs += frameMs;
      }

    } else {
      candidateStart = 0;
      if (isSpeaking && !silenceTimer) {
        const spokenMs = Date.now() - speechStartTime;
        const waitMs   = spokenMs >= 900 ? SILENCE_MS_SHORT : SILENCE_MS_LONG;

        silenceTimer = setTimeout(async () => {
          isSpeaking   = false;
          silenceTimer = null;
          setVoiceStatus('capturing internal audio', 'live');
          console.log(`[voice] silence wait done (${waitMs}ms, spoke ${spokenMs}ms) — finalizing STT`);
          await endUtterance();
        }, waitMs);
      }
    }

    vadRafId = requestAnimationFrame(vadLoop);
  }

  async function handleTranscript(rawText, targetLiveMsgId, targetContinuationBase) {
    const text = (rawText || '').trim();
    // STT punctuation is unreliable. A fresh question or imperative starts
    // its own turn even when the preceding transcript has no final period.
    const startsQuestion = /^(?:(?:okay|ok|yes|yeah|right|well|like|actually|basically|so|and|now|then|also|please|i mean|you know)\b[\s,.:!?]*)*(?:what|why|how|when|where|who|which|can|could|would|should|do|does|did|is|are|was|were|has|have|tell|explain|describe|compare|implement|write|design|walk|give|show|define|discuss|list)\b/i.test(text);
    const wasContinuation = !!targetContinuationBase && !startsQuestion;
    if (targetContinuationBase && !wasContinuation) {
      detachLiveQuestion(targetLiveMsgId);
      targetLiveMsgId = null;
    }
    const base = targetContinuationBase;
    const normalized = text.toLowerCase().replace(/[.!?,]+$/g, '').trim();
    const isNoiseOrEmpty = !text || NOISE_PHRASES.includes(normalized)
      || /^(?:\[.*\]|\(.*\))$/.test(text)
      || /^(?:(?:meow|mew|woof|bark|hmm|um|uh)[\s,.!?]*)+$/i.test(text);

    if (isNoiseOrEmpty || isNonQuestionSpeech(text)) {
      console.log('[voice] transcript discarded as empty/noise:', JSON.stringify(text));
      if (listening) setVoiceStatus('capturing internal audio', 'live');
      abandonLiveQuestion(targetLiveMsgId, base);
      return;
    }

    const combinedText = wasContinuation
      ? `${base} ${text}`.trim()
      : text;

    console.log('[voice] asking:', JSON.stringify(combinedText), wasContinuation ? '(continuation)' : '');
    lastQuestionAt = Date.now();
    const liveId = detachLiveQuestion(targetLiveMsgId);
    if (wasContinuation && store.getState().autoAsk && onSpeechResumed) onSpeechResumed(liveId);
    // Answer generation can take seconds; it must never block audio intake.
    Promise.resolve(onTranscript(combinedText, liveId, wasContinuation)).catch(err => {
      showOnScreen('Question failed: ' + err.message);
    });
    if (listening) setVoiceStatus('capturing internal audio', 'live');
  }

  return { toggleListen, stopListening, attachMeterEl, isListening: () => listening };
}

module.exports = { createVoiceController };
