/**
 * Microphone audio -> 16 kHz mono PCM16, on the audio thread.
 *
 * AssemblyAI's streaming API wants raw signed 16-bit little-endian samples at a
 * rate it was told about up front. Browsers do not produce that: an
 * `AudioContext` runs at whatever the hardware likes — 44100 or 48000 almost
 * always, 16000 essentially never — and hands out 32-bit floats. Something has
 * to convert, and where it converts matters.
 *
 * ## Why a worklet and not a ScriptProcessorNode
 *
 * `ScriptProcessorNode` is deprecated, and deprecated is the least of it: it
 * runs its callback on the main thread, so every React render, every layout,
 * every garbage collection during a meeting competes with the code turning
 * audio into packets. The symptom is not a crash. It is dropped buffers, which
 * reach the provider as silence, which come back as a transcript missing words
 * nobody can find the reason for. An `AudioWorklet` runs on the audio rendering
 * thread, where nothing the page does can starve it.
 *
 * ## Why the resampling is not just "take every third sample"
 *
 * Dropping samples to get from 48 kHz to 16 kHz aliases everything above 8 kHz
 * back down into the speech band as noise. Averaging each output sample over
 * the input samples it spans is a crude box filter, but it is a low-pass filter,
 * and it costs a multiply-add per sample — which is the budget available on the
 * audio thread. It is audibly and measurably better than decimation and it is
 * not as good as a windowed sinc; that trade is deliberate and is recorded here
 * so nobody has to re-derive it.
 *
 * ## The recording is not touched
 *
 * This taps the same `MediaStream` the recorder is recording and converts a
 * copy. The archived file stays whatever the `MediaRecorder` produced — Opus at
 * full rate — because the final transcript is made from that file, and
 * degrading it to suit a live preview would trade the accurate transcript for
 * the provisional one.
 */

const TARGET_SAMPLE_RATE = 16000;

/**
 * How much audio to send at once, in samples at the target rate.
 *
 * 800 samples is 50 ms. Small enough that the first words appear promptly,
 * large enough that a meeting is not thousands of websocket frames a minute.
 * The provider's own guidance is 50 ms; this is that number, in the only unit
 * this file can count in.
 */
const FRAME_SAMPLES = 800;

class PcmDownsampler extends AudioWorkletProcessor {
  constructor() {
    super();
    /** Output samples waiting to fill a frame. */
    this._pending = new Float32Array(FRAME_SAMPLES);
    this._pendingCount = 0;
    /**
     * Where the next output sample falls between input samples.
     *
     * Carried across `process` calls, and the whole reason this is a field
     * rather than a local. A resampler that restarts its phase every 128-sample
     * render quantum accumulates a fraction of a sample of error per quantum,
     * which over an hour is a drift measured in seconds — and the timestamps
     * this feeds are the ones the transcript is laid out on.
     */
    this._offset = 0;
    this._muted = false;

    this.port.onmessage = (event) => {
      // Pause. The recorder excludes paused audio from the file, and streaming
      // it anyway would put words into the transcript for the exact stretch the
      // user stopped it from being recorded.
      if (event.data && typeof event.data.muted === "boolean") {
        this._muted = event.data.muted;
      }
    };
  }

  process(inputs) {
    const channels = inputs[0];
    if (!channels || channels.length === 0 || !channels[0]) {
      // No input connected yet. Returning true keeps the node alive; false
      // would let the browser garbage-collect it mid-meeting.
      return true;
    }
    if (this._muted) return true;

    const mono = this._toMono(channels);
    const ratio = sampleRate / TARGET_SAMPLE_RATE;

    // Box-filter resample: each output sample is the mean of the input span it
    // covers. See the note at the top for why this is not decimation.
    let offset = this._offset;
    while (offset < mono.length) {
      const start = Math.floor(offset);
      const end = Math.min(mono.length, Math.floor(offset + ratio));
      let sum = 0;
      let count = 0;
      for (let i = start; i < end; i += 1) {
        sum += mono[i];
        count += 1;
      }
      // A span can be empty when the ratio is below 1 (a context already at or
      // under 16 kHz). Falling back to the nearest sample is right there: there
      // is nothing to average.
      this._push(count > 0 ? sum / count : mono[Math.min(start, mono.length - 1)]);
      offset += ratio;
    }
    // Keep the fractional remainder, not zero.
    this._offset = offset - mono.length;

    return true;
  }

  /**
   * Sum the channels rather than take the first.
   *
   * A browser that hands back a stereo microphone stream may have the voice on
   * one channel only; taking channel 0 would transcribe silence and look like a
   * broken microphone.
   */
  _toMono(channels) {
    if (channels.length === 1) return channels[0];
    const out = new Float32Array(channels[0].length);
    for (let c = 0; c < channels.length; c += 1) {
      const channel = channels[c];
      for (let i = 0; i < out.length; i += 1) out[i] += channel[i];
    }
    for (let i = 0; i < out.length; i += 1) out[i] /= channels.length;
    return out;
  }

  _push(sample) {
    this._pending[this._pendingCount] = sample;
    this._pendingCount += 1;
    if (this._pendingCount < FRAME_SAMPLES) return;

    const frame = new Int16Array(FRAME_SAMPLES);
    for (let i = 0; i < FRAME_SAMPLES; i += 1) {
      // Clamp before scaling. A float outside [-1, 1] — which a summed stereo
      // stream or an aggressive gain stage will produce — wraps around when
      // truncated into an Int16, turning a loud vowel into a burst of noise
      // that reads to a speech model as a different word entirely.
      const clamped = Math.max(-1, Math.min(1, this._pending[i]));
      frame[i] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
    }
    // Transferred, not copied: the buffer leaves this thread and is not touched
    // again here.
    this.port.postMessage(frame.buffer, [frame.buffer]);
    this._pendingCount = 0;
  }
}

registerProcessor("pcm-downsampler", PcmDownsampler);
