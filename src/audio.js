// Utilidades de audio en el navegador: decodificar, onda, WAV a 16 kHz y captura del audio del sistema.
(function () {
  const RATE = 16000;

  async function decode(arrayBuffer) {
    const ctx = new AudioContext();
    try {
      return await ctx.decodeAudioData(arrayBuffer);
    } finally {
      ctx.close();
    }
  }

  /** Picos normalizados (0..1) para dibujar la onda. */
  function peaks(buffer, buckets = 900) {
    const ch = buffer.numberOfChannels;
    const len = buffer.length;
    const size = Math.max(1, Math.floor(len / buckets));
    const data = [];
    for (let c = 0; c < ch; c++) data.push(buffer.getChannelData(c));
    const out = new Float32Array(buckets);
    let max = 0;
    for (let b = 0; b < buckets; b++) {
      let sum = 0;
      const start = b * size;
      const step = Math.max(1, Math.floor(size / 64)); // muestreo para que vaya rápido en archivos largos
      let n = 0;
      for (let i = start; i < start + size && i < len; i += step) {
        let v = 0;
        for (let c = 0; c < ch; c++) v += Math.abs(data[c][i]);
        sum += v / ch; n++;
      }
      out[b] = n ? sum / n : 0;
      if (out[b] > max) max = out[b];
    }
    if (max > 0) for (let b = 0; b < buckets; b++) out[b] = Math.pow(out[b] / max, 0.8);
    return out;
  }

  function encodeWAV(samples, rate = RATE) {
    const buf = new ArrayBuffer(44 + samples.length * 2);
    const v = new DataView(buf);
    const w = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
    w(0, 'RIFF'); v.setUint32(4, 36 + samples.length * 2, true); w(8, 'WAVE');
    w(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
    v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
    w(36, 'data'); v.setUint32(40, samples.length * 2, true);
    let o = 44;
    for (let i = 0; i < samples.length; i++, o += 2) {
      const s = Math.max(-1, Math.min(1, samples[i]));
      v.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    }
    return buf;
  }

  /**
   * Trocea el audio en WAV mono de 16 kHz (≈19 MB por cada 10 min, bajo el límite de 25 MB de Whisper).
   * Corta en el punto más silencioso cerca del final de cada trozo para no partir palabras.
   */
  async function* wavChunks(buffer, chunkSec = 540) {
    const total = buffer.duration;
    let start = 0;
    while (start < total - 0.5) {
      let len = Math.min(chunkSec, total - start);
      const ctx = new OfflineAudioContext(1, Math.ceil(len * RATE), RATE);
      const src = ctx.createBufferSource();
      src.buffer = buffer;
      src.connect(ctx.destination);
      src.start(0, start, len);
      const rendered = await ctx.startRendering();
      let samples = rendered.getChannelData(0);
      if (start + len < total - 1) {
        const cut = quietestPoint(samples, samples.length - RATE * 20, samples.length);
        samples = samples.subarray(0, cut);
        len = cut / RATE;
      }
      yield { wav: encodeWAV(samples), offset: start, duration: len };
      start += len;
    }
  }

  function quietestPoint(s, from, to) {
    const win = RATE / 10;
    let best = to, bestE = Infinity;
    for (let i = Math.max(0, from); i + win < to; i += win / 2) {
      let e = 0;
      for (let k = i; k < i + win; k += 4) e += s[k] * s[k];
      if (e < bestE) { bestE = e; best = i + win / 2; }
    }
    return Math.floor(best);
  }

  /**
   * Captura el audio que suena en el PC (loopback de Windows) y entrega frases en WAV.
   * onChunk({ wav, rms, duration }), onLevel(0..1)
   */
  class SystemCapture {
    constructor({ onChunk, onLevel, onEnd, minSec = 3.5, maxSec = 9 }) {
      Object.assign(this, { onChunk, onLevel, onEnd, minSec, maxSec });
      this.buf = [];
      this.len = 0;
      this.quietRun = 0;
    }

    async start() {
      this.stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
      this.stream.getVideoTracks().forEach((t) => t.stop());
      const tracks = this.stream.getAudioTracks();
      if (!tracks.length) throw Object.assign(new Error('no audio track'), { code: 'noAudio' });
      tracks[0].addEventListener('ended', () => this.stop());
      this.ctx = new AudioContext({ sampleRate: RATE });
      const src = this.ctx.createMediaStreamSource(new MediaStream(tracks));
      this.proc = this.ctx.createScriptProcessor(4096, 1, 1);
      const mute = this.ctx.createGain();
      mute.gain.value = 0;
      src.connect(this.proc);
      this.proc.connect(mute);
      mute.connect(this.ctx.destination);
      this.proc.onaudioprocess = (e) => this._push(e.inputBuffer.getChannelData(0));
    }

    _push(frame) {
      const copy = new Float32Array(frame);
      let e = 0;
      for (let i = 0; i < copy.length; i++) e += copy[i] * copy[i];
      const rms = Math.sqrt(e / copy.length);
      this.onLevel && this.onLevel(Math.min(1, rms * 6));
      this.buf.push(copy);
      this.len += copy.length;
      this.quietRun = rms < 0.01 ? this.quietRun + copy.length : 0;
      const sec = this.len / RATE;
      // Corta al encontrar una pausa tras minSec, o a la fuerza a los maxSec.
      if ((sec >= this.minSec && this.quietRun >= RATE * 0.35) || sec >= this.maxSec) this._flush();
    }

    _flush() {
      if (!this.len) return;
      const all = new Float32Array(this.len);
      let o = 0, e = 0;
      for (const b of this.buf) { all.set(b, o); o += b.length; }
      for (let i = 0; i < all.length; i += 2) e += all[i] * all[i];
      const rms = Math.sqrt(e / (all.length / 2));
      const duration = this.len / RATE;
      this.buf = []; this.len = 0; this.quietRun = 0;
      if (rms < 0.006) return; // silencio: Whisper se inventaría frases
      this.onChunk && this.onChunk({ wav: encodeWAV(all), rms, duration });
    }

    stop() {
      if (this.stopped) return;
      this.stopped = true;
      try { this._flush(); } catch { /* nada que enviar */ }
      if (this.proc) this.proc.onaudioprocess = null;
      this.stream && this.stream.getTracks().forEach((t) => t.stop());
      this.ctx && this.ctx.close();
      this.onEnd && this.onEnd();
    }
  }

  window.VersoAudio = { decode, peaks, wavChunks, encodeWAV, SystemCapture, RATE };
})();
