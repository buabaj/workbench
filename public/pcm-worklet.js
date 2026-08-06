/**
 * Captures mono PCM and posts it to the main thread as little-endian i16.
 *
 * Served as a same-origin file rather than a blob: URL because the production
 * CSP is `script-src 'self'` — a blob worklet would be blocked.
 */
class PcmCapture extends AudioWorkletProcessor {
  process(inputs) {
    const channel = inputs[0]?.[0];
    if (!channel) return true;
    const out = new Int16Array(channel.length);
    for (let i = 0; i < channel.length; i++) {
      const s = Math.max(-1, Math.min(1, channel[i]));
      out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    // Transferred, not copied.
    this.port.postMessage(out.buffer, [out.buffer]);
    return true;
  }
}

registerProcessor("pcm-capture", PcmCapture);
