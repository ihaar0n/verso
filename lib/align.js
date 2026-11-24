// Alinea la letra exacta (texto fiable, sin tiempos) con las palabras que Whisper oyó (con tiempos).
// Resultado: la letra oficial, palabra por palabra, con los tiempos reales del audio.

function norm(w) {
  return String(w || '')
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, '');
}

function tokenize(text) {
  return String(text || '').split(/[\s\-–—/]+/).map(norm).filter(Boolean);
}

function lev(a, b) {
  if (a === b) return 0;
  const m = a.length, n = b.length;
  if (!m) return n;
  if (!n) return m;
  let prev = new Array(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[n];
}

function similar(a, b) {
  if (a === b) return 3;
  const L = Math.max(a.length, b.length);
  if (L >= 3 && (a.startsWith(b) || b.startsWith(a)) && Math.min(a.length, b.length) >= 3) return 1;
  if (L >= 4 && 1 - lev(a, b) / L >= 0.7) return 1;
  return -2;
}

/**
 * lines: [{ text }]   words: [{ word, start, end }]
 * Devuelve { lines: [{t, end, text}], quality } — quality es la fracción de palabras de la letra encontradas en el audio.
 */
function alignLyrics(lines, words) {
  const toks = [];
  lines.forEach((l, li) => tokenize(l.text).forEach((tk) => toks.push({ tk, li })));
  const ws = words.map((w) => ({ tk: norm(w.word), start: w.start, end: w.end })).filter((w) => w.tk);
  const n = toks.length, m = ws.length;
  if (!n || !m) return { lines: [], quality: 0 };

  // Alineamiento global (Needleman-Wunsch) con huecos baratos: Whisper se salta o inventa palabras.
  const GAP = -1;
  const W = m + 1;
  const score = new Float32Array((n + 1) * W);
  const dir = new Uint8Array((n + 1) * W); // 1 diagonal, 2 arriba (token sin palabra), 3 izquierda (palabra sin token)
  for (let i = 1; i <= n; i++) { score[i * W] = i * GAP; dir[i * W] = 2; }
  for (let j = 1; j <= m; j++) { score[j] = j * GAP * 0.5; dir[j] = 3; }
  for (let i = 1; i <= n; i++) {
    const a = toks[i - 1].tk;
    for (let j = 1; j <= m; j++) {
      const d = score[(i - 1) * W + j - 1] + similar(a, ws[j - 1].tk);
      const u = score[(i - 1) * W + j] + GAP;
      const l = score[i * W + j - 1] + GAP * 0.5;
      let best = d, k = 1;
      if (u > best) { best = u; k = 2; }
      if (l > best) { best = l; k = 3; }
      score[i * W + j] = best;
      dir[i * W + j] = k;
    }
  }

  const match = new Array(n).fill(-1);
  let i = n, j = m;
  while (i > 0 && j > 0) {
    const k = dir[i * W + j];
    if (k === 1) {
      if (similar(toks[i - 1].tk, ws[j - 1].tk) > 0) match[i - 1] = j - 1;
      i--; j--;
    } else if (k === 2) i--; else j--;
  }

  const matched = match.filter((x) => x >= 0).length;
  const quality = matched / n;

  // Tiempo de cada línea: primera y última palabra encontradas.
  const out = lines.map((l) => ({ text: l.text, t: null, end: null }));
  toks.forEach((tk, k) => {
    if (match[k] < 0) return;
    const w = ws[match[k]];
    const o = out[tk.li];
    if (o.t == null) o.t = w.start;
    o.end = w.end;
  });

  // Líneas sin coincidencias: se reparten entre sus vecinas.
  for (let a = 0; a < out.length; a++) {
    if (out[a].t != null) continue;
    let b = a;
    while (b < out.length && out[b].t == null) b++;
    const from = a > 0 ? out[a - 1].end : Math.max(0, (out[b]?.t ?? ws[0].start) - 2 * (b - a));
    const to = b < out.length ? out[b].t : ws[m - 1].end;
    const step = Math.max(0.4, (to - from) / (b - a));
    for (let k = a; k < b; k++) {
      out[k].t = from + step * (k - a);
      out[k].end = from + step * (k - a + 1);
    }
    a = b - 1;
  }

  // Orden y límites coherentes.
  for (let k = 0; k < out.length; k++) {
    if (k > 0 && out[k].t < out[k - 1].t) out[k].t = out[k - 1].t + 0.05;
    const next = out[k + 1]?.t;
    if (next != null && out[k].end > next) out[k].end = next;
    if (out[k].end <= out[k].t) out[k].end = out[k].t + 1;
    out[k].t = Math.round(out[k].t * 100) / 100;
    out[k].end = Math.round(out[k].end * 100) / 100;
  }
  return { lines: out, quality };
}

module.exports = { alignLyrics, tokenize, norm };
