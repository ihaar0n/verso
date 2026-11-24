// Transcripción (Whisper), pulido, traducción y revisión con Groq, OpenAI u Ollama.
const I18N = require('../src/i18n');

const PROVIDERS = {
  groq: { name: 'Groq', base: 'https://api.groq.com/openai/v1', sttModel: 'whisper-large-v3', chatModel: 'openai/gpt-oss-120b' },
  openai: { name: 'OpenAI', base: 'https://api.openai.com/v1', sttModel: 'whisper-1', chatModel: 'gpt-4.1' },
};

// Nombres en inglés para los prompts (los modelos rinden mejor con instrucciones en inglés).
const LANG_EN = {
  es: 'Spanish (Spain, neutral and natural)', en: 'English', pt: 'Portuguese', fr: 'French', it: 'Italian', de: 'German',
  ja: 'Japanese', ko: 'Korean', zh: 'Simplified Chinese', ru: 'Russian', ar: 'Arabic', tr: 'Turkish', hi: 'Hindi',
};

const NAME_TO_CODE = {
  spanish: 'es', english: 'en', portuguese: 'pt', french: 'fr', italian: 'it', german: 'de',
  japanese: 'ja', korean: 'ko', chinese: 'zh', russian: 'ru', arabic: 'ar', turkish: 'tr', hindi: 'hi',
};

function langCode(l) {
  if (!l) return null;
  const s = String(l).toLowerCase();
  return NAME_TO_CODE[s] || (s.length === 2 ? s : null);
}

// Frases que Whisper se inventa en silencios o música sin voz.
const HALLUCINATIONS = [
  /subt[ií]tulos? (realizados|por) /i, /amara\.org/i, /gracias por ver/i, /thanks? (you )?for watching/i,
  /suscr[ií]bete/i, /subscribe to/i, /^\W*(m[uú]sica|music)\W*$/i, /^[\s.…♪]*$/,
];
const isHallucination = (text) => HALLUCINATIONS.some((r) => r.test(text));

class AIError extends Error {
  constructor(message, kind = 'api') { super(message); this.kind = kind; }
}

function cfg(settings) {
  const p = PROVIDERS[settings.provider] || PROVIDERS.groq;
  return { base: p.base, name: p.name, key: settings.apiKey, sttModel: settings.sttModel || p.sttModel, chatModel: settings.chatModel || p.chatModel };
}

const tr = (settings) => (key, vars) => I18N.t(key, vars, settings.uiLang || 'es');

async function explain(res, who, settings) {
  const t = tr(settings);
  let detail = '';
  try { const j = await res.json(); detail = j.error?.message || j.message || ''; } catch { /* sin cuerpo */ }
  if (res.status === 401) return new AIError(t('err.auth', { who }), 'auth');
  if (res.status === 413) return new AIError(t('err.size', { who }), 'size');
  if (res.status === 429) return new AIError(t('err.rate', { who }), 'rate');
  return new AIError(t('err.status', { who, status: res.status, detail: detail ? `: ${detail}` : '' }));
}

async function withRetry(fn, tries = 3) {
  let last;
  for (let i = 0; i < tries; i++) {
    try { return await fn(); } catch (e) {
      last = e;
      if (e.kind === 'auth' || e.kind === 'size' || e.name === 'AbortError') throw e;
      await new Promise((r) => setTimeout(r, 1200 * (i + 1) * (e.kind === 'rate' ? 4 : 1)));
    }
  }
  throw last;
}

const round = (n) => Math.round(n * 100) / 100;

/**
 * Transcribe un WAV. offset: segundo en el que empieza el fragmento.
 * Devuelve { language, lines: [{t, end, text}], words: [{word, start, end}] }.
 */
