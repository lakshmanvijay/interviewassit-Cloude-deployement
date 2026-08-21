const { ipcRenderer } = require('electron');
const { connectSttSession } = require('./sttSocket');
const { scrollElIntoTop } = require('./scroll');

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
// Guards against opening a new backend STT connection for genuine VAD
// flicker (energy oscillating right around VOICE_THRESHOLD re-triggers
// isSpeaking several times in quick succession for what's really one sound).
// Was previously measured from the PREVIOUS utterance's speech START
// (lastSttRequestTs stamped in beginUtterance) with a 2500ms window — that
// counted a real question's own speaking time + silence-wait against the
// budget, so two genuinely separate questions asked back to back (extremely
// common — "What's X? And when would you use it?") would often have their
// SECOND utterance's STT session skipped outright ("Skipping extra STT
// request"), silently dropping a real question with no answer ever
// generated. Now measured from the previous session's CLOSE (set in
// endUtterance below) instead, and shortened — true flicker re-triggers
// within tens/hundreds of ms of each other, while a deliberate next
// question is preceded by at least the silence-wait (650-1800ms) plus
// however long the interviewer pauses before starting it.
const MIN_STT_INTERVAL_MS = 800;
// 'okay'/'okay.' used to be in this list and got discarded whenever the VAD
// caught it as its own isolated fragment — but "Okay, so..."/"Okay, basically
// what happens is..." is an extremely common way people transition mid-
// explanation, not just a filler/acknowledgment. Discarding it (rather than
// carrying it forward as a continuation) was silently swallowing real
// content and — worse — burning through CONTINUATION_WINDOW_MS while doing
// it, so by the time the substantive words after it arrived, too much time
// had passed to still be recognized as a continuation of the question
// already in progress, splitting one continuous answer into two separate
// numbered questions. See isContinuation below.
const NOISE_PHRASES = [
  'thank you', 'thanks', 'thank you.', 'thanks.', 'thank you!',
  'mm-hmm', 'mm-hmm.', 'mmm', 'mm', 'hmm', 'uh', 'um',
  'you', 'you.', 'bye', 'bye.',
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
  // Widened from 4500 — this has to cover more than just "a normal pause
  // mid-sentence": lastQuestionAt is only set once the PREVIOUS utterance's
  // entire STT round trip finishes (see handleTranscript below), and in
  // between, a short filler/transition fragment ("okay", "so basically") can
  // eat a full silence-wait + its own STT open/finalize cycle before getting
  // discarded as noise — all before the real next sentence even starts being
  // recognized. That chain easily used up the old window on its own, so a
  // continuous multi-sentence answer with any brief filler in the middle was
  // getting split into two separate numbered questions instead of one.
  const CONTINUATION_WINDOW_MS = 6000;

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

  // Abandons a live bubble — used when the utterance turns out to be
  // empty/noise/errored, or listening is stopped mid-utterance — as opposed
  // to detachLiveQuestion() below, used when it's being handed off/kept. For
  // a brand-new (non-continuation) bubble this deletes it outright (it was
  // never a real question). For a continuation, the bubble IS a real,
  // already-asked question reused by id — deleting it would wipe it from
  // history, so this reverts its content back to just the original base
  // text instead, undoing the abandoned continuation attempt.
  //
  // Takes an explicit `id`/`base` (defaulting to the current shared
  // liveMsgId/continuationBase, so every existing no-args call site keeps
  // working unchanged) rather than always reading the shared state — see
  // endUtterance() below: its call can resolve LATE, after a newer
  // utterance has already moved liveMsgId on to its own bubble, and must
  // still clean up the RIGHT (older) one rather than the new one. Only
  // clears the shared liveMsgId/continuationBase if they still point at
  // this same id, so a late call for an already-superseded utterance can't
  // clobber the newer one's in-progress state.
  function abandonLiveQuestion(id = liveMsgId, base = continuationBase) {
    if (!id) return;
    if (liveMsgId === id) { liveMsgId = null; continuationBase = ''; }
    if (base) {
      store.setState(s => ({ conversation: s.conversation.map(m => (m.id === id ? { ...m, content: base } : m)) }));
    } else {
      store.setState(s => {
        if (!s.conversation.some(m => m.id === id)) return {}; // no-op
        return { conversation: s.conversation.filter(m => m.id !== id) };
      });
    }
  }

  // Hands a live bubble's id off to the caller (App.js's ask(), to
  // finalize/reuse it as the real submitted question). Takes an explicit
  // `id` (defaulting to the current shared liveMsgId) for the same
  // late-resolution reason as abandonLiveQuestion above — only clears the
  // shared liveMsgId/continuationBase if they still point at this id.
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
    abandonLiveQuestion();
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
    // Continuations skip the rate limit entirely — by this point the
    // in-flight answer has already been cancelled (onSpeechResumed fired in
    // vadLoop below), so skipping here would leave that cancelled answer
    // stranded with nothing to ever replace it.
    if (!continuationBase && now - lastSttRequestTs < MIN_STT_INTERVAL_MS) {
      // Rate-limited — skip opening a new backend connection for this
      // utterance (unlike a local recording, opening a live socket is a
      // real backend resource, so this is checked at speech-start now
      // instead of after recording finishes). lastSttRequestTs is stamped
      // when the PREVIOUS session closed (see endUtterance below), not when
      // it opened — see MIN_STT_INTERVAL_MS's comment for why.
      showOnScreen('Skipping extra STT request to reduce traffic');
      return;
    }

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
    // Captured now, synchronously, before any await — pins THIS utterance's
    // finalize logic (here and in handleTranscript below) to the exact
    // bubble/continuation-state that was live when its silence period
    // ended, immune to a NEWER utterance moving the shared liveMsgId/
    // continuationBase on while this one is still waiting on the STT server
    // to finalize (session.finish() below is a real network round trip —
    // easily slow enough for the interviewer to already be asking the next
    // question by the time it resolves). Without this, handleTranscript
    // would hand off/abandon whatever bubble HAPPENS to be current by then
    // (the newer utterance's) instead of this one's own — leaving this
    // utterance's bubble orphaned forever, stuck on its last placeholder
    // text ("Transcribing…", visible permanently in the conversation as if
    // it were a real asked question).
    const utteranceLiveMsgId = liveMsgId;
    const utteranceContinuationBase = continuationBase;

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
      await handleTranscript('', utteranceLiveMsgId, utteranceContinuationBase);
      return;
    }

    // Stamped here (a real session actually closing) rather than in the
    // `!session` branch above (nothing closed — most often because THIS
    // utterance was itself rate-limited) — resetting the clock on a no-op
    // would just push the window out again and could rate-limit every
    // subsequent utterance in a chain forever. See MIN_STT_INTERVAL_MS.
    lastSttRequestTs = Date.now();

    console.log('[voice] utterance ended, finalizing STT session');
    // Brackets the actual STT round trip (client → our backend → Deepgram →
    // back), which is the one leg of "time from stop-speaking to answer
    // rendering" that neither the fixed silence-wait log above nor the
    // backend's own "First token in Xms" log (LLM-only, logged server-side)
    // covers — isolating it here settles whether a slow answer is coming
    // from STT finalize specifically vs. from the LLM/network leg after it.
    const finalizeStart = performance.now();
    const { text, error } = await session.finish();
    console.log(`[voice] STT finalize took ${Math.round(performance.now() - finalizeStart)}ms — text:`, JSON.stringify(text), 'error:', error);
    if (!listening) {
      // Session was stopped while this was finalizing — stopListening()
      // already abandoned whatever bubble was current AT THAT MOMENT, which
      // may not be this utterance's own (a newer one could have taken over
      // liveMsgId first). abandonLiveQuestion no-ops harmlessly if this one
      // was already cleaned up, and — via its own liveMsgId===id check —
      // can't clobber a newer utterance's state either way.
      abandonLiveQuestion(utteranceLiveMsgId, utteranceContinuationBase);
      return;
    }

    if (error) {
      showOnScreen('STT error: ' + error);
      setVoiceStatus('capturing internal audio', 'live');
      updateLiveTranscript('');
      await handleTranscript('', utteranceLiveMsgId, utteranceContinuationBase); // same fallback reasoning as above
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
          // Latency instrumentation — see endUtterance()'s own timing log for
          // why this is split into two numbers: this is the FIXED wait
          // (already known/tunable — SILENCE_MS_SHORT/LONG above), separate
          // from the STT finalize round trip, which varies with network/
          // Deepgram conditions and is the actual unknown in "why did this
          // particular question feel slow".
          console.log(`[voice] silence wait done (${waitMs}ms, spoke ${spokenMs}ms) — finalizing STT`);
          await endUtterance();
        }, waitMs);
      }
    }

    vadRafId = requestAnimationFrame(vadLoop);
  }

  // `targetLiveMsgId`/`targetContinuationBase` are the SPECIFIC bubble/
  // continuation-state this utterance owned when its silence period ended
  // — captured and passed in by endUtterance() rather than read from the
  // shared liveMsgId/continuationBase here, because by the time this runs
  // (after an STT network round trip) a newer utterance may have already
  // moved those shared variables on to itself. Using them directly here
  // would hand off/abandon the WRONG bubble. See endUtterance()'s comment.
  async function handleTranscript(rawText, targetLiveMsgId, targetContinuationBase) {
    const text = (rawText || '').trim();
    const wasContinuation = !!targetContinuationBase;
    const base = targetContinuationBase;
    const isNoiseOrEmpty = !text || NOISE_PHRASES.includes(text.toLowerCase()) || text.split(/\s+/).length < 3;

    if (isNoiseOrEmpty && !wasContinuation) {
      // A genuinely new, standalone utterance that turned out to be
      // silence/noise/too short — nothing real was ever asked, so just
      // drop the live bubble.
      console.log('[voice] transcript discarded as empty/noise:', JSON.stringify(text));
      // Guarded — handleTranscript is reached via async hops (the silence
      // timer → endUtterance → here), so the session can have already been
      // quit/stopListening() called in between. Without this check, this
      // would stomp stopListening()'s '● audio off' status back to
      // "capturing internal audio" right after the session ended.
      if (listening) setVoiceStatus('capturing internal audio', 'live');
      abandonLiveQuestion(targetLiveMsgId, base);
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
    // Hand this bubble's id off rather than clearing it — App.js's ask()
    // (when autoAsk is on) finalizes that exact same bubble in place
    // instead of creating a second new one.
    const liveId = detachLiveQuestion(targetLiveMsgId);
    await onTranscript(combinedText, liveId, wasContinuation);
    // Guarded for the same reason as the branch above — onTranscript() can
    // take a while (network round trip), long enough for the session to
    // have been quit and stopListening() already run in the meantime.
    if (listening) setVoiceStatus('capturing internal audio', 'live');
  }

  return { toggleListen, stopListening, attachMeterEl, isListening: () => listening };
}

module.exports = { createVoiceController };
