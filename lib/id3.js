// Lectura mínima de etiquetas ID3v2 (título, artista, álbum) sin dependencias,
// y deducción a partir del nombre del archivo cuando no hay etiquetas.
const fs = require('fs');
const path = require('path');

function syncsafe(b, o) {
  return ((b[o] & 0x7f) << 21) | ((b[o + 1] & 0x7f) << 14) | ((b[o + 2] & 0x7f) << 7) | (b[o + 3] & 0x7f);
}

function decodeText(buf) {
  if (!buf.length) return '';
  const enc = buf[0];
  const body = buf.subarray(1);
  let s;
  if (enc === 0) s = body.toString('latin1');
  else if (enc === 3) s = body.toString('utf8');
  else if (enc === 1 || enc === 2) {
    let b = body, le = enc === 1;
    if (b[0] === 0xff && b[1] === 0xfe) { le = true; b = b.subarray(2); }
    else if (b[0] === 0xfe && b[1] === 0xff) { le = false; b = b.subarray(2); }
    if (!le) { const sw = Buffer.from(b.subarray(0, b.length - (b.length % 2))); sw.swap16(); b = sw; }
    s = b.subarray(0, b.length - (b.length % 2)).toString('utf16le');
  } else s = body.toString('utf8');
  return s.replace(/\u0000+$/g, '').split('\u0000')[0].trim();
}

/** Lee las etiquetas de un Buffer con la cabecera del archivo. */
function parseID3(buf) {
  const tags = {};
  if (buf.length < 10 || buf.toString('latin1', 0, 3) !== 'ID3') return tags;
  const ver = buf[3];
  const flags = buf[5];
  const size = syncsafe(buf, 6);
  let o = 10;
  if (flags & 0x40) o += ver === 4 ? syncsafe(buf, 10) : buf.readUInt32BE(10) + 4; // cabecera extendida
  const endTag = Math.min(buf.length, 10 + size);
  const want = { TIT2: 'title', TPE1: 'artist', TALB: 'album', TT2: 'title', TP1: 'artist', TAL: 'album' };
  while (o < endTag) {
    if (ver === 2) {
      if (o + 6 > endTag) break;
      const id = buf.toString('latin1', o, o + 3);
      if (!/^[A-Z0-9]{3}$/.test(id)) break;
      const fsz = (buf[o + 3] << 16) | (buf[o + 4] << 8) | buf[o + 5];
      if (want[id]) tags[want[id]] = decodeText(buf.subarray(o + 6, o + 6 + fsz));
      o += 6 + fsz;
    } else {
      if (o + 10 > endTag) break;
      const id = buf.toString('latin1', o, o + 4);
      if (!/^[A-Z0-9]{4}$/.test(id)) break;
      const fsz = ver === 4 ? syncsafe(buf, o + 4) : buf.readUInt32BE(o + 4);
      if (fsz <= 0) break;
      if (want[id]) tags[want[id]] = decodeText(buf.subarray(o + 10, o + 10 + fsz));
      o += 10 + fsz;
    }
  }
  return tags;
}

/** "Artista - Título (Official Video).mp3" → { artist, title } */
function guessFromFilename(file) {
  let name = path.basename(file, path.extname(file))
    .replace(/_/g, ' ')
    .replace(/\s*[\[(](official|video|audio|lyric|letra|hd|4k|visualizer|music video)[^\])]*[\])]/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
  const m = name.match(/^(.+?)\s+[-–—]\s+(.+)$/);
  if (m) return { artist: m[1].trim(), title: m[2].trim() };
  return { title: name };
}

function readTags(file) {
  let tags = {};
  try {
    const fd = fs.openSync(file, 'r');
    const head = Buffer.alloc(10);
    fs.readSync(fd, head, 0, 10, 0);
    if (head.toString('latin1', 0, 3) === 'ID3') {
      const size = Math.min(syncsafe(head, 6) + 10, 4 * 1024 * 1024);
      const buf = Buffer.alloc(size);
      fs.readSync(fd, buf, 0, size, 0);
      tags = parseID3(buf);
    }
    fs.closeSync(fd);
  } catch { /* archivo sin etiquetas o ilegible: usamos el nombre */ }
  const guess = guessFromFilename(file);
  return {
    title: tags.title || guess.title,
    artist: tags.artist || guess.artist || '',
    album: tags.album || '',
    fromTags: Boolean(tags.title),
  };
}

module.exports = { parseID3, guessFromFilename, readTags };