async function transcribe(wav, { offset = 0, language, prompt, settings, signal }) {
  const c = cfg(settings);
  if (!c.key) throw new AIError(tr(settings)('err.noKeyTranscribe'), 'auth');
  return withRetry(async () => {
    const form = new FormData();
    form.append('file', new Blob([wav], { type: 'audio/wav' }), 'audio.wav');
    form.append('model', c.sttModel);
    form.append('response_format', 'verbose_json');
    form.append('timestamp_granularities[]', 'segment');
    form.append('timestamp_granularities[]', 'word');
    form.append('temperature', '0');
    if (language) form.append('language', language);
    if (prompt) form.append('prompt', prompt.slice(-220));
    const res = await fetch(`${c.base}/audio/transcriptions`, { method: 'POST', headers: { Authorization: `Bearer ${c.key}` }, body: form, signal });
    if (!res.ok) throw await explain(res, c.name, settings);
    const j = await res.json();
    const segs = Array.isArray(j.segments) ? j.segments : [{ start: 0, end: j.duration || 0, text: j.text || '' }];
    const lines = [];
    const kept = [];
    for (const s of segs) {
      const text = String(s.text || '').trim();
      if (!text || isHallucination(text)) continue;
      if (s.no_speech_prob != null && s.no_speech_prob > 0.8 && (s.avg_logprob ?? 0) < -0.8) continue;
      kept.push([s.start, s.end]);
      lines.push(...splitLong({ t: round(s.start + offset), end: round(s.end + offset), text }));
    }
    // Solo las palabras que caen dentro de segmentos válidos (fuera quedan las alucinaciones).
    const words = (Array.isArray(j.words) ? j.words : [])
      .filter((w) => kept.some(([a, b]) => w.start >= a - 0.3 && w.end <= b + 0.3))
      .map((w) => ({ word: w.word, start: round(w.start + offset), end: round(w.end + offset) }));
    return { language: langCode(j.language), lines, words };
  });
}

/** Parte segmentos largos de Whisper en frases que caben en un subtítulo. */
function splitLong(line, max = 84) {
  if (line.text.length <= max) return [line];
  const parts = line.text.match(/[^.!?¿¡,;]+[.!?,;]*\s*/g) || [line.text];
  const chunks = [];
  let cur = '';
  for (const p of parts) {
    if ((cur + p).length > max && cur) { chunks.push(cur.trim()); cur = ''; }
    cur += p;
  }
  if (cur.trim()) chunks.push(cur.trim());
  const total = chunks.reduce((a, s) => a + s.length, 0);
  const dur = line.end - line.t;
  let t = line.t;
  return chunks.map((text) => {
    const d = dur * (text.length / total);
    const l = { t: round(t), end: round(t + d), text };
    t += d;
    return l;
  });
}

/** Saca el array de textos de la respuesta del modelo. Acepta strings u objetos {id, text}. */
function parseTranslation(content, expected, firstId = null) {
  let data;
  const raw = String(content || '').trim().replace(/^```(?:json)?\s*|\s*```$/g, '');
  try { data = JSON.parse(raw); } catch {
    const m = raw.match(/\{[\s\S]*\}|\[[\s\S]*\]/);
    if (!m) return null;
    try { data = JSON.parse(m[0]); } catch { return null; }
  }
  let arr = Array.isArray(data) ? data : data.lines || data.translations || data.result;
  if (!Array.isArray(arr)) return null;
  if (firstId != null && arr.every((x) => x && typeof x === 'object' && Number.isFinite(Number(x.id)))) {
    const byId = new Map(arr.map((x) => [Number(x.id), x]));
    const ordered = [];
    for (let k = 0; k < expected; k++) {
      const x = byId.get(firstId + k);
      if (!x) return null;
      ordered.push(x);
    }
    arr = ordered;
  }
  arr = arr.map((x) => (typeof x === 'string' ? x : x?.text ?? x?.tr ?? x?.translation ?? '')).map((s) => String(s).trim());
  if (arr.length !== expected || arr.some((s) => !s)) return null;
  return arr;
}

function numbered(texts, from = 1) {
  return texts.map((s, i) => `${from + i}. ${s}`).join('\n');
}

const RULES = (lang) => [
  `Translate into ${lang}.`,
  'Accuracy comes first: keep the exact meaning of every line. Never add, drop or soften ideas. Watch negations, pronouns, gender, number, tense and who is speaking to whom.',
  'Sound natural, the way a native speaker would sing or say it: idioms become the equivalent idiom, slang keeps its register (do not clean up swearing), metaphors keep their image when it still works.',
  'Read the whole song first: lines often continue the previous one, and repeated lines must be translated the same way every time.',
  'Keep names, brands and places. Interjections and vocables (oh, yeah, la la, eh) stay as they are.',
  `A line that is already in ${lang} is returned unchanged.`,
  'One output per input line, same id. Never merge, split or reorder lines.',
].join('\n- ');

function translatePrompt(all, from, slice, target, context) {
  const lang = LANG_EN[target] || target;
  return [
    { role: 'system', content: `You are a professional translator of song lyrics, film dialogue and speech.\n- ${RULES(lang)}\nAnswer ONLY with JSON: {"lines":[{"id":<number>,"text":"<translation>"}]}` },
    {
      role: 'user',
      content:
        (context ? `Source: ${context}\n\n` : '') +
        `Full text, for context:\n${numbered(all)}\n\n` +
        `Translate lines ${from} to ${from + slice.length - 1}:\n` + JSON.stringify({ lines: slice.map((text, i) => ({ id: from + i, text })) }),
    },
  ];
}

