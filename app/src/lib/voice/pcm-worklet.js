/** 40ms PCM16 frames. The AudioContext resamples microphone input to 24kHz. */
class VoiceCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.frame = new ArrayBuffer(1920);
    this.view = new DataView(this.frame);
    this.offset = 0;
  }
  process(inputs) {
    const samples = inputs[0]?.[0];
    if (!samples) return true;
    for (const sample of samples) {
      const clamped = Math.max(-1, Math.min(1, sample));
      this.view.setInt16(
        this.offset,
        clamped * (clamped < 0 ? 32768 : 32767),
        true,
      );
      this.offset += 2;
      if (this.offset === this.frame.byteLength) {
        this.port.postMessage(this.frame, [this.frame]);
        this.frame = new ArrayBuffer(1920);
        this.view = new DataView(this.frame);
        this.offset = 0;
      }
    }
    return true;
  }
}
registerProcessor("voice-capture", VoiceCapture);
