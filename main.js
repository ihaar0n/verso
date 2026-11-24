// Verso — proceso principal de Electron.
const { app, BrowserWindow, ipcMain, dialog, shell, safeStorage, session, desktopCapturer, screen, globalShortcut, clipboard } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { pathToFileURL } = require('url');

const { Store } = require('./lib/store');
const { readTags } = require('./lib/id3');
const { findLyrics, parseLRC, plainToLines } = require('./lib/lyrics');
const ai = require('./lib/ai');
const { toSRT, toLRC } = require('./lib/subs');
const { alignLyrics } = require('./lib/align');
const I18N = require('./src/i18n');
const { Logger, buildReport, isInvite } = require('./lib/support');

let logger = null;
function localSupport() {
  try { return JSON.parse(fs.readFileSync(path.join(__dirname, 'soporte.json'), 'utf8')); } catch { return {}; }
}
let remoteSupport = null;
let remoteAt = 0;
/** Lee soporte.json de GitHub (así la invitación se cambia sin reinstalar) y, si no hay conexión, el local. */
async function supportConfig() {
  const local = localSupport();
  if (Date.now() - remoteAt > 10 * 60 * 1000 && /^https:\/\/raw\.githubusercontent\.com\//.test(local.remote || '')) {
    remoteAt = Date.now();
    try {
      const res = await fetch(local.remote, { signal: AbortSignal.timeout(4000), cache: 'no-store' });
      if (res.ok) remoteSupport = await res.json();
    } catch { /* sin conexión: se usa el local */ }
  }
  const r = remoteSupport || {};
  return {
    discordInvite: isInvite(r.discordInvite) ? r.discordInvite : local.discordInvite,
    serverName: r.serverName || local.serverName || '',
    issues: /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/issues\/new$/.test(local.issues || '') ? local.issues : '',
  };
}

const t = (key, vars) => I18N.t(key, vars, (store && store.getSettings().uiLang) || 'es');

const MEDIA_EXT = ['mp3', 'm4a', 'aac', 'wav', 'flac', 'ogg', 'opus', 'webm', 'mp4', 'mkv', 'mov', 'wma'];
const MAX_BYTES = 1024 * 1024 * 1024; // 1 GB

let win = null;
let overlay = null;
let store = null;
const jobs = new Map(); // jobId -> AbortController

const BG = '#1c0f12';
const FG = '#f3e7df';

function createWindow() {
  const theme = store.getSettings().theme;
  const bg = { vino: BG, noche: '#121316', papel: '#f7f1e8' }[theme] || BG;
  const fg = theme === 'papel' ? '#3a1e22' : FG;
  win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: bg,
    title: 'Verso',
    icon: path.join(__dirname, 'assets', 'icon.png'),
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: bg, symbolColor: fg, height: 44 },
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      devTools: !app.isPackaged,
    },
  });
  win.loadFile(path.join(__dirname, 'src', 'index.html'));
  win.once('ready-to-show', () => win.show());
  win.on('closed', () => {
    win = null;
    if (overlay && !overlay.isDestroyed()) overlay.close();
  });
  // Los enlaces externos se abren en el navegador, nunca dentro de la app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e) => e.preventDefault());
}

function overlayBounds(pos) {
  const { workArea } = screen.getPrimaryDisplay();
  const w = Math.min(1100, Math.round(workArea.width * 0.7));
  const h = 220;
  return {
    width: w,
    height: h,
    x: Math.round(workArea.x + (workArea.width - w) / 2),
    y: Math.round(pos === 'top' ? workArea.y + 30 : workArea.y + workArea.height - h - 40),
  };
}

function overlayPayload(s) {
  return {
    size: s.overlaySize, locked: s.overlayLocked, lang: s.uiLang || 'es',
    bg: s.overlayBg, color: s.overlayColor, pos: s.overlayPos, accent: s.accent,
  };
}

function toggleOverlay(on) {
  if (on) createOverlay().showInactive();
  else if (overlay && !overlay.isDestroyed()) overlay.close();
  if (win) win.webContents.send('overlay:state', Boolean(on));
}

function applyShortcut(s) {
  globalShortcut.unregister('CommandOrControl+Shift+S');
  if (s.overlayShortcut) {
    globalShortcut.register('CommandOrControl+Shift+S', () => toggleOverlay(!(overlay && !overlay.isDestroyed())));
  }
}

