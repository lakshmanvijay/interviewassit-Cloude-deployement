// Replaces the deprecated ScriptProcessorNode as the raw-PCM tap for live
// STT (see voice.js's startVAD). Runs on the browser's dedicated audio
// rendering thread rather than the main thread.
//
// AudioWorkletProcessor.process() is called once per 128-sample render
// quantum (~2.9ms @ 44.1kHz) — posting a message to the main thread on every
// call would be excessive. Instead this buffers quanta up to 4096 samples
// (matching the old ScriptProcessorNode buffer size voice.js was tuned
// around) before handing the chunk off via postMessage, transferring the
// underlying ArrayBuffer instead of copying it.
class PCMTapProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._buf = new Float32Array(4096);
    this._writeIdx = 0;
  }

  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (channel && channel.length) {
      for (let i = 0; i < channel.length; i++) {
        this._buf[this._writeIdx++] = channel[i];
        if (this._writeIdx === this._buf.length) {
          this.port.postMessage(this._buf, [this._buf.buffer]);
          this._buf = new Float32Array(4096);
          this._writeIdx = 0;
        }
      }
    }
    // Keep this node alive for the life of the audio graph — the tap runs
    // continuously for as long as listening is on, not per-utterance (see
    // startVAD's comment on why).
    return true;
  }
}

registerProcessor('pcm-tap-processor', PCMTapProcessor);
