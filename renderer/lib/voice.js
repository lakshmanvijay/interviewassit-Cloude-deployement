const { ipcRenderer } = require('electron');
const { connectSttSession } = require('./sttSocket');

const VOICE_THRESHOLD  = 15;    // energy level above which we consider the user to be speaking
const SILENCE_MS_SHORT = 1200;  // silence after a long question  (≥2 s speech) → fire fast
const SILENCE_MS_LONG  = 2500;  // silence after a short fragment (<2 s speech) → small buffer
const MIN_STT_INTERVAL_MS = 3000; // don't open more than one STT session every 3 seconds
const NOISE_PHRASES = [
  'thank you', 'thanks', 'thank you.', 'thanks.', 'thank you!',
  'mm-hmm', 'mm-hmm.', 'mmm', 'mm', 'hmm', 'uh', 'um',
  'you', 'you.', 'bye', 'bye.', 'okay', 'okay.',
  'subscribe', 'like and subscribe', 'see you next time',
  '[blank_audio]', '[silence]', '...',
];

// Downsamples one ScriptProcessorNode callback's worth of Float32 samples
// (at the AudioContext's native rate, typically 44.1/48 kHz) to 16 kHz mono
// Int16 PCM — the format the live STT socket streams. Simple box-filter
// averaging per output sample; good enough for speech, no external deps.
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

// Owns the whole VAD / live-STT pipeline. The VAD meter is written
// directly to a DOM node via `attachMeterEl` (bypassing the store/vdom) so
// the ~20fps energy readout never triggers a component re-render.
function createVoiceController({ store, onTranscript, showOnScreen }) {
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

  // Current utterance's live STT session, if one is open. sttSocket.js
  // handles queuing audio sent before the backend acks "ready" internally,
  // so onAudioProcess can call sendAudio() unconditionally.
  let sttSession = null;

  function attachMeterEl(el) { meterEl = el; }

  function setVoiceStatus(text, cls) { store.setState({ voiceStatus: { text, cls: cls || '' } }); }
  function updateLiveTranscript(t)   { store.setState({ liveTranscript: t }); }

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
      startVAD(stream);

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
      procNode.onaudioprocess = null;
      procNode = null;
    }
    if (micStream) { micStream.getTracks().forEach(t => t.stop()); micStream = null; }
    if (audioCtx)  { try { audioCtx.close(); } catch (e) {} audioCtx = null; }
    analyserNode = null; isSpeaking = false;
    setVoiceStatus('● audio off', '');
    updateLiveTranscript('');
    setVadMeter(0);
  }

  function startVAD(stream) {
    micStream    = stream;
    audioCtx     = new AudioContext();
    analyserNode = audioCtx.createAnalyser();
    analyserNode.fftSize               = 1024;
    analyserNode.smoothingTimeConstant = 0.3;
    const source = audioCtx.createMediaStreamSource(stream);
    source.connect(analyserNode);
    vadFreqBuf = new Uint8Array(analyserNode.frequencyBinCount);
    // Pre-compute bin range once — sampleRate and fftSize never change
    const binHz = audioCtx.sampleRate / analyserNode.fftSize;
    vadLo = Math.max(0, Math.floor(300  / binHz));
    vadHi = Math.min(vadFreqBuf.length - 1, Math.ceil(3400 / binHz));

    // Raw PCM tap — runs continuously (like analyserNode) rather than being
    // created/destroyed per utterance, since ScriptProcessorNode setup mid
    // VAD-detected-speech would risk missing the very first audio callback.
    // Connecting to destination keeps onaudioprocess firing reliably even
    // though the output is never written to (silent — mic isn't looped to
    // speakers).
    procNode = audioCtx.createScriptProcessor(4096, 1, 1);
    source.connect(procNode);
    procNode.connect(audioCtx.destination);
    procNode.onaudioprocess = onAudioProcess;

    vadRafId = requestAnimationFrame(vadLoop);
  }

  function onAudioProcess(e) {
    if (!isSpeaking || !sttSession) return;
    const pcm16 = downsampleTo16kPCM16(e.inputBuffer.getChannelData(0), audioCtx.sampleRate);
    sttSession.sendAudio(pcm16.buffer);
  }

  function beginUtterance() {
    const now = Date.now();
    if (now - lastSttRequestTs < MIN_STT_INTERVAL_MS) {
      // Rate-limited — skip opening a new backend connection for this
      // utterance (unlike a local recording, opening a live socket is a
      // real backend resource, so this is checked at speech-start now
      // instead of after recording finishes).
      showOnScreen('Skipping extra STT request to reduce traffic');
      return;
    }
    lastSttRequestTs = now;

    console.log('[voice] utterance started, opening STT session');
    const session = connectSttSession('en');
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
    const session = sttSession;
    sttSession = null;

    if (!session) { console.log('[voice] endUtterance: no session was open'); updateLiveTranscript(''); return; }

    console.log('[voice] utterance ended, finalizing STT session');
    const { text, error } = await session.finish();
    console.log('[voice] STT session result — text:', JSON.stringify(text), 'error:', error);
    if (!listening) return;

    if (error) {
      showOnScreen('STT error: ' + error);
      setVoiceStatus('capturing internal audio', 'live');
      updateLiveTranscript('');
      return;
    }

    await handleTranscript(text);
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
        updateLiveTranscript('🔊 interviewer speaking…');
        beginUtterance();
      }

    } else if (isSpeaking) {
      if (!silenceTimer) {
        const spokenMs = Date.now() - speechStartTime;
        const waitMs   = spokenMs >= 2000 ? SILENCE_MS_SHORT : SILENCE_MS_LONG;

        silenceTimer = setTimeout(async () => {
          isSpeaking   = false;
          silenceTimer = null;
          setVoiceStatus('capturing internal audio', 'live');
          updateLiveTranscript('Transcribing…');
          await endUtterance();
        }, waitMs);
      }
    }

    vadRafId = requestAnimationFrame(vadLoop);
  }

  async function handleTranscript(rawText) {
    const text = (rawText || '').trim();

    if (!text) {
      console.log('[voice] transcript was empty — nothing to ask');
      setVoiceStatus('capturing internal audio', 'live');
      updateLiveTranscript('');
      return;
    }

    if (NOISE_PHRASES.includes(text.toLowerCase()) || text.split(/\s+/).length < 3) {
      console.log('[voice] transcript discarded as noise/too short:', JSON.stringify(text));
      setVoiceStatus('capturing internal audio', 'live');
      updateLiveTranscript('');
      return;
    }

    console.log('[voice] asking:', JSON.stringify(text));
    updateLiveTranscript(text);
    await onTranscript(text);
    if (listening) updateLiveTranscript('');
    setVoiceStatus('capturing internal audio', 'live');
  }

  return { toggleListen, stopListening, attachMeterEl, isListening: () => listening };
}

module.exports = { createVoiceController };
