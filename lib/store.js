// Biblioteca y ajustes en la carpeta de datos de la app. La clave de API se cifra con safeStorage.
const fs = require('fs');
const path = require('path');

const DEFAULTS = {
  uiLang: null, // 'es' | 'en' — null hasta que se elige en la pantalla de inicio
  askLang: true, // preguntar el idioma al abrir
  review: true, // revisión doble de la traducción
  provider: 'groq',
  apiKey: '',
  translator: 'provider', // 'provider' | 'ollama'
  ollamaUrl: 'http://localhost:11434',
  ollamaModel: 'qwen2.5:7b',
  sttModel: '',
  chatModel: '',
  target: 'es',
  view: 'both', // 'original' | 'translated' | 'both'
  // General
  autoplay: true,
  clickSeek: true,
  followDelay: 5,
  // Apariencia
  theme: 'vino', // 'vino' | 'noche' | 'papel'
  accent: 'mantequilla', // 'mantequilla' | 'rosa' | 'mandarina' | 'menta' | 'cielo'
  lyricSize: 'm', // 's' | 'm' | 'l' | 'xl'
  lyricAlign: 'left', // 'left' | 'center'
  trStyle: 'serif', // 'serif' | 'sans'
  lineBar: true,
  motion: 'full', // 'full' | 'reduced'
  // Modo en vivo
  liveChunk: 'balanced', // 'fast' | 'balanced' | 'precise'
  // Subtítulos flotantes
  overlaySize: 34,
  overlayLocked: false,
  overlayView: 'follow', // 'follow' | 'original' | 'translated' | 'both'
  overlayBg: 78, // opacidad del fondo, 0–100
  overlayColor: 'white', // 'white' | 'yellow' | 'accent'
  overlayPos: 'bottom', // 'bottom' | 'top'
  overlayShortcut: true,
};

class Store {
  constructor(dir, safeStorage) {
    this.dir = dir;
    this.safe = safeStorage;
    fs.mkdirSync(dir, { recursive: true });
    this.libFile = path.join(dir, 'biblioteca.json');
    this.setFile = path.join(dir, 'ajustes.json');
  }

  _read(file, fallback) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
  }

  _write(file, data) {
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, file);
  }

  getSettings() {
    const s = { ...DEFAULTS, ...this._read(this.setFile, {}) };
    if (s.apiKeyEnc) {
      try {
        s.apiKey = this.safe && this.safe.isEncryptionAvailable()
          ? this.safe.decryptString(Buffer.from(s.apiKeyEnc, 'base64'))
          : Buffer.from(s.apiKeyEnc, 'base64').toString('utf8');
      } catch { s.apiKey = ''; }
    }
    delete s.apiKeyEnc;
    return s;
  }

  setSettings(patch) {
    const cur = this.getSettings();
    const next = { ...cur, ...patch };
    const disk = { ...next };
    delete disk.apiKey;
    if (next.apiKey) {
      disk.apiKeyEnc = this.safe && this.safe.isEncryptionAvailable()
        ? this.safe.encryptString(next.apiKey).toString('base64')
        : Buffer.from(next.apiKey, 'utf8').toString('base64');
    }
    this._write(this.setFile, disk);
    return next;
  }

  /** Vuelve a los valores de fábrica conservando la clave y el idioma. */
  reset() {
    const s = this.getSettings();
    return this.setSettings({ ...DEFAULTS, apiKey: s.apiKey, uiLang: s.uiLang, askLang: s.askLang });
  }

  clearLibrary() { this._write(this.libFile, []); }

  /** Lo que el renderer puede ver: sin la clave, solo si existe. */
  publicSettings() {
    const s = this.getSettings();
    const hasKey = Boolean(s.apiKey);
    delete s.apiKey;
    return { ...s, hasKey };
  }

  list() {
    return this._read(this.libFile, []).sort((a, b) => (b.openedAt || 0) - (a.openedAt || 0));
  }

  get(id) { return this.list().find((x) => x.id === id) || null; }

  save(item) {
    const all = this._read(this.libFile, []);
    const i = all.findIndex((x) => x.id === item.id);
    if (i >= 0) all[i] = { ...all[i], ...item }; else all.push(item);
    this._write(this.libFile, all);
    return item;
  }

  remove(id) {
    this._write(this.libFile, this._read(this.libFile, []).filter((x) => x.id !== id));
  }
}

module.exports = { Store, DEFAULTS };