function reviewPrompt(all, from, src, draft, target, context) {
  const lang = LANG_EN[target] || target;
  return [
    {
      role: 'system',
      content:
        `You are a senior editor checking translations into ${lang}. For every line compare the source with the draft and fix any error: ` +
        'wrong or lost meaning, mistranslated idioms or slang, false friends, wrong negation, pronoun, gender, number or tense, ' +
        'untranslated words, grammar or spelling mistakes, and phrasing a native speaker would never use. ' +
        'Keep lines that are already correct exactly as they are; do not rewrite for taste. ' +
        'Repeated source lines must end up with the same translation.\n' +
        'Answer ONLY with JSON: {"lines":[{"id":<number>,"text":"<final translation>"}]} with every id.',
    },
    {
      role: 'user',
      content:
        (context ? `Source: ${context}\n\n` : '') +
        `Full original text, for context:\n${numbered(all)}\n\n` +
        'Check these lines:\n' + JSON.stringify({ lines: src.map((s, i) => ({ id: from + i, source: s, draft: draft[i] })) }),
    },
  ];
}

function polishPrompt(all, from, slice, context) {
  return [
    {
      role: 'system',
      content:
        'You fix automatic speech-recognition output. Correct ONLY clear recognition errors: misheard or misspelled words, wrong homophones, ' +
        'words that make no sense in context, missing accents, punctuation and capitalization. ' +
        'Do not translate, do not rephrase, do not censor, do not complete or invent lyrics. When unsure, leave the line as it is.\n' +
        'Answer ONLY with JSON: {"lines":[{"id":<number>,"text":"<line>"}]} with every id.',
    },
    {
      role: 'user',
      content: (context ? `Source: ${context}\n\n` : '') + `Full transcript, for context:\n${numbered(all)}\n\nFix lines:\n` +
        JSON.stringify({ lines: slice.map((text, i) => ({ id: from + i, text })) }),
    },
  ];
}

