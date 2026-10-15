// AudioWorklet for conversation mode: batches 128-sample render quanta into ~20 ms mono frames and posts
// them to the page, where web/conversation-core.js runs the VAD. Loaded with audioWorklet.addModule().
class VadTap extends AudioWorkletProcessor {
  constructor() {
    super()
    this.size = Math.max(128, Math.round(sampleRate * 0.02))
    this.buffer = new Float32Array(this.size)
    this.filled = 0
  }

  process(inputs) {
    const channel = inputs[0]?.[0]
    if (channel) {
      for (let i = 0; i < channel.length; i++) {
        this.buffer[this.filled++] = channel[i]
        if (this.filled === this.size) {
          this.port.postMessage(this.buffer, [this.buffer.buffer])
          this.buffer = new Float32Array(this.size)
          this.filled = 0
        }
      }
    }
    return true
  }
}

registerProcessor("vad-tap", VadTap)
