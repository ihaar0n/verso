// Registro de errores e informe para soporte. Nunca incluye la clave de API ni rutas personales completas.
const fs = require('fs');
const os = require('os');
const path = require('path');

const MAX_LOG = 1024 * 1024; // 1 MB; al pasarlo se guarda el anterior como .old

class Logger {
  constructor(dir) {
    this.dir = path.join(dir, 'registros');
    fs.mkdirSync(this.dir, { recursive: true });
    this.file = path.join(this.dir, 'verso.log');
    this.recent = []; // últimos errores en memoria para el informe
  }

  write(level, where, message, extra) {
    const line = `${new Date().toISOString()} [${level}] ${where}: ${redact(String(message))}` +
      (extra ? ` | ${redact(typeof extra === 'string' ? extra : JSON.stringify(extra))}` : '');
    try {
      if (fs.existsSync(this.file) && fs.statSync(this.file).size > MAX_LOG) {
        fs.renameSync(this.file, this.file + '.old');
      }
      fs.appendFileSync(this.file, line + '\n');
    } catch { /* si no se puede escribir el registro, la app sigue */ }
    if (level === 'error') {
      this.recent.push(line);
      if (this.recent.length > 30) this.recent.shift();
    }
    return line;
  }

  error(where, message, extra) { return this.write('error', where, message, extra); }
  info(where, message, extra) { return this.write('info', where, message, extra); }

  tail(n = 40) {
    try {
      const lines = fs.readFileSync(this.file, 'utf8').trim().split('\n');
      return lines.slice(-n);
    } catch { return this.recent.slice(-n); }
  }
}

/** Quita claves, tokens y la carpeta del usuario de cualquier texto. */
function redact(text) {
  const home = os.homedir();
  let s = String(text);
  if (home) s = s.split(home).join('~');
  return s
    .replace(/\b(gsk|sk|sk-proj|sk-ant)[-_][A-Za-z0-9_\-]{8,}/g, '[clave oculta]')
    .replace(/Bearer\s+[A-Za-z0-9._\-]+/gi, 'Bearer [oculto]')
    .replace(/("?(api_?key|apiKey|authorization|token)"?\s*[:=]\s*)"[^"]*"/gi, '$1"[oculto]"');
}

/** Informe en texto plano para pegar en el ticket. */
function buildReport({ version, settings, context, note, logLines, lang = 'es' }) {
  const L = lang === 'en'
    ? { title: 'Verso problem report', what: 'What happened', user: 'What the user was doing', sys: 'System', cfg: 'Settings', log: 'Recent log' }
    : { title: 'Informe de problema de Verso', what: 'Qué ha pasado', user: 'Qué estaba haciendo', sys: 'Sistema', cfg: 'Ajustes', log: 'Registro reciente' };
  const safeSettings = settings ? {
    uiLang: settings.uiLang, target: settings.target, provider: settings.provider, translator: settings.translator,
    review: settings.review, hasKey: Boolean(settings.apiKey || settings.hasKey), sttModel: settings.sttModel || '(default)',
    chatModel: settings.chatModel || '(default)', liveChunk: settings.liveChunk, theme: settings.theme,
  } : {};
  const head = [
    `**${L.title}**`,
    '```',
    `Verso ${version}`,
    `${L.sys}: ${os.type()} ${os.release()} (${os.arch()}), Electron ${process.versions.electron || '-'}`,
    new Date().toISOString(),
    '',
    `${L.what}: ${redact(context?.message || '-')}`,
    context?.where ? `> ${redact(context.where)}` : null,
    context?.song ? `> ${redact(context.song)}` : null,
    note ? `${L.user}: ${redact(note)}` : null,
    '',
    `${L.cfg}: ${JSON.stringify(safeSettings)}`,
  ].filter((x) => x !== null).join('\n');
  // Discord admite 2000 caracteres por mensaje: se añaden las líneas de registro más recientes que quepan.
  const tail = '\n```';
  const lines = (logLines || []).map(redact);
  const picked = [];
  let size = head.length + tail.length + L.log.length + 3;
  for (let i = lines.length - 1; i >= 0 && picked.length < 25; i--) {
    const ln = lines[i].length > 300 ? lines[i].slice(0, 300) + '…' : lines[i];
    if (size + ln.length + 1 > 1990) break;
    picked.unshift(ln);
    size += ln.length + 1;
  }
  const body = picked.length ? `\n\n${L.log}:\n${picked.join('\n')}` : '';
  const text = head + body + tail;
  return text.length > 2000 ? text.slice(0, 1995) + tail : text;
}

function isInvite(url) {
  return /^https:\/\/(discord\.gg|discord\.com\/invite|discordapp\.com\/invite)\/[A-Za-z0-9-]+\/?$/.test(String(url || ''));
}

module.exports = { Logger, redact, buildReport, isInvite };
