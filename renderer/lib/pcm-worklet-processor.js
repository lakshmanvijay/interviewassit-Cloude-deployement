// AudioWorkletProcessor replacing the deprecated ScriptProcessorNode that
// was crashing the renderer outright (STATUS_ACCESS_VIOLATION inside
// electron.exe — confirmed via minidump analysis) a few seconds into every
// Live Assist session on machines where DXGI desktop duplication isn't
// available. Runs in its own AudioWorkletGlobalScope on the audio render
// thread — no DOM, no Node/require, no access to anything outside this
// file and what's passed via processorOptions/port messages.
//
// Accumulates render quanta (128 samples each) into the same 4096-sample
// buffer size the old ScriptProcessorNode used, then posts the full Float32
// buffer back to the main thread — keeps voice.js's existing downsample/STT
// pipeline (downsampleTo16kPCM16, onAudioProcess-equivalent) unchanged; only
// how the raw samples arrive changes.
class VadProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const bufferSize = (options && options.processorOptions && options.processorOptions.bufferSize) || 4096;
    this.buf = new Float32Array(bufferSize);
    this.writeIdx = 0;
  }

  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (channel) {
      for (let i = 0; i < channel.length; i++) {
        this.buf[this.writeIdx++] = channel[i];
        if (this.writeIdx >= this.buf.length) {
          // .slice() copies — the transferred buffer must not alias this.buf,
          // which keeps getting written into on the next render quantum.
          this.port.postMessage(this.buf.slice());
          this.writeIdx = 0;
        }
      }
    }
    return true; // keep this processor alive across render quanta
  }
}

registerProcessor('vad-processor', VadProcessor);