function createOverlay() {
  if (overlay && !overlay.isDestroyed()) return overlay;
  overlay = new BrowserWindow({
    ...overlayBounds(store.getSettings().overlayPos),
    frame: false,
    transparent: true,
    resizable: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    focusable: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      devTools: !app.isPackaged,
    },
  });
  overlay.setAlwaysOnTop(true, 'screen-saver');
  overlay.setVisibleOnAllWorkspaces(true);
  overlay.loadFile(path.join(__dirname, 'src', 'overlay.html'));
  const s = store.getSettings();
  overlay.webContents.once('did-finish-load', () => {
    overlay.webContents.send('overlay:settings', overlayPayload(s));
    if (s.overlayLocked) overlay.setIgnoreMouseEvents(true, { forward: true });
  });
  overlay.on('closed', () => {
    overlay = null;
    if (win) win.webContents.send('overlay:state', false);
  });
  return overlay;
}

function fileInfo(p) {
  const st = fs.statSync(p);
  const ext = path.extname(p).slice(1).toLowerCase();
  return {
    path: p,
    url: pathToFileURL(p).href,
    name: path.basename(p),
    ext,
    size: st.size,
    isVideo: ['mp4', 'mkv', 'mov', 'webm'].includes(ext),
    id: crypto.createHash('sha1').update(p + ':' + st.size).digest('hex').slice(0, 16),
    tags: readTags(p),
  };
}

// Aplica en caliente lo que afecta a otras ventanas o al sistema.
function afterSettingsChange(before) {
  const s = store.getSettings();
  if (overlay && !overlay.isDestroyed()) {
    overlay.webContents.send('overlay:settings', overlayPayload(s));
    overlay.setIgnoreMouseEvents(Boolean(s.overlayLocked), { forward: true });
    if (before.overlayPos !== s.overlayPos) overlay.setBounds(overlayBounds(s.overlayPos));
  }
  if (before.overlayShortcut !== s.overlayShortcut) applyShortcut(s);
  if (win && before.theme !== s.theme) {
    const bg = { vino: '#1c0f12', noche: '#121316', papel: '#f7f1e8' }[s.theme] || BG;
    const fg = s.theme === 'papel' ? '#3a1e22' : FG;
    win.setBackgroundColor(bg);
    try { win.setTitleBarOverlay({ color: bg, symbolColor: fg, height: 44 }); } catch { /* solo Windows */ }
  }
  return store.publicSettings();
}

function job(id) {
  const ctrl = new AbortController();
  if (id) jobs.set(id, ctrl);
  return ctrl;
}

// Convierte errores en mensajes que el renderer puede mostrar.
function safe(name, fn) {
  return async (_e, ...args) => {
    try { return { ok: true, data: await fn(...args) }; } catch (err) {
      if (err.name === 'AbortError') return { ok: false, cancelled: true, error: t('err.cancelled') };
      if (logger && err.kind !== 'auth') logger.error(name, err.message || String(err), err.kind);
      return { ok: false, kind: err.kind || 'error', error: err.message || String(err) };
    }
  };
}

