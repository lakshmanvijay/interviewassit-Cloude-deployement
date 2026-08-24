const { ipcRenderer } = require('electron');
const path = require('path');
const { pathToFileURL } = require('url');
const { connectSttSession } = require('./sttSocket');
const { scrollElIntoTop } = require('./scroll');

// AudioWorklet module URL for the raw-PCM tap (replaces the deprecated
// ScriptProcessorNode) — resolved once at load time relative to this file,
// not require()'d, since audioWorklet.addModule() needs a fetchable URL.
const PCM_WORKLET_URL = pathToFileURL(path.join(__dirname, 'pcm-worklet-processor.js')).href;

const VOICE_THRESHOLD  = 15;    // energy level above which we consider the user to be speaking
// Trimmed down from 1150/2500 — this silence wait is pure dead time added on
// top of STT finalization + the LLM's own time-to-first-token, and was the
// single biggest lever available client-side to hit a ~2s total response
// target. Trade-off: a shorter wait is more likely to cut off someone who
// pauses mid-sentence (they'd need to rely on the continuation-regeneration
// flow — see onSpeechResumed — to recover, rather than the pause just being
// absorbed silently). If real usage shows too many premature cutoffs, raise
// these back up rather than pushing them even lower.
const SILENCE_MS_SHORT = 650;   // silence after a long question  (≥2 s speech) → fire fast
const SILENCE_MS_LONG  = 1800;  // silence after a short fragment (<2 s speech) → small buffer
const MIN_STT_INTERVAL_MS = 2500; // don't open more than one STT session every 3 seconds
const NOISE_PHRASES = [
  'thank you', 'thanks', 'thank you.', 'thanks.', 'thank you!',
  'mm-hmm', 'mm-hmm.', 'mmm', 'mm', 'hmm', 'uh', 'um',
  'you', 'you.', 'bye', 'bye.', 'okay', 'okay.',
  'subscribe', 'like and subscribe', 'see you next time',
  '[blank_audio]', '[silence]', '...',
];