async function chat(messages, settings, signal, { temperature = 0.2 } = {}) {
  const t = tr(settings);
  if (settings.translator === 'ollama') {
    const base = (settings.ollamaUrl || 'http://localhost:11434').replace(/\/$/, '');
    let res;
    try {
      res = await fetch(`${base}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: settings.ollamaModel || 'qwen2.5:7b', messages, stream: false, format: 'json', options: { temperature, num_ctx: 8192 } }),
        signal,
      });
    } catch (e) {
      if (e.name === 'AbortError') throw e;
      throw new AIError(t('err.ollama'), 'auth');
    }
    if (!res.ok) throw await explain(res, 'Ollama', settings);
    const j = await res.json();
    return j.message?.content || '';
  }
  const c = cfg(settings);
  if (!c.key) throw new AIError(t('err.noKeyTranslate'), 'auth');
  const body = { model: c.chatModel, messages, temperature, response_format: { type: 'json_object' } };
  if (/gpt-oss/.test(c.chatModel)) body.reasoning_effort = 'medium';
  const res = await fetch(`${c.base}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${c.key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) throw await explain(res, c.name, settings);
  const j = await res.json();
  return j.choices?.[0]?.message?.content || '';
}

const BATCH = 40;

/** Ejecuta un prompt por lotes; si un lote vuelve mal, lo reintenta en lotes más pequeños. */
async function runBatched(texts, build, { settings, signal, onProgress, temperature }) {
  const out = new Array(texts.length);
  const doRange = async (from, to, depth = 0) => {
    const content = await withRetry(() => chat(build(from, to), settings, signal, { temperature }));
    const arr = parseTranslation(content, to - from, from + 1);
    if (arr) { arr.forEach((s, k) => { out[from + k] = s; }); return; }
    if (to - from === 1) throw new AIError(tr(settings)('err.format'));
    const mid = from + Math.ceil((to - from) / 2);
    await doRange(from, mid, depth + 1);
    await doRange(mid, to, depth + 1);
  };
  for (let i = 0; i < texts.length; i += BATCH) {
    const to = Math.min(i + BATCH, texts.length);
    await doRange(i, to);
    onProgress && onProgress(to, texts.length);
  }
  return out;
}

/** Traducción de una canción entera con todo el texto como contexto. */
async function translateTexts(texts, { target = 'es', context = '', settings, signal, onProgress }) {
  const res = await runBatched(texts, (from, to) => translatePrompt(texts, from + 1, texts.slice(from, to), target, context),
    { settings, signal, onProgress, temperature: 0.2 });
  return res.map((s, i) => s || texts[i]);
}

/** Segunda pasada: revisa la traducción línea a línea y corrige errores. Devuelve { lines, fixed }. */
async function reviewTranslation(src, draft, { target = 'es', context = '', settings, signal, onProgress }) {
  const res = await runBatched(src, (from, to) => reviewPrompt(src, from + 1, src.slice(from, to), draft.slice(from, to), target, context),
    { settings, signal, onProgress, temperature: 0 });
  let fixed = 0;
  const lines = res.map((s, i) => {
    const v = s || draft[i];
    if (v.trim() !== String(draft[i]).trim()) fixed++;
    return v;
  });
  return { lines, fixed };
}

/** Corrige con cuidado lo que Whisper oyó mal. Descarta cambios demasiado grandes (invención). */
async function polishTranscript(texts, { context = '', settings, signal, onProgress }) {
  const res = await runBatched(texts, (from, to) => polishPrompt(texts, from + 1, texts.slice(from, to), context),
    { settings, signal, onProgress, temperature: 0 });
  return res.map((s, i) => (s && similarity(s, texts[i]) >= 0.55 ? s : texts[i]));
}

function similarity(a, b) {
  const x = a.toLowerCase(), y = b.toLowerCase();
  const L = Math.max(x.length, y.length);
  if (!L) return 1;
  let prev = Array.from({ length: y.length + 1 }, (_, j) => j);
  for (let i = 1; i <= x.length; i++) {
    const cur = [i];
    for (let j = 1; j <= y.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (x[i - 1] === y[j - 1] ? 0 : 1));
    prev = cur;
  }
  return 1 - prev[y.length] / L;
}

/**
 * Adivina qué canción es a partir de lo que se oyó. Las respuestas se comprueban después
 * comparando su letra oficial con el audio, así que un error del modelo no llega a la pantalla.
 */
async function identifySong(heard, { title = '', artist = '', settings, signal }) {
  const messages = [
    {
      role: 'system',
      content:
        'You identify songs from lyrics heard in an audio file. The transcript comes from speech recognition, so it can have errors, ' +
        'and it may be only a short clip of the song (TikTok, Reels, a remix, a sped-up or slowed version). ' +
        'Give up to 3 candidate songs, most likely first, with the official title and main artist as listed on Spotify. ' +
        'Prefer the original song over covers. If you have no idea, return an empty list.\n' +
        'Answer ONLY with JSON: {"songs":[{"title":"...","artist":"..."}]}',
    },
    {
      role: 'user',
      content: (title || artist ? `File name or tags (may be wrong or random): ${[artist, title].filter(Boolean).join(' - ')}\n\n` : '') +
        `Heard lyrics:\n${String(heard).slice(0, 1800)}`,
    },
  ];
  const content = await withRetry(() => chat(messages, settings, signal, { temperature: 0 }));
  let data;
  try { data = JSON.parse(String(content).replace(/^```(?:json)?\s*|\s*```$/g, '')); } catch {
    const m = String(content).match(/\{[\s\S]*\}/);
    try { data = m ? JSON.parse(m[0]) : null; } catch { data = null; }
  }
  const list = Array.isArray(data?.songs) ? data.songs : [];
  return list
    .filter((x) => x && typeof x.title === 'string' && x.title.trim())
    .slice(0, 3)
    .map((x) => ({ title: x.title.trim().slice(0, 120), artist: String(x.artist || '').trim().slice(0, 120) }));
}

async function testConnection(settings) {
  const t = tr(settings);
  if (settings.translator === 'ollama') {
    const base = (settings.ollamaUrl || 'http://localhost:11434').replace(/\/$/, '');
    const res = await fetch(`${base}/api/tags`).catch(() => null);
    if (!res || !res.ok) throw new AIError(t('err.ollamaUrl', { url: base }));
  }
  const c = cfg(settings);
  if (!c.key) {
    if (settings.translator === 'ollama') return true;
    throw new AIError(t('err.noKey'), 'auth');
  }
  const res = await fetch(`${c.base}/models`, { headers: { Authorization: `Bearer ${c.key}` } });
  if (!res.ok) throw await explain(res, c.name, settings);
  return true;
}

module.exports = {
  PROVIDERS, transcribe, translateTexts, reviewTranslation, polishTranscript, identifySong,
  parseTranslation, splitLong, isHallucination, langCode, similarity, testConnection, AIError,
};