function registerIPC() {
  ipcMain.handle('settings:get', safe('settings:get', () => store.publicSettings()));
  ipcMain.handle('settings:set', safe('settings:set', (patch) => {
    const clean = { ...patch };
    if (clean.apiKey === undefined) delete clean.apiKey;
    const before = store.getSettings();
    store.setSettings(clean);
    return afterSettingsChange(before);
  }));
  ipcMain.handle('settings:reset', safe('settings:reset', () => {
    const before = store.getSettings();
    store.reset();
    return afterSettingsChange(before);
  }));
  ipcMain.handle('lib:clear', safe('lib:clear', () => store.clearLibrary()));
  ipcMain.handle('settings:test', safe('settings:test', () => ai.testConnection(store.getSettings())));

  ipcMain.handle('lib:list', safe('lib:list', () => store.list().map(({ lines, ...rest }) => ({ ...rest, lineCount: lines?.length || 0 }))));
  ipcMain.handle('lib:get', safe('lib:get', (id) => {
    const item = store.get(id);
    if (!item) return null;
    item.missing = !fs.existsSync(item.path);
    if (!item.missing) item.url = pathToFileURL(item.path).href;
    return item;
  }));
  ipcMain.handle('lib:save', safe('lib:save', (item) => {
    const { url, missing, ...rest } = item;
    return store.save({ ...rest, openedAt: Date.now() });
  }));
  ipcMain.handle('lib:remove', safe('lib:remove', (id) => store.remove(id)));

  ipcMain.handle('file:open', safe('file:open', async () => {
    const r = await dialog.showOpenDialog(win, {
      title: t('dlg.open'),
      properties: ['openFile'],
      filters: [{ name: t('dlg.media'), extensions: MEDIA_EXT }, { name: t('dlg.all'), extensions: ['*'] }],
    });
    if (r.canceled || !r.filePaths[0]) return null;
    return fileInfo(r.filePaths[0]);
  }));
  ipcMain.handle('file:info', safe('file:info', (p) => {
    if (!p || !fs.existsSync(p)) throw new Error(t('err.notFound'));
    return fileInfo(p);
  }));
  ipcMain.handle('file:read', safe('file:read', (p) => {
    const st = fs.statSync(p);
    if (st.size > MAX_BYTES) throw Object.assign(new Error(t('err.tooBig')), { kind: 'tooBig' });
    const buf = fs.readFileSync(p);
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  }));

  ipcMain.handle('lyrics:find', safe('lyrics:find', (q) => findLyrics(q, { signal: AbortSignal.timeout(15000) })));
  ipcMain.handle('lyrics:import', safe('lyrics:import', async () => {
    const r = await dialog.showOpenDialog(win, {
      title: t('dlg.lyrics'),
      properties: ['openFile'],
      filters: [{ name: t('dlg.lyricsFilter'), extensions: ['lrc', 'txt'] }],
    });
    if (r.canceled || !r.filePaths[0]) return null;
    const text = fs.readFileSync(r.filePaths[0], 'utf8');
    const synced = parseLRC(text);
    return synced.length ? { lines: synced, synced: true } : { lines: plainToLines(text), synced: false };
  }));

  ipcMain.handle('ai:transcribe', safe('ai:transcribe', (args) => {
    const ctrl = job(args.jobId);
    return ai.transcribe(Buffer.from(args.wav), { ...args, settings: store.getSettings(), signal: ctrl.signal })
      .finally(() => args.jobId && jobs.delete(args.jobId));
  }));
  ipcMain.handle('ai:translate', safe('ai:translate', (args) => {
    const ctrl = job(args.jobId);
    const s = store.getSettings();
    return ai.translateTexts(args.texts, {
      target: args.target || s.target,
      context: args.context,
      settings: s,
      signal: ctrl.signal,
      onProgress: (done, total) => win && win.webContents.send('ai:progress', { jobId: args.jobId, phase: 'translate', done, total }),
    }).finally(() => args.jobId && jobs.delete(args.jobId));
  }));
  ipcMain.handle('ai:review', safe('ai:review', (args) => {
    const ctrl = job(args.jobId);
    const s = store.getSettings();
    return ai.reviewTranslation(args.src, args.draft, {
      target: args.target || s.target,
      context: args.context,
      settings: s,
      signal: ctrl.signal,
      onProgress: (done, total) => win && win.webContents.send('ai:progress', { jobId: args.jobId, phase: 'review', done, total }),
    }).finally(() => args.jobId && jobs.delete(args.jobId));
  }));
  ipcMain.handle('ai:polish', safe('ai:polish', (args) => {
    const ctrl = job(args.jobId);
    return ai.polishTranscript(args.texts, { context: args.context, settings: store.getSettings(), signal: ctrl.signal })
      .finally(() => args.jobId && jobs.delete(args.jobId));
  }));
  ipcMain.handle('lyrics:align', safe('lyrics:align', ({ lines, words, trim }) => alignLyrics(lines, words, { trim })));
  // Reconocer la canción por lo que se oye: la IA propone y LRCLIB da la letra oficial de cada propuesta.
  ipcMain.handle('lyrics:identify', safe('lyrics:identify', async ({ text, title, artist, jobId }) => {
    const ctrl = job(jobId);
    try {
      const guesses = await ai.identifySong(text, { title, artist, settings: store.getSettings(), signal: ctrl.signal });
      const out = [];
      const seen = new Set();
      for (const g of guesses) {
        const f = await findLyrics({ title: g.title, artist: g.artist, clip: true }, { signal: AbortSignal.timeout(12000) }).catch(() => null);
        if (f && !seen.has(f.match.id)) { seen.add(f.match.id); out.push(f); }
      }
      return out;
    } finally { if (jobId) jobs.delete(jobId); }
  }));
  ipcMain.handle('ai:cancel', safe('ai:cancel', (jobId) => {
    const c = jobs.get(jobId);
    if (c) { c.abort(); jobs.delete(jobId); }
    return true;
  }));

  ipcMain.handle('export:save', safe('export:save', async ({ lines, format, mode, offset, meta }) => {
    const base = [meta.artist, meta.title].filter(Boolean).join(' - ') || t('file.default');
    const suffix = mode === 'original' ? '' : mode === 'translated' ? t('file.tr') : t('file.both');
    const r = await dialog.showSaveDialog(win, {
      title: format === 'srt' ? t('dlg.saveSrt') : t('dlg.saveLrc'),
      defaultPath: `${base}${suffix}.${format}`.replace(/[\\/:*?"<>|]/g, ''),
      filters: [{ name: format.toUpperCase(), extensions: [format] }],
    });
    if (r.canceled || !r.filePath) return null;
    const content = format === 'srt' ? toSRT(lines, mode, offset) : toLRC(lines, mode, offset, meta);
    fs.writeFileSync(r.filePath, '﻿' + content, 'utf8');
    return path.basename(r.filePath);
  }));

  ipcMain.handle('overlay:toggle', safe('overlay:toggle', (on) => {
    toggleOverlay(on);
    return Boolean(on);
  }));
  ipcMain.on('overlay:cue', (_e, cue) => {
    if (overlay && !overlay.isDestroyed()) overlay.webContents.send('overlay:cue', cue);
  });
  ipcMain.on('overlay:close', () => { if (overlay && !overlay.isDestroyed()) overlay.close(); });

  // ---------- soporte ----------
  ipcMain.handle('support:info', safe('support:info', async () => {
    const c = await supportConfig();
    return { invite: isInvite(c.discordInvite) ? c.discordInvite : '', serverName: c.serverName, hasIssues: Boolean(c.issues), version: app.getVersion() };
  }));
  ipcMain.handle('support:report', safe('support:report', ({ context, note }) => buildReport({
    version: app.getVersion(),
    settings: store.getSettings(),
    context,
    note,
    logLines: logger ? logger.tail(40) : [],
    lang: store.getSettings().uiLang || 'es',
  })));
  ipcMain.handle('support:copy', safe('support:copy', (text) => { clipboard.writeText(String(text || '')); return true; }));
  ipcMain.handle('support:discord', safe('support:discord', async () => {
    const c = await supportConfig();
    if (!isInvite(c.discordInvite)) throw new Error(t('sup.noInvite'));
    shell.openExternal(c.discordInvite);
    return true;
  }));
  // Alternativa mientras no haya invitación: un aviso en GitHub con el informe ya escrito.
  ipcMain.handle('support:github', safe('support:github', async ({ title, body }) => {
    const c = await supportConfig();
    if (!c.issues) throw new Error(t('sup.noInvite'));
    const url = `${c.issues}?title=${encodeURIComponent(String(title || 'Problema').slice(0, 120))}&body=${encodeURIComponent(String(body || '').slice(0, 6000))}`;
    shell.openExternal(url);
    return true;
  }));
  ipcMain.handle('support:logs', safe('support:logs', () => shell.openPath(logger.dir)));
  ipcMain.on('log:error', (_e, { where, message, stack }) => {
    if (logger) logger.error(`interfaz:${String(where || '').slice(0, 60)}`, String(message || '').slice(0, 800), stack ? String(stack).split('\n').slice(0, 4).join(' / ') : '');
  });

  ipcMain.handle('open:external', safe('open:external', (url) => {
    const allowed = ['https://console.groq.com/keys', 'https://platform.openai.com/api-keys', 'https://ollama.com/download', 'https://lrclib.net'];
    if (allowed.includes(url)) shell.openExternal(url);
    return true;
  }));
}

app.whenReady().then(() => {
  store = new Store(app.getPath('userData'), safeStorage);
  logger = new Logger(app.getPath('userData'));
  logger.info('app', `Verso ${app.getVersion()} iniciado`);
  registerIPC();

  // Modo en vivo: el renderer pide getDisplayMedia y aquí le damos la pantalla con el audio del sistema (loopback, Windows).
  session.defaultSession.setDisplayMediaRequestHandler((_req, callback) => {
    desktopCapturer.getSources({ types: ['screen'] })
      .then((sources) => callback({ video: sources[0], audio: 'loopback' }))
      .catch(() => callback({}));
  }, { useSystemPicker: false });

  // Solo se conceden los permisos que la app usa.
  session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => {
    cb(['media', 'display-capture', 'clipboard-sanitized-write'].includes(permission));
  });

  applyShortcut(store.getSettings());
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('will-quit', () => globalShortcut.unregisterAll());

// Ningún contenido puede abrir ventanas, navegar fuera de la app ni incrustar webviews.
app.on('web-contents-created', (_e, contents) => {
  contents.on('will-attach-webview', (e) => e.preventDefault());
  contents.on('will-navigate', (e) => e.preventDefault());
  contents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
});

// Una sola copia de la app abierta a la vez.
if (!app.requestSingleInstanceLock()) app.quit();
else app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });

// Un fallo inesperado del proceso principal se registra y se ofrece reportarlo, en vez de cerrar la app en silencio.
function reportFatal(where, err) {
  const msg = err && err.message ? err.message : String(err);
  if (logger) logger.error(where, msg, err && err.stack ? err.stack.split('\n').slice(0, 4).join(' / ') : '');
  if (win && !win.isDestroyed()) win.webContents.send('support:crash', { where, message: msg });
}
process.on('uncaughtException', (err) => reportFatal('principal', err));
process.on('unhandledRejection', (err) => reportFatal('principal', err));
app.on('render-process-gone', (_e, _wc, details) => {
  if (logger) logger.error('ventana', `render-process-gone: ${details.reason}`);
  if (details.reason !== 'clean-exit' && win && !win.isDestroyed()) win.reload();
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
