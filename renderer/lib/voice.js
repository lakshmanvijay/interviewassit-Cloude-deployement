const { ipcRenderer } = require('electron');

const VOICE_THRESHOLD  = 15;    // energy level above which we consider the user to be speaking
const SILENCE_MS_SHORT = 1000;  // silence after a long question  (≥2 s speech) → fire fast
const SILENCE_MS_LONG  = 2200;  // silence after a short fragment (<2 s speech) → small buffer
const MIN_STT_INTERVAL_MS = 3000; // don't send more than one STT request every 3 seconds
const NOISE_PHRASES = [
  'thank you', 'thanks', 'thank you.', 'thanks.', 'thank you!',
  'mm-hmm', 'mm-hmm.', 'mmm', 'mm', 'hmm', 'uh', 'um',
  'you', 'you.', 'bye', 'bye.', 'okay', 'okay.',
  'subscribe', 'like and subscribe', 'see you next time',
  '[blank_audio]', '[silence]', '...',
];

function pcmToWav(samples, sampleRate) {
  const dataLen = samples.length * 2;
  const buf  = new ArrayBuffer(44 + dataLen);
  const view = new DataView(buf);
  const ws   = (off, s) => { for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i)); };
  ws(0, 'RIFF'); view.setUint32(4, 36 + dataLen, true);
  ws(8, 'WAVE'); ws(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  ws(36, 'data'); view.setUint32(40, dataLen, true);
  const pcm = new Int16Array(buf, 44);
  for (let i = 0; i < samples.length; i++) {
    pcm[i] = Math.max(-32768, Math.min(32767, Math.round(samples[i] * 32767)));
  }
  return new Uint8Array(buf);
}

// Owns the whole VAD / recording / STT pipeline. The VAD meter is written
// directly to a DOM node via `attachMeterEl` (bypassing the store/vdom) so
// the ~20fps energy readout never triggers a component re-render.
function createVoiceController({ store, onTranscript, showOnScreen }) {
  let listening       = false;
  let audioCtx        = null;
  let analyserNode    = null;
  let micStream       = null;
  let recorder        = null;
  let recChunks       = [];
  let isSpeaking       = false;
  let silenceTimer     = null;
  let vadRafId         = null;
  let recMime          = '';
  let speechStartTime  = 0;
  let lastSttRequestTs = 0;
  let vadFreqBuf = null;
  let vadLastTs  = 0;
  let vadLo      = 0;
  let vadHi      = 0;
  let meterEl    = null;

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
    stopRecorder();
    if (micStream) { micStream.getTracks().forEach(t => t.stop()); micStream = null; }
    if (audioCtx)  { try { audioCtx.close(); } catch (e) {} audioCtx = null; }
    analyserNode = null; isSpeaking = false;
    setVoiceStatus('● audio off', '');
    updateLiveTranscript('');
    setVadMeter(0);
  }

  function startVAD(stream) {
    micStream    = stream;
    recMime      = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
                     ? 'audio/webm;codecs=opus' : 'audio/webm';
    audioCtx     = new AudioContext();
    analyserNode = audioCtx.createAnalyser();
    analyserNode.fftSize               = 1024;
    analyserNode.smoothingTimeConstant = 0.3;
    audioCtx.createMediaStreamSource(stream).connect(analyserNode);
    vadFreqBuf = new Uint8Array(analyserNode.frequencyBinCount);
    // Pre-compute bin range once — sampleRate and fftSize never change
    const binHz = audioCtx.sampleRate / analyserNode.fftSize;
    vadLo = Math.max(0, Math.floor(300  / binHz));
    vadHi = Math.min(vadFreqBuf.length - 1, Math.ceil(3400 / binHz));
    vadRafId = requestAnimationFrame(vadLoop);
  }

  function startRecorder() {
    stopRecorder();
    recChunks = [];
    recorder  = new MediaRecorder(micStream, { mimeType: recMime });
    recorder.ondataavailable = e => { if (e.data && e.data.size > 0) recChunks.push(e.data); };
    recorder.start(100);
  }

  function stopRecorder() {
    if (recorder && recorder.state !== 'inactive') {
      try { recorder.stop(); } catch (e) {}
    }
    recorder = null;
  }

  function flushRecorder() {
    return new Promise(resolve => {
      if (!recorder || recorder.state === 'inactive') {
        resolve([...recChunks]);
        recChunks = [];
        return;
      }
      recorder.onstop = () => {
        const clips = [...recChunks];
        recChunks   = [];
        recorder    = null;
        resolve(clips);
      };
      try { recorder.stop(); } catch (e) { resolve([]); }
    });
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
        startRecorder();
        setVoiceStatus('speaking', 'speaking');
        updateLiveTranscript('🔊 interviewer speaking…');
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

          const now = Date.now();
          if (now - lastSttRequestTs < MIN_STT_INTERVAL_MS) {
            showOnScreen('Skipping extra STT request to reduce traffic');
            updateLiveTranscript('');
            return;
          }

          const clip = await flushRecorder();
          if (clip.length && listening) {
            lastSttRequestTs = Date.now();
            transcribeAndAsk(clip);
          }
        }, waitMs);
      }
    }

    vadRafId = requestAnimationFrame(vadLoop);
  }

  async function transcribeAndAsk(chunks) {
    try {
      const webmBuf = await new Blob(chunks, { type: recMime }).arrayBuffer();

      let decoded;
      try {
        decoded = await audioCtx.decodeAudioData(webmBuf.slice(0));
      } catch {
        setVoiceStatus('capturing internal audio', 'live');
        updateLiveTranscript('');
        return;
      }

      if (decoded.duration < 0.8) {
        setVoiceStatus('capturing internal audio', 'live');
        updateLiveTranscript('');
        return;
      }

      const targetSR  = 16000;
      const offCtx    = new OfflineAudioContext(1, Math.ceil(decoded.duration * targetSR), targetSR);
      const src       = offCtx.createBufferSource();
      src.buffer      = decoded;
      src.connect(offCtx.destination);
      src.start(0);
      const resampled = await offCtx.startRendering();

      const wavBytes = pcmToWav(resampled.getChannelData(0), targetSR);

      const result = await ipcRenderer.invoke('stt-transcribe', {
        audioBuffer: wavBytes,
        mimeType: 'audio/wav'
      });

      if (result.error) {
        showOnScreen('STT error: ' + result.error);
        setVoiceStatus('capturing internal audio', 'live');
        updateLiveTranscript('');
        return;
      }

      const text = (result.text || '').trim();

      if (!text) {
        setVoiceStatus('capturing internal audio', 'live');
        updateLiveTranscript('');
        return;
      }

      if (NOISE_PHRASES.includes(text.toLowerCase()) || text.split(/\s+/).length < 3) {
        setVoiceStatus('capturing internal audio', 'live');
        updateLiveTranscript('');
        return;
      }

      updateLiveTranscript(text);

      await onTranscript(text);

      if (listening) updateLiveTranscript('');
      setVoiceStatus('capturing internal audio', 'live');

    } catch (e) {
      showOnScreen('Error: ' + e.message);
      setVoiceStatus('capturing internal audio', 'live');
      updateLiveTranscript('');
    }
  }

  return { toggleListen, stopListening, attachMeterEl, isListening: () => listening };
}

module.exports = { createVoiceController };