// Downsamples one PCM-tap-worklet chunk's worth of Float32 samples
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
  let lastSttRequestTs = 0;
  let vadFreqBuf = null;
  let vadLastTs  = 0;
  let vadLo      = 0;
  let vadHi      = 0;
  let meterEl    = null;

  // When the last question was finalized/handed off (Date.now(), set in
  // handleTranscript below) — used alongside "is the answer still
  // streaming" to detect a continuation. Streaming-state alone isn't
  // reliable: a fast answer (Cerebras can finish a short one in under a
  // second) may already be done by the time someone resumes talking after
  // just a 2s pause, which would otherwise misfire as a brand new,
  // disconnected question instead of continuing the one they paused mid-way
  // through. This time window catches that case regardless of how fast the
  // answer happened to generate.
  let lastQuestionAt = 0;
  const CONTINUATION_WINDOW_MS = 4500;

  // Current utterance's live STT session, if one is open. sttSocket.js
  // handles queuing audio sent before the backend acks "ready" internally,
  // so onAudioProcess can call sendAudio() unconditionally.
  let sttSession = null;

  function attachMeterEl(el) { meterEl = el; }

  function setVoiceStatus(text, cls) { store.setState({ voiceStatus: { text, cls: cls || '' } }); }
  function updateLiveTranscript(t)   { store.setState({ liveTranscript: t }); }

  // Live question bubble — renders the interviewer's words directly into
  // its own numbered Q slot in the main conversation feed as they're
  // recognized (a completely normal user message from the moment it's
  // created — no separate placeholder bubble that then gets thrown away and
  // replaced), instead of a small status line above. `liveMsgId` is
  // per-utterance (freshly generated in beginUtterance below, cleared once
  // handed off) rather than a fixed constant — reusing one fixed id across
  // utterances would let the *next* question's live updates overwrite an
  // already-finalized *previous* question that still happens to share the id.
  let liveMsgId = null;

  // Non-empty when the current utterance is a CONTINUATION of the previous
  // question (interviewer resumed talking while its answer was still
  // streaming) rather than a brand new one — holds that previous question's
  // already-asked text, which newly recognized words get appended to. See
  // the continuation-detection block in vadLoop below.
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
      if (s.conversation[idx].content === text) return {}; // no-op, skip a re-render
      const conversation = s.conversation.slice();
      conversation[idx] = { ...conversation[idx], content: text };
      return { conversation };
    });
  }

  // Abandons the current live bubble — used when the utterance turns out to
  // be empty/noise/errored, or listening is stopped mid-utterance — as
  // opposed to detachLiveQuestion() below, used when it's being handed
  // off/kept. For a brand-new (non-continuation) bubble this deletes it
  // outright (it was never a real question). For a continuation, the bubble
  // IS a real, already-asked question reused by id — deleting it would wipe
  // it from history, so this reverts its content back to just the original
  // base text instead, undoing the abandoned continuation attempt.
  function abandonLiveQuestion() {
    if (!liveMsgId) return;
    const id = liveMsgId;
    const base = continuationBase;
    liveMsgId = null;
    continuationBase = '';
    if (base) {
      store.setState(s => ({ conversation: s.conversation.map(m => (m.id === id ? { ...m, content: base } : m)) }));
    } else {
      store.setState(s => {
        if (!s.conversation.some(m => m.id === id)) return {}; // no-op
        return { conversation: s.conversation.filter(m => m.id !== id) };
      });
    }
  }

  // Hands the live bubble's id off to the caller (App.js's ask(), to
  // finalize/reuse it as the real submitted question) and resets liveMsgId +
  // continuationBase so the *next* utterance is guaranteed to allocate a
  // fresh id instead of touching this now-handed-off one.
  function detachLiveQuestion() {
    const id = liveMsgId;
    liveMsgId = null;
    continuationBase = '';
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
            // 16x16, not 1x1 — Chromium's desktop-capture frames go through
            // its I420 (YUV 4:2:0) pipeline, which requires even width/height
            // since chroma planes are subsampled at half resolution. A 1x1
            // frame is a degenerate/odd size that crashes the GPU/renderer
            // process on Windows (the whole app dies with no JS-catchable
            // error — this is what caused the app to vanish right after
            // starting a session). This track is stopped immediately below
            // regardless, so the larger size costs nothing.
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
    // Pre-compute bin range once — sampleRate and fftSize never change
    const binHz = audioCtx.sampleRate / analyserNode.fftSize;
    vadLo = Math.max(0, Math.floor(300  / binHz));
    vadHi = Math.min(vadFreqBuf.length - 1, Math.ceil(3400 / binHz));

    // Raw PCM tap — runs continuously (like analyserNode) rather than being
    // created/destroyed per utterance, since setup mid VAD-detected-speech
    // would risk missing the very first audio callback. Uses AudioWorkletNode
    // (off-main-thread, not the deprecated ScriptProcessorNode) — see
    // pcm-worklet-processor.js. Connecting to destination keeps it pulled/
    // running reliably even though the output is never written to (silent —
    // mic isn't looped to speakers).
    await audioCtx.audioWorklet.addModule(PCM_WORKLET_URL);
    workletNode = new AudioWorkletNode(audioCtx, 'pcm-tap-processor');
    workletNode.port.onmessage = onAudioProcess;
    source.connect(workletNode);
    workletNode.connect(audioCtx.destination);

    vadRafId = requestAnimationFrame(vadLoop);
  }

  function onAudioProcess(e) {
    if (!isSpeaking || !sttSession) return;
    // e.data is the Float32Array chunk posted by pcm-worklet-processor.js
    const pcm16 = downsampleTo16kPCM16(e.data, audioCtx.sampleRate);
    sttSession.sendAudio(pcm16.buffer);
  }

  function beginUtterance() {
    const now = Date.now();
    // Continuations skip the rate limit entirely — by this point the
    // in-flight answer has already been cancelled (onSpeechResumed fired in
    // vadLoop below), so skipping here would leave that cancelled answer
    // stranded with nothing to ever replace it.
    if (!continuationBase && now - lastSttRequestTs < MIN_STT_INTERVAL_MS) {
      // Rate-limited — skip opening a new backend connection for this
      // utterance (unlike a local recording, opening a live socket is a
      // real backend resource, so this is checked at speech-start now
      // instead of after recording finishes).
      showOnScreen('Skipping extra STT request to reduce traffic');
      return;
    }
    lastSttRequestTs = now;

    console.log('[voice] utterance started, opening STT session');
    // Live captions: show the interviewer's words directly in the main
    // conversation feed as they're recognized (showLiveQuestion), instead of
    // the small voice-bar status line. Guarded by `sttSession === session`
    // so a stale callback from an already-replaced session (e.g.
    // rate-limited then a new one opened) can't clobber the live bubble of
    // the utterance actually in progress.
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
    const session = sttSession;
    sttSession = null;

    if (!session) {
      // No session ever opened for this utterance (e.g. beginUtterance()
      // was rate-limited). Routed through handleTranscript('') rather than
      // abandoning directly: for a plain question that just deletes the
      // never-really-started live bubble as before, but for a continuation
      // it makes sure the already-cancelled in-flight answer still gets
      // regenerated (falling back to the original question text alone)
      // instead of being left stranded with nothing to replace it.
      console.log('[voice] endUtterance: no session was open');
      updateLiveTranscript('');
      await handleTranscript('');
      return;
    }

    console.log('[voice] utterance ended, finalizing STT session');
    const { text, error } = await session.finish();
    console.log('[voice] STT session result — text:', JSON.stringify(text), 'error:', error);
    if (!listening) return;

    if (error) {
      showOnScreen('STT error: ' + error);
      setVoiceStatus('capturing internal audio', 'live');
      updateLiveTranscript('');
      await handleTranscript(''); // same fallback reasoning as above
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

        // Treat this as a CONTINUATION of the previous question — reuse its
        // message id and text as a base to append to, and tell App.js to
        // cancel/replace the stale answer immediately — if EITHER:
        // (a) that answer is still generating/streaming right now, or
        // (b) it was asked very recently (within CONTINUATION_WINDOW_MS),
        //     even if it already finished streaming. (b) is what actually
        //     covers a normal mid-sentence pause: a fast answer can finish
        //     generating in under a second, so relying on "still streaming"
        //     alone would misfire as a brand new question the moment
        //     someone resumes just slightly slower than the answer.
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

        // Scroll the question into view the instant it starts appearing —
        // not after it's fully recognized. `thisLiveId` is captured now
        // rather than reading the outer `liveMsgId` inside the delayed
        // callback, so a fast next utterance overwriting `liveMsgId` in the
        // meantime can't make this scroll to the wrong bubble.
        const thisLiveId = liveMsgId;
        scrollElIntoTop(() => document.querySelector(`[data-msg-id="${thisLiveId}"]`));
        beginUtterance();
      }

    } else if (isSpeaking) {
      if (!silenceTimer) {
        const spokenMs = Date.now() - speechStartTime;
        // Lowered from 2000ms — most real interview questions are complete
        // thoughts well under 2s of continuous speech, so that threshold was
        // routing the common case into the slower SILENCE_MS_LONG wait.
        const waitMs   = spokenMs >= 1200 ? SILENCE_MS_SHORT : SILENCE_MS_LONG;

        silenceTimer = setTimeout(async () => {
          isSpeaking   = false;
          silenceTimer = null;
          setVoiceStatus('capturing internal audio', 'live');
          showLiveQuestion('Transcribing…');
          await endUtterance();
        }, waitMs);
      }
    }

    vadRafId = requestAnimationFrame(vadLoop);
  }

  async function handleTranscript(rawText) {
    const text = (rawText || '').trim();
    const wasContinuation = !!continuationBase;
    const base = continuationBase;
    const isNoiseOrEmpty = !text || NOISE_PHRASES.includes(text.toLowerCase()) || text.split(/\s+/).length < 3;

    if (isNoiseOrEmpty && !wasContinuation) {
      // A genuinely new, standalone utterance that turned out to be
      // silence/noise/too short — nothing real was ever asked, so just
      // drop the live bubble.
      console.log('[voice] transcript discarded as empty/noise:', JSON.stringify(text));
      setVoiceStatus('capturing internal audio', 'live');
      abandonLiveQuestion();
      return;
    }

    // A continuation ALWAYS hands off, even if the new fragment itself was
    // noise/empty — App.js's onSpeechResumed already cancelled the previous
    // in-flight answer the moment this utterance started, so at minimum we
    // must regenerate using the original question alone rather than leaving
    // that cancelled answer's bubble stuck empty with nothing to replace it.
    const combinedText = wasContinuation
      ? (isNoiseOrEmpty ? base : `${base} ${text}`.trim())
      : text;

    console.log('[voice] asking:', JSON.stringify(combinedText), wasContinuation ? '(continuation)' : '');
    // Marks "just asked" for the continuation time-window check in vadLoop
    // above — resets on every question (new or continued) so the window
    // always measures from the most recent one, not the very first.
    lastQuestionAt = Date.now();
    // Hand the live bubble's id off rather than clearing it — App.js's
    // ask() (when autoAsk is on) finalizes that exact same bubble in place
    // instead of creating a second new one. detachLiveQuestion() also resets
    // liveMsgId/continuationBase so the *next* utterance is guaranteed a
    // fresh id.
    const liveId = detachLiveQuestion();
    await onTranscript(combinedText, liveId, wasContinuation);
    setVoiceStatus('capturing internal audio', 'live');
  }

  return { toggleListen, stopListening, attachMeterEl, isListening: () => listening };
}

module.exports = { createVoiceController };
