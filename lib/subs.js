// Exportar subtítulos y letras: SRT y LRC.

function srtTime(s) {
  const ms = Math.max(0, Math.round(s * 1000));
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const sec = Math.floor((ms % 60000) / 1000);
  const r = ms % 1000;
  return `${pad(h)}:${pad(m)}:${pad(sec)},${String(r).padStart(3, '0')}`;
}

function lrcTime(s) {
  const cs = Math.max(0, Math.round(s * 100));
  const m = Math.floor(cs / 6000);
  const sec = Math.floor((cs % 6000) / 100);
  return `[${pad(m)}:${pad(sec)}.${pad(cs % 100)}]`;
}

function pad(n) { return String(n).padStart(2, '0'); }

function pick(line, mode) {
  if (mode === 'original') return line.text;
  if (mode === 'translated') return line.tr || line.text;
  return line.tr && line.tr !== line.text ? `${line.text}\n${line.tr}` : line.text;
}

/** mode: 'original' | 'translated' | 'both'. offset en segundos (ajuste de sincronía). */
function toSRT(lines, mode = 'both', offset = 0) {
  return lines
    .filter((l) => l.t != null)
    .map((l, i) => `${i + 1}\n${srtTime(l.t + offset)} --> ${srtTime((l.end ?? l.t + 4) + offset)}\n${pick(l, mode)}\n`)
    .join('\n');
}

function toLRC(lines, mode = 'original', offset = 0, meta = {}) {
  const head = [];
  if (meta.title) head.push(`[ti:${meta.title}]`);
  if (meta.artist) head.push(`[ar:${meta.artist}]`);
  head.push('[by:Verso]');
  const body = lines.map((l) => {
    const text = pick(l, mode).replace(/\n/g, ' / ');
    return l.t == null ? text : `${lrcTime(l.t + offset)}${text}`;
  });
  return head.concat(body).join('\n') + '\n';
}

module.exports = { toSRT, toLRC, srtTime, lrcTime };
