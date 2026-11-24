// Puente seguro entre la interfaz y el proceso principal.
const { contextBridge, ipcRenderer, webUtils } = require('electron');

const call = (ch) => (...args) => ipcRenderer.invoke(ch, ...args);

contextBridge.exposeInMainWorld('verso', {
  settings: { get: call('settings:get'), set: call('settings:set'), test: call('settings:test'), reset: call('settings:reset') },
  library: { list: call('lib:list'), get: call('lib:get'), save: call('lib:save'), remove: call('lib:remove'), clear: call('lib:clear') },
  file: {
    open: call('file:open'),
    info: call('file:info'),
    read: call('file:read'),
    pathFor: (file) => { try { return webUtils.getPathForFile(file); } catch { return ''; } },
  },
  lyrics: { find: call('lyrics:find'), import: call('lyrics:import'), align: call('lyrics:align'), identify: call('lyrics:identify') },
  ai: {
    transcribe: call('ai:transcribe'),
    translate: call('ai:translate'),
    review: call('ai:review'),
    polish: call('ai:polish'),
    cancel: call('ai:cancel'),
    onProgress: (fn) => {
      const h = (_e, p) => fn(p);
      ipcRenderer.on('ai:progress', h);
      return () => ipcRenderer.removeListener('ai:progress', h);
    },
  },
  exportSubs: call('export:save'),
  overlay: {
    toggle: call('overlay:toggle'),
    cue: (cue) => ipcRenderer.send('overlay:cue', cue),
    close: () => ipcRenderer.send('overlay:close'),
    onCue: (fn) => ipcRenderer.on('overlay:cue', (_e, c) => fn(c)),
    onSettings: (fn) => ipcRenderer.on('overlay:settings', (_e, s) => fn(s)),
    onState: (fn) => ipcRenderer.on('overlay:state', (_e, s) => fn(s)),
  },
  support: {
    info: call('support:info'),
    report: call('support:report'),
    copy: call('support:copy'),
    discord: call('support:discord'),
    github: call('support:github'),
    logs: call('support:logs'),
    logError: (e) => ipcRenderer.send('log:error', e),
    onCrash: (fn) => ipcRenderer.on('support:crash', (_e, c) => fn(c)),
  },
  openExternal: call('open:external'),
  platform: process.platform,
});
