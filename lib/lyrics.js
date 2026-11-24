// Letras: lectura de LRC y búsqueda en LRCLIB (gratis, sin clave).
const LRCLIB = 'https://lrclib.net/api';
const UA = 'Verso/1.0 (app de escritorio de ax¡d)';

/** Convierte texto LRC en [{t, end, text}] ordenado. Ignora etiquetas [ar:], [ti:], etc. */
function parseLRC(lrc, duration = null) {
  const out = [];
  const stamp = /\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g;
  for (const raw of String(lrc || '').split(/\r?\n/)) {
    const stamps = [];
    let m;
    stamp.lastIndex = 0;
    while ((m = stamp.exec(raw))) {
      const frac = m[3] ? Number(m[3]) / Math.pow(10, m[3].length) : 0;
      stamps.push(Number(m[1]) * 60 + Number(m[2]) + frac);
    }
    if (!stamps.length) continue;
    const text = raw.replace(stamp, '').trim();
    for (const t of stamps) out.push({ t, text });
  }
  out.sort((a, b) => a.t - b.t);
  // Las líneas vacías marcan silencios: sirven de final para la anterior y luego se quitan.
  const lines = [];
  for (let i = 0; i < out.length; i++) {
    const next = out[i + 1];
    if (!out[i].text) continue;
    const end = next ? next.t : (duration ? Math.max(out[i].t + 1, duration) : out[i].t + 5);
    lines.push({ t: round(out[i].t), end: round(Math.min(end, out[i].t + 12)), text: out[i].text });
  }
  return lines;
}

function plainToLines(plain) {
  return String(plain || '')
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((text) => ({ t: null, end: null, text }));
}

function round(n) { return Math.round(n * 100) / 100; }

function normalize(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/\(.*?\)|\[.*?\]/g, ' ')
    .replace(/\b(feat|ft|official|video|lyrics?|audio|letra|hd|4k|remaster(ed)?)\b\.?/g, ' ')
    .replace(/[^a-z0-9À-￿]+/g, ' ')
    .trim();
}

/** Puntúa un resultado de LRCLIB frente a lo que sabemos del archivo. */
function scoreCandidate(c, query) {
  const { title, artist, duration } = query;
  let s = 0;
  if (c.syncedLyrics) s += 40;
  else if (c.plainLyrics) s += 10;
  if (c.instrumental) s -= 50;
  const nt = normalize(title), nc = normalize(c.trackName);
  if (nt && nc === nt) s += 30; else if (nt && (nc.includes(nt) || nt.includes(nc))) s += 15;
  const na = normalize(artist), nca = normalize(c.artistName);
  if (na && nca && (nca.includes(na) || na.includes(nca))) s += 20;
  // Un fragmento (TikTok, clip) dura menos que la canción: la duración no sirve para comparar.
  if (duration && c.duration && !query.clip) {
    const d = Math.abs(c.duration - duration);
    s += d <= 2 ? 25 : d <= 5 ? 12 : d <= 15 ? 0 : -25;
  }
  return s;
}

async function getJSON(url, signal) {
  const res = await fetch(url, { headers: { 'User-Agent': UA, 'Lrclib-Client': UA }, signal });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`LRCLIB respondió ${res.status}`);
  return res.json();
}

/**
 * Busca la letra. Devuelve { lines, synced, match } o null si no hay nada fiable.
 * query: { title, artist, duration, q }
 */
async function findLyrics(query, { signal } = {}) {
  const tries = [];
  if (query.title && query.artist) {
    tries.push(`${LRCLIB}/search?track_name=${enc(query.title)}&artist_name=${enc(query.artist)}`);
  }
  const q = query.q || [query.artist, query.title].filter(Boolean).join(' ');
  if (q) tries.push(`${LRCLIB}/search?q=${enc(q)}`);

  let best = null;
  for (const url of tries) {
    const list = await getJSON(url, signal);
    if (!Array.isArray(list)) continue;
    for (const c of list) {
      const score = scoreCandidate(c, query);
      if (!best || score > best.score) best = { c, score };
    }
    if (best && best.score >= 70) break;
  }
  if (!best || best.score < 35) return null;
  const c = best.c;
  const synced = Boolean(c.syncedLyrics);
  const lines = synced ? parseLRC(c.syncedLyrics, query.duration) : plainToLines(c.plainLyrics);
  if (!lines.length) return null;
  return {
    lines,
    synced,
    match: { id: c.id, title: c.trackName, artist: c.artistName, album: c.albumName, duration: c.duration, score: best.score },
  };
}

function enc(s) { return encodeURIComponent(String(s).trim()); }

module.exports = { parseLRC, plainToLines, findLyrics, scoreCandidate, normalize };
