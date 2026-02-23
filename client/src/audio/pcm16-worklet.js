/* AudioWorkletProcessor:
 * - receives Float32 audio from the browser audio graph (often 48k)
 * - resamples to 16k
 * - converts to Int16 PCM
 * - posts ArrayBuffer chunks to main thread (transferable)
 *
 * This matches the approach you used in your earlier Deepgram demo.
 */
class PCM16Worklet extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const target = options?.processorOptions?.targetSampleRate || 16000;
    this.targetSampleRate = target;

    this.inputSampleRate = sampleRate;
    this.ratio = this.inputSampleRate / this.targetSampleRate;

    this.prev = 0;
    this.pos = 0;
    this.inited = false;
  }

  /*
  *DESC: Processes incoming audio data, resamples it to the target sample rate, converts it to 16-bit PCM format, and sends it to the main thread as an ArrayBuffer.
  *INPUT: An array of audio input buffers (inputs) from the browser's audio graph.
  *OUTPUT: Posts an ArrayBuffer containing the resampled and converted audio data to the main thread.
  */

  process(inputs) {
    const input = inputs?.[0]?.[0];
    if (!input || input.length === 0) return true;

    if (!this.inited) {
      this.prev = input[0];
      this.inited = true;
    }

    const dataLen = input.length + 1;
    const maxOut = Math.floor((dataLen - 1 - this.pos) / this.ratio);
    if (maxOut <= 0) {
      this.pos = this.pos - input.length;
      this.prev = input[input.length - 1];
      return true;
    }

    const out = new Int16Array(maxOut);
    let pos = this.pos;

    for (let i = 0; i < maxOut; i++) {
      const idx = Math.floor(pos);
      const frac = pos - idx;

      const s0 = idx === 0 ? this.prev : input[idx - 1];
      const s1 = idx === 0 ? input[0] : input[idx];

      let sample = s0 + (s1 - s0) * frac;
      sample = Math.max(-1, Math.min(1, sample));
      out[i] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;

      pos += this.ratio;
    }

    this.pos = pos - input.length;
    this.prev = input[input.length - 1];

    this.port.postMessage(out.buffer, [out.buffer]);
    return true;
  }
}

registerProcessor("pcm16-worklet", PCM16Worklet);
