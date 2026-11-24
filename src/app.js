// Verso — lógica de la ventana principal.
(function () {
  const api = window.verso;
  const A = window.VersoAudio;
  const I = window.I18N;
  const T = (k, v) => I.t(k, v);
  const $ = (id) => document.getElementById(id);

  const TARGETS = ['es', 'en', 'pt', 'fr', 'it', 'de', 'ja', 'ko', 'zh'];

  const el = {
    app: $('app'), audio: $('audio'), lyrics: $('lyrics'), viewport: $('lyricsViewport'),
    list: $('libraryList'), libEmpty: $('libraryEmpty'), toasts: $('toasts'),
    wave: $('wave'), canvas: $('waveCanvas'), tip: $('waveTip'),
    seg: $('viewSeg'), segInd: $('segInd'),
  };

  const state = {
    settings: null,
    cur: null,
    buffer: null,
    peaks: null,
    active: -1,
    editing: -1,
    followPausedUntil: 0,
    manualY: 0,
    job: null,
    overlay: false,
    capture: null,
    liveQueue: [],
    liveBusy: false,
    liveLast: '',
    liveLang: null,
    liveLastCue: null,
    view: 'empty',
    loop: -1,
    searchMsgKey: 'search.msg',
  };

  // ---------- utilidades ----------
  const fmt = (s) => {
    if (!isFinite(s) || s < 0) s = 0;
    const m = Math.floor(s / 60), r = Math.floor(s % 60);
    return `${m}:${String(r).padStart(2, '0')}`;
  };
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const norm = (s) => String(s || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
  const newJob = () => (state.job = 'j' + Math.random().toString(36).slice(2));
  const offset = () => state.cur?.offset || 0;
  const by = (title, artist) => (artist ? T('by', { title, artist }) : title || '');
  const songContext = () => {
    const c = state.cur;
    if (!c) return '';
    return [c.title && `"${c.title}"`, c.artist && `by ${c.artist}`].filter(Boolean).join(' ');
  };

  async function call(promise) {
    const r = await promise;
    if (!r) return null;
    if (!r.ok) {
      const e = new Error(r.error || T('t.generic'));
      e.kind = r.kind; e.cancelled = r.cancelled;
      throw e;
    }
    return r.data;
  }

  function toast(msg, { error = false, action, ms = 4200 } = {}) {
    const t = document.createElement('div');
    t.className = 'toast' + (error ? ' err' : '');
    t.setAttribute('role', error ? 'alert' : 'status');
    t.innerHTML = `<span>${esc(msg)}</span>`;
    const close = () => { t.classList.add('out'); setTimeout(() => t.remove(), 230); };
    if (action) {
      const b = document.createElement('button');
      b.className = 'link';
      b.textContent = action.label;
      b.onclick = () => { action.fn(); close(); };
      t.appendChild(b);
    }
    el.toasts.appendChild(t);
    setTimeout(close, action ? ms + 3000 : ms);
  }

  // Errores que la persona puede arreglar sola no se reportan; el resto ofrece "Reportar".
  const FIXABLE = new Set(['auth', 'rate', 'empty', 'tooBig', 'size']);
  function errorContext(message) {
    const step = document.querySelector('#steps li[data-state="active"] .label');
    return {
      message,
      where: state.view === 'work' && step ? step.textContent : state.view,
      song: state.cur ? by(state.cur.title || state.cur.name, state.cur.artist) : '',
    };
  }
  function errorToast(e) {
    if (e.cancelled) return;
    if (e.kind === 'auth') return toast(e.message, { error: true, action: { label: T('t.openSettings'), fn: () => openDrawer('ai') } });
    if (FIXABLE.has(e.kind)) return toast(e.message, { error: true });
    const ctx = errorContext(e.message);
    toast(e.message, { error: true, action: { label: T('sup.report'), fn: () => openReport(ctx) } });
  }

  function setView(v) {
    state.view = v;
    el.app.dataset.view = v;
    $('viewEmpty').hidden = v !== 'empty';
    $('viewWork').hidden = v !== 'work';
    $('viewLyrics').hidden = v !== 'lyrics';
    $('viewLive').hidden = v !== 'live';
    $('btnLiveText').textContent = T(v === 'live' ? 'side.liveStop' : 'side.live');
    if (v === 'lyrics') requestAnimationFrame(() => { drawWave(); placeSeg(); scrollToActive(true); });
    if (v === 'live') requestAnimationFrame(placeSeg);
  }

  // ---------- idioma de la app ----------
  function applyLang() {
    I.set(state.settings.uiLang || 'es');
    I.apply();
    const sel = $('target');
    const cur = state.settings.target;
    sel.innerHTML = TARGETS.map((c) => `<option value="${c}">${esc(I.langCap(c))}</option>`).join('');
    sel.value = cur;
    $('segTarget').textContent = I.langCap(state.settings.target);
    $('introRememberText').textContent = T('intro.remember');
    buildSegInd();
    setView(state.view);
    if (state.cur && state.view === 'lyrics') fillSongHead();
    if (!$('searchForm').hidden) $('searchMsg').textContent = T(state.searchMsgKey);
    document.querySelectorAll('#steps .note').forEach((n) => { n.textContent = ''; });
    placeSeg();
  }

  // ---------- ajustes ----------
  async function loadSettings() {
    state.settings = await call(api.settings.get());
    applySettings();
  }

  /** Tema, acento, letra y movimiento: atributos en <html> que leen las variables CSS. */
  function applyAppearance(s) {
    const h = document.documentElement;
    h.dataset.theme = s.theme || 'vino';
    h.dataset.accent = s.accent || 'mantequilla';
    h.dataset.lsize = s.lyricSize || 'm';
    h.dataset.lalign = s.lyricAlign || 'left';
    h.dataset.trstyle = s.trStyle || 'serif';
    h.dataset.linebar = s.lineBar === false ? 'off' : 'on';
    h.classList.toggle('rm', s.motion === 'reduced' || matchMedia('(prefers-reduced-motion: reduce)').matches);
    requestAnimationFrame(drawWave);
  }

  function applySettings() {
    const s = state.settings;
    applyAppearance(s);
    applyLang();
    setMode(s.view, false);
    $('heroKey').hidden = s.hasKey || s.translator === 'ollama';
  }

  // ---------- inicio: animación y elección de idioma ----------
  function runIntro() {
    return new Promise((resolve) => {
      const intro = $('intro');
      const s = state.settings;
      const ask = s.askLang !== false || !s.uiLang;
      const lyric = intro.querySelector('.intro-lyric');
      const pick = $('introPick');
      const lines = [
        ['Bailamos hasta que el sol se canse', 'We danced until the sun got tired'],
        ['We danced until the sun got tired', 'Bailamos hasta que el sol se cansó'],
      ];
      let k = 0;
      let swapTimer = null;
      let done = false;
      const reduced = document.documentElement.classList.contains('rm');

      // La frase cambia de idioma unas veces: enseña lo que hace la app.
      const swap = () => {
        k = (k + 1) % lines.length;
        lyric.classList.add('swap');
        setTimeout(() => {
          $('ilA').textContent = lines[k][0];
          $('ilB').textContent = lines[k][1];
          lyric.classList.remove('swap');
          lyric.classList.add('swapped');
        }, 220);
      };

      const finish = (lang) => {
        if (done) return;
        done = true;
        clearInterval(swapTimer);
        // Si se ha elegido idioma, la intro sigue abierta por si falta el paso de la clave.
        if (!lang) hideIntro();
        resolve(lang);
      };

      if (!ask) {
        intro.classList.add('quick');
        const skip = () => finish(null);
        intro.addEventListener('click', skip, { once: true });
        document.addEventListener('keydown', skip, { once: true });
        setTimeout(skip, reduced ? 500 : 1500);
        return;
      }

      const last = s.uiLang || ((navigator.language || 'es').startsWith('en') ? 'en' : 'es');
      const btns = [...intro.querySelectorAll('.lang-btn')];
      const mark = (lang) => {
        btns.forEach((b) => b.setAttribute('aria-checked', String(b.dataset.lang === lang)));
        $('introRememberText').textContent = I.t('intro.remember', null, lang);
      };
      btns.forEach((b) => {
        b.setAttribute('role', 'radio');
        b.addEventListener('pointerenter', () => mark(b.dataset.lang));
        b.addEventListener('focus', () => mark(b.dataset.lang));
        b.addEventListener('click', () => finish(b.dataset.lang));
      });
      intro.addEventListener('keydown', (e) => {
        if (['ArrowLeft', 'ArrowRight'].includes(e.key)) {
          const i = btns.indexOf(document.activeElement);
          btns[(i + 1) % btns.length].focus();
          e.preventDefault();
        }
      });
      mark(last);
      setTimeout(() => {
        pick.classList.add('show');
        btns.find((b) => b.dataset.lang === last).focus({ preventScroll: true });
      }, reduced ? 0 : 900);
      if (!reduced) {
        let n = 0;
        swapTimer = setInterval(() => { swap(); if (++n >= 5) clearInterval(swapTimer); }, 2600);
      }
    });
  }

  function hideIntro() {
    const intro = $('intro');
    intro.classList.add('out');
    setTimeout(() => { intro.hidden = true; }, 340);
  }

  /** Paso 2 de la primera apertura: pegar la clave gratis de Groq. */
  function keyStep() {
    return new Promise((resolve) => {
      const intro = $('intro');
      $('introKey').hidden = false;
      intro.classList.add('step2');
      const input = $('obKey'), err = $('obError'), save = $('obSave');
      setTimeout(() => input.focus(), 120);
      $('obOpen').onclick = () => api.openExternal('https://console.groq.com/keys');
      $('obLater').onclick = () => resolve(false);
      const submit = async () => {
        const key = input.value.trim();
        err.hidden = true;
        if (!key) { err.textContent = T('ob.empty'); err.hidden = false; input.focus(); return; }
        save.disabled = true;
        save.textContent = T('ob.checking');
        try {
          state.settings = await call(api.settings.set({ apiKey: key, provider: 'groq' }));
          await call(api.settings.test());
          applySettings();
          resolve(true);
        } catch (e) {
          err.textContent = e.message;
          err.hidden = false;
          input.select();
        }
        save.disabled = false;
        save.textContent = T('ob.save');
      };
      save.onclick = submit;
      input.onkeydown = (e) => { if (e.key === 'Enter') submit(); };
    });
  }

  async function chooseLang(lang) {
    if (!lang) return;
    const remember = $('introRemember').checked;
    const patch = { uiLang: lang, askLang: !remember };
    // La primera vez, las traducciones van al mismo idioma que la app.
    if (!state.settings.uiLang || state.settings.uiLang !== lang) patch.target = lang;
    state.settings = await call(api.settings.set(patch));
    applySettings();
  }

  // ---------- biblioteca ----------
  async function refreshLibrary() {
    const items = await call(api.library.list());
    el.list.innerHTML = '';
    el.libEmpty.hidden = items.length > 0;
    for (const it of items) {
      const li = document.createElement('li');
      li.innerHTML = `<button data-id="${esc(it.id)}"><span class="li-title">${esc(it.title || it.name)}</span><span class="li-sub">${esc(it.artist || it.name)}</span></button>`;
      if (state.cur && state.cur.id === it.id) li.firstChild.setAttribute('aria-current', 'true');
      el.list.appendChild(li);
    }
  }

  el.list.addEventListener('click', async (e) => {
    const b = e.target.closest('button[data-id]');
    if (!b) return;
    try {
      const item = await call(api.library.get(b.dataset.id));
      if (!item) return refreshLibrary();
      if (item.missing) {
        toast(T('t.missingFile'), {
          error: true,
          action: { label: T('t.removeFromLib'), fn: async () => { await call(api.library.remove(item.id)); refreshLibrary(); } },
        });
        return;
      }
      await openItem(item);
    } catch (err) { errorToast(err); }
  });

  async function save() {
    if (!state.cur) return;
    const { url, ...item } = state.cur;
    await call(api.library.save(item));
    refreshLibrary();
  }

  // ---------- abrir y procesar ----------
  function stepState(step, st, note = '') {
    const li = document.querySelector(`#steps li[data-step="${step}"]`);
    li.dataset.state = st;
    li.querySelector('.note').textContent = note;
  }

  function resetSteps(title) {
    $('workSong').textContent = title;
    document.querySelectorAll('#steps li').forEach((li) => stepState(li.dataset.step, 'pending'));
    stepState('review', state.settings.review ? 'pending' : 'skip');
  }

  function progress(frac) {
    const p = $('workProgress');
    if (frac == null) { p.classList.add('indeterminate'); return; }
    p.classList.remove('indeterminate');
    p.firstElementChild.style.transform = `scaleX(${Math.max(0, Math.min(1, frac))})`;
  }

  async function loadMedia(info) {
    el.audio.src = info.url;
    state.buffer = null;
    state.peaks = null;
    drawWave();
    try {
      const bytes = await call(api.file.read(info.path));
      state.buffer = await A.decode(bytes);
      state.peaks = A.peaks(state.buffer);
      drawWave();
      return state.buffer.duration;
    } catch (e) {
      if (e.kind === 'tooBig') throw e;
      return null; // se puede reproducir pero no decodificar: sin onda ni transcripción
    }
  }

  async function openFile(info) {
    stopLive();
    el.audio.pause();
    const cached = await call(api.library.get(info.id)).catch(() => null);
    if (cached && cached.lines?.length && !cached.missing) return openItem(cached);

    state.cur = {
      id: info.id, path: info.path, url: info.url, name: info.name, isVideo: info.isVideo,
      title: info.tags.title, artist: info.tags.artist, album: info.tags.album,
      lines: [], synced: false, source: null, lang: null, target: state.settings.target, offset: 0,
    };
    const job = newJob();
    resetSteps(by(state.cur.title, state.cur.artist));
    setView('work');
    progress(null);

    try {
      stepState('read', 'active');
      const dur = await loadMedia(info);
      if (state.job !== job) return;
      state.cur.duration = dur || (await metaDuration());
      stepState('read', 'done', state.cur.duration ? fmt(state.cur.duration) : '');
      await findAndProcess(job, { title: state.cur.title, artist: state.cur.artist });
    } catch (e) {
      if (state.job !== job) return;
      errorToast(e);
      setView(state.cur?.lines?.length ? 'lyrics' : 'empty');
    }
  }

  function metaDuration() {
    return new Promise((res) => {
      if (isFinite(el.audio.duration) && el.audio.duration) return res(el.audio.duration);
      el.audio.addEventListener('loadedmetadata', () => res(el.audio.duration || 0), { once: true });
      setTimeout(() => res(0), 4000);
    });
  }

  async function findAndProcess(job, query) {
    const canAI = state.settings.hasKey && Boolean(state.buffer);
    const dur = state.cur.duration || 0;
    // Un clip de TikTok o Reels dura poco: sus tiempos no coinciden con los de la canción entera.
    const clip = dur > 0 && dur < 100;
    stepState('lyrics', 'active', clip ? T('note.clip') : '');
    progress(null);
    let found = null;
    try {
      found = await call(api.lyrics.find({ ...query, duration: dur, clip }));
    } catch {
      stepState('lyrics', 'done', T('note.lrclibOffline'));
    }
    if (state.job !== job) return;
    // El archivo es un trozo de la canción si dura bastante menos que ella.
    const partial = clip || Boolean(found && found.match.duration && dur && found.match.duration - dur > 20);

    if (found && found.synced && !partial) {
      // La mejor fuente: letra oficial ya sincronizada con la canción completa.
      stepState('lyrics', 'done', `${found.match.artist}, ${found.match.title}`);
      stepState('transcribe', 'skip');
      Object.assign(state.cur, { lines: found.lines, synced: true, source: 'lrclib', lrclibId: found.match.id });
    } else if (canAI) {
      stepState('lyrics', 'done', found ? `${found.match.artist}, ${found.match.title}` : T('note.noLrclib'));
      // Se escucha el audio: con letra oficial se le ponen los tiempos reales; sin ella, se reconoce la canción.
      await transcribeCurrent(job, found ? found.lines : null, { trim: partial, identify: true, query });
      if (state.job !== job) return;
    } else if (found) {
      stepState('lyrics', 'done', `${found.match.artist}, ${found.match.title}`);
      stepState('transcribe', 'skip', T('note.noKey'));
      // Sin clave no se puede saber qué trozo suena en un clip: se muestra la letra sin seguirla.
      Object.assign(state.cur, { lines: found.lines, synced: found.synced && !partial, source: found.synced && !partial ? 'lrclib' : 'lrclib-plain' });
    } else {
      stepState('lyrics', 'done', T('note.notFound'));
      stepState('transcribe', 'skip', T(state.settings.hasKey ? 'note.noAudio' : 'note.noKey'));
      stepState('translate', 'skip');
      stepState('review', 'skip');
      state.cur.lines = [];
      await save();
      showLyrics();
      return;
    }

    await translateCurrent(job);
    if (state.job !== job) return;
    await save();
    showLyrics({ play: true });
  }

  /** Escucha todo el audio por trozos. Devuelve { lines, words, lang } o null si se canceló. */
  async function listen(job, hintLines) {
    const lines = [];
    const words = [];
    let lang = null;
    const total = state.buffer.duration;
    progress(0);
    const prompt0 = hintLines ? hintLines.slice(0, 6).map((l) => l.text).join(' ') : '';
    for await (const chunk of A.wavChunks(state.buffer)) {
      if (state.job !== job) return null;
      const r = await call(api.ai.transcribe({
        jobId: job, wav: chunk.wav, offset: chunk.offset, language: lang || undefined,
        prompt: lines.length ? lines.slice(-3).map((l) => l.text).join(' ') : prompt0,
      }));
      lang = lang || r.language;
      lines.push(...r.lines);
      words.push(...(r.words || []));
      const frac = (chunk.offset + chunk.duration) / total;
      progress(frac);
      stepState('transcribe', 'active', T('note.percent', { n: Math.round(frac * 100) }));
    }
    return { lines, words, lang };
  }

  /** Pone los tiempos del audio a una letra oficial. Solo vale si de verdad coincide con lo que se oye. */
  async function alignTo(official, heard, trim) {
    if (!official?.length || !heard.words.length) return null;
    const al = await call(api.lyrics.align({ lines: official.map((l) => ({ text: l.text })), words: heard.words, trim }));
    const min = trim ? 0.5 : 0.45;
    return al && al.lines.length && al.quality >= min && al.matched >= 4 ? al : null;
  }

  /**
   * Escucha el audio. officialLines: letra exacta sin tiempos (o de la canción entera, si es un clip).
   * identify: si no hay letra que encaje, intenta reconocer la canción por lo que se oye.
   */
  async function transcribeCurrent(job, officialLines = null, { trim = false, identify = false, query = {} } = {}) {
    stepState('transcribe', 'active');
    const heard = await listen(job, officialLines);
    if (!heard || state.job !== job) return;
    if (!heard.lines.length) throw Object.assign(new Error(T('t.noSpeech')), { kind: 'empty' });

    // 1) Letra oficial + tiempos reales.
    const al = await alignTo(officialLines, heard, trim);
    if (al) {
      Object.assign(state.cur, { lines: al.lines, synced: true, source: 'aligned', lang: heard.lang });
      stepState('transcribe', 'done', T('note.aligned'));
      return;
    }

    // 2) Reconocer la canción (TikTok, archivos sin nombre…) y comprobarlo con su letra oficial.
    if (identify) {
      stepState('transcribe', 'active', T('note.identifying'));
      progress(null);
      try {
        const cands = await call(api.lyrics.identify({
          jobId: job, text: heard.lines.map((l) => l.text).join('\n'), title: query.title || state.cur.name, artist: query.artist,
        }));
        let best = null;
        for (const c of cands || []) {
          if (state.job !== job) return;
          const a = await alignTo(c.lines, heard, trim);
          if (a && (!best || a.quality > best.a.quality)) best = { c, a };
        }
        if (best) {
          Object.assign(state.cur, {
            title: best.c.match.title, artist: best.c.match.artist,
            lines: best.a.lines, synced: true, source: 'identified', lang: heard.lang, lrclibId: best.c.match.id,
          });
          stepState('lyrics', 'done', `${best.c.match.artist}, ${best.c.match.title}`);
          stepState('transcribe', 'done', T('note.identified'));
          $('workSong').textContent = by(best.c.match.title, best.c.match.artist);
          return;
        }
      } catch (e) { if (e.cancelled) throw e; /* si no se reconoce, se usa lo que se oyó */ }
    }

    // 3) Solo lo que se oyó, corrigiendo con cuidado las palabras mal entendidas.
    let final = heard.lines;
    stepState('transcribe', 'active', T('note.polishing'));
    progress(null);
    try {
      const fixed = await call(api.ai.polish({ jobId: job, texts: heard.lines.map((l) => l.text), context: songContext() }));
      if (fixed) final = heard.lines.map((l, i) => ({ ...l, text: fixed[i] || l.text }));
    } catch (e) { if (e.cancelled) throw e; /* si falla el pulido, se queda la transcripción tal cual */ }
    Object.assign(state.cur, { lines: final, synced: true, source: 'whisper', lang: heard.lang });
    stepState('transcribe', 'done', heard.lang ? T('note.inLang', { lang: I.langName(heard.lang) }) : '');
  }

  async function translateCurrent(job) {
    const s = state.settings;
    const target = s.target;
    state.cur.target = target;
    if (state.cur.lang && state.cur.lang === target) {
      state.cur.lines.forEach((l) => { l.tr = l.text; });
      stepState('translate', 'skip', T('note.alreadyIn', { lang: I.langName(target) }));
      stepState('review', 'skip');
      return;
    }
    if (!s.hasKey && s.translator !== 'ollama') {
      stepState('translate', 'skip', T('note.noKey'));
      stepState('review', 'skip');
      toast(T('t.readyNoKey'), { action: { label: T('t.openSettings'), fn: () => openDrawer('ai') } });
      return;
    }
    stepState('translate', 'active');
    progress(0);
    const off = api.ai.onProgress((p) => {
      if (p.jobId !== job) return;
      progress(p.done / p.total);
      if (p.phase === 'review') stepState('review', 'active', T('note.reviewing', { done: p.done, total: p.total }));
      else stepState('translate', 'active', T('note.lines', { done: p.done, total: p.total }));
    });
    const texts = state.cur.lines.map((l) => l.text);
    const context = songContext() ? `song ${songContext()}` : '';
    try {
      let tr = await call(api.ai.translate({ jobId: job, texts, target, context }));
      state.cur.lines.forEach((l, i) => { l.tr = tr[i]; });
      stepState('translate', 'done', T('note.toLang', { lang: I.langName(target) }));

      const same = state.cur.lines.filter((l) => norm(l.tr) === norm(l.text)).length;
      if (same > state.cur.lines.length * 0.7) {
        state.cur.lang = target;
        stepState('review', 'skip', T('note.alreadyIn', { lang: I.langName(target) }));
        return;
      }

      if (s.review) {
        // Segunda pasada: otra lectura completa que busca y corrige errores.
        if (state.job !== job) return;
        stepState('review', 'active');
        progress(0);
        const r = await call(api.ai.review({ jobId: job, src: texts, draft: tr, target, context }));
        state.cur.lines.forEach((l, i) => { l.tr = r.lines[i]; });
        stepState('review', 'done', r.fixed ? T('note.fixed', { n: r.fixed }) : T('note.noFixes'));
      }
    } catch (e) {
      if (e.cancelled) throw e;
      const st = document.querySelector('#steps li[data-step="review"]').dataset.state;
      stepState(st === 'active' ? 'review' : 'translate', 'skip', T('note.failed'));
      errorToast(e);
    } finally { off(); }
  }

  async function openItem(item) {
    stopLive();
    el.audio.pause();
    newJob();
    state.cur = { ...item, offset: item.offset || 0 };
    showLyrics();
    const dur = await loadMedia(item);
    if (dur) state.cur.duration = dur;
    save();
    if (state.cur.lines.length && state.cur.target && state.cur.target !== state.settings.target && state.settings.hasKey) {
      toast(T('t.otherTarget', { from: I.langName(state.cur.target) }), {
        action: { label: T('t.translateTo', { to: I.langName(state.settings.target) }), fn: () => runAction('retranslate') },
      });
    }
  }

  // ---------- vista de letra ----------
  function fillSongHead() {
    const c = state.cur;
    $('songTitle').textContent = c.title || c.name;
    $('songArtist').textContent = c.artist || '';
    const src = c.source ? T('src.' + c.source) : '';
    const lang = c.lang && c.lang !== state.settings.target ? T('src.inLang', { lang: I.langName(c.lang) }) : '';
    $('songSource').textContent = src ? src + lang : '';
    $('songHint').hidden = !c.lines.length;
  }

  function showLyrics({ play = false } = {}) {
    const c = state.cur;
    stopLoop(true);
    state.editing = -1;
    fillSongHead();
    $('unsyncedNote').hidden = !(c.lines.length && !c.synced);
    $('btnSyncAI').hidden = !state.settings.hasKey;
    $('keyCta').hidden = c.lines.length > 0 || state.settings.hasKey;
    const sf = $('searchForm');
    sf.hidden = c.lines.length > 0;
    if (!c.lines.length) {
      sf.title.value = c.title || '';
      sf.artist.value = c.artist || '';
      state.searchMsgKey = 'search.notFound';
      $('searchMsg').textContent = T(state.searchMsgKey);
    }
    renderLines();
    updateOffset();
    setView('lyrics');
    refreshLibrary();
    if (play && state.settings.autoplay && c.lines.length) el.audio.play().catch(() => {});
  }

  function lineHTML(l, bar = false) {
    const tr = l.tr || l.text;
    const same = norm(tr) === norm(l.text);
    // Si la traducción es igual al original, en "Las dos" no se repite (clase dup).
    return `<span class="lo">${esc(l.text)}</span><span class="lt${same ? ' dup' : ''}">${esc(tr)}</span>` +
      (bar ? '<span class="line-bar" aria-hidden="true"><i></i></span>' : '');
  }

  function renderLines() {
    const c = state.cur;
    const frag = document.createDocumentFragment();
    c.lines.forEach((l, i) => {
      const li = document.createElement('li');
      li.className = 'line';
      li.dataset.i = i;
      li.innerHTML = lineHTML(l, c.synced);
      frag.appendChild(li);
    });
    el.lyrics.innerHTML = '';
    el.lyrics.appendChild(frag);
    el.lyrics.classList.toggle('plain', !c.synced);
    el.lyrics.style.transform = 'translateY(0)';
    state.active = -1;
    state.manualY = 0;
    syncTick(true);
  }

  function activeIndex(t) {
    const lines = state.cur?.lines;
    if (!lines?.length || !state.cur.synced) return -1;
    const off = offset();
    let lo = 0, hi = lines.length - 1, idx = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (lines[mid].t + off <= t) { idx = mid; lo = mid + 1; } else hi = mid - 1;
    }
    return idx;
  }

  function syncTick(force = false) {
    if (!state.cur || state.view !== 'lyrics') return;
    const t = el.audio.currentTime;
    const idx = activeIndex(t);
    if (idx !== state.active || force) {
      const prev = state.active;
      state.active = idx;
      const items = el.lyrics.children;
      if (prev >= 0 && items[prev]) items[prev].classList.remove('active');
      for (let i = 0; i < items.length; i++) items[i].classList.toggle('past', i < idx);
      if (idx >= 0 && items[idx]) items[idx].classList.add('active');
      scrollToActive(force);
    }
    updateLineBar(t);
    sendCue(t);
  }

  // Se escribe el transform directamente en la barra (nada de variables CSS por fotograma).
  function updateLineBar(t) {
    const i = state.active;
    if (i < 0) return;
    const bar = el.lyrics.children[i]?.querySelector('.line-bar i');
    if (!bar) return;
    const l = state.cur.lines[i];
    const start = l.t + offset();
    const end = (l.end ?? l.t + 4) + offset();
    const f = Math.max(0, Math.min(1, (t - start) / Math.max(0.1, end - start)));
    bar.style.transform = `scaleX(${f})`;
  }

  function scrollToActive(instant = false) {
    if (!state.cur?.synced || state.editing >= 0 || Date.now() < state.followPausedUntil) return;
    const items = el.lyrics.children;
    const target = state.active >= 0 ? items[state.active] : items[0];
    if (!target) return;
    const y = -(target.offsetTop - el.viewport.clientHeight * 0.34);
    state.manualY = Math.min(0, y);
    el.lyrics.classList.toggle('free', instant);
    el.lyrics.style.transform = `translateY(${state.manualY}px)`;
    if (instant) requestAnimationFrame(() => el.lyrics.classList.remove('free'));
    $('btnFollow').hidden = true;
  }

  el.viewport.addEventListener('wheel', (e) => {
    if (!state.cur?.lines.length) return;
    e.preventDefault();
    const max = Math.max(0, el.lyrics.scrollHeight - el.viewport.clientHeight * 0.6);
    state.manualY = Math.max(-max, Math.min(0, state.manualY - e.deltaY));
    el.lyrics.classList.add('free');
    el.lyrics.style.transform = `translateY(${state.manualY}px)`;
    if (state.cur.synced) {
      state.followPausedUntil = Date.now() + (state.settings.followDelay || 5) * 1000;
      $('btnFollow').hidden = false;
    }
  }, { passive: false });

  $('btnFollow').onclick = () => { state.followPausedUntil = 0; el.lyrics.classList.remove('free'); scrollToActive(); };

  el.lyrics.addEventListener('click', (e) => {
    if (e.target.closest('.line-edit')) return;
    const li = e.target.closest('.line');
    if (!li || !state.cur.synced || e.detail > 1 || state.settings.clickSeek === false) return;
    const l = state.cur.lines[+li.dataset.i];
    el.audio.currentTime = Math.max(0, l.t + offset());
    state.followPausedUntil = 0;
    el.lyrics.classList.remove('free');
    el.audio.play();
  });

  // ---------- corregir una línea a mano ----------
  el.lyrics.addEventListener('dblclick', (e) => {
    if (e.target.closest('.line-edit')) return;
    const li = e.target.closest('.line');
    if (li) startEdit(+li.dataset.i);
  });

  function startEdit(i) {
    if (state.editing >= 0) cancelEdit();
    const l = state.cur.lines[i];
    const li = el.lyrics.children[i];
    state.editing = i;
    el.audio.pause();
    li.classList.add('editing');
    li.innerHTML = `
      <div class="line-edit">
        <label>${esc(T('edit.original'))}<textarea class="or" rows="1">${esc(l.text)}</textarea></label>
        <label>${esc(T('edit.translation'))}<textarea class="tr" rows="1">${esc(l.tr || '')}</textarea></label>
        <div class="row">
          <button class="btn btn-primary btn-sm" data-e="save">${esc(T('edit.save'))}</button>
          <button class="btn btn-ghost btn-sm" data-e="cancel">${esc(T('edit.cancel'))}</button>
        </div>
      </div>`;
    const box = li.querySelector('.line-edit');
    box.querySelector('.tr').focus();
    box.addEventListener('click', (ev) => {
      const b = ev.target.closest('[data-e]');
      if (!b) return;
      if (b.dataset.e === 'save') commitEdit(); else cancelEdit();
    });
    box.addEventListener('keydown', (ev) => {
      if (ev.key === 'Escape') { ev.stopPropagation(); cancelEdit(); }
      if (ev.key === 'Enter' && (ev.ctrlKey || !ev.shiftKey)) { ev.preventDefault(); commitEdit(); }
    });
  }

  function endEdit() {
    const i = state.editing;
    state.editing = -1;
    const li = el.lyrics.children[i];
    if (!li) return;
    li.classList.remove('editing');
    li.innerHTML = lineHTML(state.cur.lines[i], state.cur.synced);
  }

  function cancelEdit() { if (state.editing >= 0) endEdit(); }

  async function commitEdit() {
    const i = state.editing;
    if (i < 0) return;
    const li = el.lyrics.children[i];
    const or = li.querySelector('textarea.or').value.trim();
    const trv = li.querySelector('textarea.tr').value.trim();
    const l = state.cur.lines[i];
    if (or) l.text = or;
    l.tr = trv || l.tr;
    l.edited = true;
    endEdit();
    lastCue = '';
    syncTick(true);
    await save();
    toast(T('edit.saved'));
  }

  // ---------- subtítulos flotantes ----------
  const overlayMode = () => (state.settings.overlayView && state.settings.overlayView !== 'follow' ? state.settings.overlayView : state.settings.view);
  let lastCue = '';
  function sendCue(t) {
    if (!state.overlay) return;
    const c = state.cur;
    let cue = { orig: '', tr: '', mode: overlayMode() };
    const i = state.active;
    if (c?.synced && i >= 0) {
      const l = c.lines[i];
      const end = (l.end ?? l.t + 6) + offset();
      if (t <= end + 0.6) cue = { ...cue, orig: l.text, tr: l.tr || '' };
    }
    const key = cue.orig + '|' + cue.tr + '|' + cue.mode;
    if (key !== lastCue) { lastCue = key; api.overlay.cue(cue); }
  }

  $('btnFloat').onclick = async () => {
    const on = !state.overlay;
    try {
      await call(api.overlay.toggle(on));
      state.overlay = on;
      $('btnFloat').setAttribute('aria-pressed', String(on));
      lastCue = '';
      if (on) {
        if (state.view === 'live' && state.liveLastCue) api.overlay.cue(state.liveLastCue);
        else sendCue(el.audio.currentTime);
      }
    } catch (e) { errorToast(e); }
  };
  api.overlay.onState((on) => { state.overlay = on; $('btnFloat').setAttribute('aria-pressed', String(on)); });

  // ---------- control segmentado ----------
  function buildSegInd() {
    el.segInd.innerHTML = '';
    el.seg.querySelectorAll('button').forEach((b) => {
      const s = document.createElement('span');
      s.textContent = b.textContent;
      el.segInd.appendChild(s);
    });
  }

  function placeSeg() {
    const btn = el.seg.querySelector('button[aria-checked="true"]');
    if (!btn || !el.seg.offsetWidth) return;
    const w = el.segInd.offsetWidth;
    const left = btn.offsetLeft - 3;
    const right = w - (left + btn.offsetWidth);
    el.segInd.style.clipPath = `inset(0 ${right}px 0 ${left}px round 8px)`;
  }

  function setMode(v, persist = true) {
    state.settings.view = v;
    el.seg.querySelectorAll('button').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.v === v)));
    el.lyrics.dataset.view = v;
    $('liveCues').dataset.view = v;
    placeSeg();
    lastCue = '';
    if (state.view === 'lyrics') {
      requestAnimationFrame(() => scrollToActive(true));
      sendCue(el.audio.currentTime);
    } else if (state.view === 'live' && state.overlay && state.liveLastCue) {
      api.overlay.cue({ ...state.liveLastCue, mode: overlayMode() });
    }
    if (persist) api.settings.set({ view: v });
  }

  el.seg.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-v]');
    if (b) setMode(b.dataset.v);
  });
  window.addEventListener('resize', () => { placeSeg(); drawWave(); scrollToActive(true); });

  // ---------- reproductor ----------
  const playIcon = $('playIcon');
  function syncPlayIcon() {
    const playing = !el.audio.paused;
    playIcon.setAttribute('href', playing ? '#i-pause' : '#i-play');
    $('btnPlay').setAttribute('aria-label', T(playing ? 'aria.pause' : 'aria.play'));
  }
  $('btnPlay').onclick = () => (el.audio.paused ? el.audio.play() : el.audio.pause());
  $('btnBack').onclick = () => { el.audio.currentTime = Math.max(0, el.audio.currentTime - 5); };
  $('btnFwd').onclick = () => { el.audio.currentTime = Math.min(el.audio.duration || 0, el.audio.currentTime + 5); };
  el.audio.addEventListener('play', () => { if (state.editing >= 0) cancelEdit(); syncPlayIcon(); loop(); });
  el.audio.addEventListener('pause', syncPlayIcon);
  el.audio.addEventListener('ended', syncPlayIcon);
  el.audio.addEventListener('seeked', () => { syncTick(); drawWave(); });
  el.audio.addEventListener('loadedmetadata', () => { $('timeDur').textContent = fmt(el.audio.duration); drawWave(); });
  el.audio.addEventListener('error', () => { if (el.audio.getAttribute('src')) toast(T('t.badFormat'), { error: true }); });

  function loop() {
    if (el.audio.paused) return;
    checkLoop();
    syncTick();
    drawWave();
    requestAnimationFrame(loop);
  }

  let hoverX = null;
  function drawWave() {
    const cv = el.canvas;
    const dpr = window.devicePixelRatio || 1;
    const w = cv.clientWidth, h = cv.clientHeight;
    if (!w) return;
    if (cv.width !== Math.round(w * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); }
    const g = cv.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    const css = getComputedStyle(document.documentElement);
    const played = css.getPropertyValue('--butter').trim();
    const rest = css.getPropertyValue('--bg-4').trim();
    const dur = el.audio.duration || state.cur?.duration || 0;
    const frac = dur ? el.audio.currentTime / dur : 0;
    const bar = 2, gap = 2;
    const n = Math.floor(w / (bar + gap));
    for (let i = 0; i < n; i++) {
      const x = i * (bar + gap);
      let v = 0.08;
      if (state.peaks) v = Math.max(0.06, state.peaks[Math.floor((i / n) * state.peaks.length)] || 0);
      const bh = Math.max(2, v * (h - 6));
      g.fillStyle = x / w <= frac ? played : rest;
      g.fillRect(x, (h - bh) / 2, bar, bh);
    }
    if (hoverX != null) {
      g.fillStyle = css.getPropertyValue('--ink').trim();
      g.fillRect(hoverX, 4, 1, h - 8);
    }
    $('timeCur').textContent = fmt(el.audio.currentTime);
    el.wave.setAttribute('aria-valuenow', String(Math.round(frac * 100)));
  }

  function waveSeek(e) {
    const r = el.wave.getBoundingClientRect();
    const f = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
    const dur = el.audio.duration || 0;
    if (dur) el.audio.currentTime = f * dur;
  }
  el.wave.addEventListener('pointerdown', (e) => {
    el.wave.setPointerCapture(e.pointerId);
    waveSeek(e);
    const move = (ev) => waveSeek(ev);
    el.wave.addEventListener('pointermove', move);
    el.wave.addEventListener('pointerup', () => el.wave.removeEventListener('pointermove', move), { once: true });
  });
  el.wave.addEventListener('mousemove', (e) => {
    const r = el.wave.getBoundingClientRect();
    hoverX = e.clientX - r.left;
    el.tip.style.left = hoverX + 'px';
    el.tip.textContent = fmt((hoverX / r.width) * (el.audio.duration || 0));
    drawWave();
  });
  el.wave.addEventListener('mouseleave', () => { hoverX = null; drawWave(); });
  el.wave.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowLeft') { el.audio.currentTime -= 5; e.preventDefault(); }
    if (e.key === 'ArrowRight') { el.audio.currentTime += 5; e.preventDefault(); }
  });

  // ---------- velocidad y repetir línea ----------
  const RATES = [0.5, 0.75, 1, 1.25];
  function setSpeed(r, announce = false) {
    el.audio.playbackRate = r;
    el.audio.preservesPitch = true;
    document.querySelectorAll('#speeds button').forEach((b) => b.setAttribute('aria-pressed', String(Number(b.dataset.rate) === r)));
    markSyncBtn();
    if (announce) toast(T('t.speed', { n: I.get() === 'es' ? String(r).replace('.', ',') : r }), { ms: 1400 });
  }
  function stepSpeed(d) {
    const i = RATES.indexOf(el.audio.playbackRate);
    const next = RATES[Math.max(0, Math.min(RATES.length - 1, (i < 0 ? 2 : i) + d))];
    if (next !== el.audio.playbackRate) setSpeed(next, true);
  }
  $('speeds').addEventListener('click', (e) => {
    const b = e.target.closest('[data-rate]');
    if (b) setSpeed(Number(b.dataset.rate));
  });

  function toggleLoop() {
    if (state.loop >= 0) return stopLoop();
    const i = state.active >= 0 ? state.active : 0;
    if (!state.cur?.synced || !state.cur.lines[i]) return;
    state.loop = i;
    el.lyrics.children[i]?.classList.add('looping');
    $('loopLine').checked = true;
    markSyncBtn();
    toast(T('t.loopOn'), { ms: 2200 });
  }
  function stopLoop(silent = false) {
    if (state.loop < 0) return;
    el.lyrics.children[state.loop]?.classList.remove('looping');
    state.loop = -1;
    $('loopLine').checked = false;
    markSyncBtn();
    if (!silent) toast(T('t.loopOff'), { ms: 1600 });
  }
  $('loopLine').addEventListener('change', (e) => (e.target.checked ? toggleLoop() : stopLoop()));
  function checkLoop() {
    if (state.loop < 0) return;
    const l = state.cur.lines[state.loop];
    const start = l.t + offset(), end = (l.end ?? l.t + 4) + offset();
    if (el.audio.currentTime >= end || el.audio.currentTime < start - 0.5) el.audio.currentTime = start;
  }
  // El icono se ilumina si la velocidad o la repetición no están en su estado normal.
  function markSyncBtn() {
    $('btnSync').classList.toggle('has-state', state.loop >= 0 || el.audio.playbackRate !== 1 || offset() !== 0);
  }
  setSpeed(1);

  // ---------- sincronía ----------
  function updateOffset() {
    const o = offset();
    const s = o.toFixed(1);
    $('offsetOut').textContent = `${o > 0 ? '+' : ''}${I.get() === 'es' ? s.replace('.', ',') : s} s`;
    markSyncBtn();
  }
  $('syncPop').addEventListener('click', (e) => {
    const b = e.target.closest('[data-off]');
    if (!b || !state.cur) return;
    state.cur.offset = Math.round((offset() + Number(b.dataset.off)) * 10) / 10;
    updateOffset();
    syncTick(true);
    save();
  });
  $('btnOffsetReset').onclick = () => { if (state.cur) { state.cur.offset = 0; updateOffset(); syncTick(true); save(); } };

  // ---------- menús ----------
  function togglePop(btnId, popId) {
    const pop = $(popId);
    const open = pop.hidden || pop.classList.contains('closing');
    closePops();
    if (open) {
      clearTimeout(pop._closeTimer);
      pop.classList.remove('closing');
      pop.hidden = false;
      $(btnId).setAttribute('aria-expanded', 'true');
      pop.querySelector('button')?.focus({ preventScroll: true });
    }
  }
  function closePops() {
    for (const [b, p] of [['btnLyricsMenu', 'lyricsMenu'], ['btnSync', 'syncPop'], ['btnExport', 'exportMenu']]) {
      const pop = $(p);
      $(b).setAttribute('aria-expanded', 'false');
      if (pop.hidden || pop.classList.contains('closing')) continue;
      // Salida más rápida que la entrada; se puede reabrir a mitad.
      pop.classList.add('closing');
      pop._closeTimer = setTimeout(() => { pop.hidden = true; pop.classList.remove('closing'); }, 110);
    }
  }
  $('btnLyricsMenu').onclick = (e) => { e.stopPropagation(); togglePop('btnLyricsMenu', 'lyricsMenu'); };
  $('btnSync').onclick = (e) => { e.stopPropagation(); togglePop('btnSync', 'syncPop'); };
  $('btnExport').onclick = (e) => { e.stopPropagation(); togglePop('btnExport', 'exportMenu'); };
  document.addEventListener('click', (e) => { if (!e.target.closest('.menu, .pop')) closePops(); });

  $('lyricsMenu').addEventListener('click', (e) => {
    const b = e.target.closest('[data-act]');
    if (b) { closePops(); runAction(b.dataset.act); }
  });
  $('searchForm').addEventListener('click', (e) => {
    const b = e.target.closest('[data-act]');
    if (b) runAction(b.dataset.act);
  });
  $('btnSyncAI').onclick = () => runAction('transcribe');

  async function runAction(act) {
    const c = state.cur;
    if (!c) return;
    if (act === 'research') {
      const sf = $('searchForm');
      sf.hidden = false;
      sf.title.value = c.title || '';
      sf.artist.value = c.artist || '';
      state.searchMsgKey = 'search.other';
      $('searchMsg').textContent = T(state.searchMsgKey);
      sf.title.focus();
      return;
    }
    if (act === 'remove') {
      await call(api.library.remove(c.id));
      el.audio.pause();
      el.audio.removeAttribute('src');
      state.cur = null;
      setView('empty');
      refreshLibrary();
      toast(T('t.removed'));
      return;
    }
    if (act === 'import') {
      try {
        const r = await call(api.lyrics.import());
        if (!r) return;
        Object.assign(c, { lines: r.lines, synced: r.synced, source: 'lrc', lang: null });
        await processAgain({});
      } catch (e) { errorToast(e); }
      return;
    }
    if (act === 'transcribe') {
      if (!state.settings.hasKey) return toast(T('t.needKeyListen'), { error: true, action: { label: T('t.openSettings'), fn: () => openDrawer('ai') } });
      if (!state.buffer) return toast(T('t.cantDecode'), { error: true });
      // Si ya hay letra sin tiempos, se conserva su texto y se sincroniza con el audio.
      const official = c.lines.length && !c.synced ? c.lines.map((l) => ({ text: l.text })) : null;
      await processAgain({ transcribe: true, official, identify: !official });
      return;
    }
    if (act === 'retranslate') await processAgain({});
  }

  async function processAgain({ transcribe = false, official = null, identify = false }) {
    const job = newJob();
    el.audio.pause();
    resetSteps(by(state.cur.title, state.cur.artist));
    stepState('read', 'done');
    stepState('lyrics', transcribe ? 'skip' : 'done');
    setView('work');
    try {
      if (transcribe) await transcribeCurrent(job, official, { identify, trim: (state.cur.duration || 0) < 100, query: { title: state.cur.title, artist: state.cur.artist } });
      else stepState('transcribe', 'skip');
      if (state.job !== job) return;
      await translateCurrent(job);
      if (state.job !== job) return;
      await save();
      showLyrics({ play: true });
    } catch (e) {
      if (state.job !== job) return;
      errorToast(e);
      showLyrics();
    }
  }

  $('searchForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.currentTarget;
    const title = f.title.value.trim(), artist = f.artist.value.trim();
    if (!title) return f.title.focus();
    const job = newJob();
    resetSteps(by(title, artist));
    stepState('read', 'done');
    setView('work');
    try {
      const found = await call(api.lyrics.find({ title, artist, duration: state.cur.duration, clip: (state.cur.duration || 0) < 100 }));
      if (state.job !== job) return;
      if (!found) {
        toast(T('t.lrclibMissing'), { error: true });
        showLyrics();
        $('searchForm').hidden = false;
        return;
      }
      Object.assign(state.cur, { title: found.match.title, artist: found.match.artist, lang: null });
      stepState('lyrics', 'done', `${found.match.artist}, ${found.match.title}`);
      const isClip = (state.cur.duration || 0) < 100 || (found.match.duration && state.cur.duration && found.match.duration - state.cur.duration > 20);
      if (found.synced && !(isClip && state.settings.hasKey && state.buffer)) {
        Object.assign(state.cur, { lines: found.lines, synced: !isClip, source: isClip ? 'lrclib-plain' : 'lrclib' });
        stepState('transcribe', 'skip');
      } else if (state.settings.hasKey && state.buffer) {
        await transcribeCurrent(job, found.lines, { trim: (state.cur.duration || 0) < 100 });
      } else {
        Object.assign(state.cur, { lines: found.lines, synced: false, source: 'lrclib-plain' });
        stepState('transcribe', 'skip');
      }
      if (state.job !== job) return;
      await translateCurrent(job);
      if (state.job !== job) return;
      await save();
      showLyrics({ play: true });
    } catch (err) {
      if (state.job !== job) return;
      errorToast(err);
      showLyrics();
    }
  });

  $('btnCancel').onclick = async () => {
    const job = state.job;
    state.job = null;
    await api.ai.cancel(job);
    if (state.cur?.lines?.length) { await save(); showLyrics(); }
    else { setView('empty'); el.audio.pause(); }
  };

  $('exportMenu').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-f]');
    if (!b || !state.cur) return;
    closePops();
    const c = state.cur;
    if (!c.lines.length) return toast(T('t.nothingExport'), { error: true });
    if (b.dataset.f === 'srt' && !c.synced) return toast(T('t.noTimes'), { error: true });
    if (b.dataset.m !== 'original' && !c.lines.some((l) => l.tr)) return toast(T('t.noTranslation'), { error: true });
    try {
      const name = await call(api.exportSubs({ lines: c.lines, format: b.dataset.f, mode: b.dataset.m, offset: offset(), meta: { title: c.title, artist: c.artist } }));
      if (name) toast(T('t.exported', { name }));
    } catch (err) { errorToast(err); }
  });

  // ---------- abrir archivos ----------
  async function pickFile() {
    try {
      const info = await call(api.file.open());
      if (info) await openFile(info);
    } catch (e) { errorToast(e); }
  }
  $('btnOpen').onclick = pickFile;
  $('btnOpenHero').onclick = pickFile;

  let dragDepth = 0;
  window.addEventListener('dragenter', (e) => { e.preventDefault(); if (++dragDepth === 1) el.app.classList.add('dragging'); });
  window.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; el.app.classList.remove('dragging'); } });
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', async (e) => {
    e.preventDefault();
    dragDepth = 0;
    el.app.classList.remove('dragging');
    const file = e.dataTransfer.files[0];
    if (!file) return;
    const p = api.file.pathFor(file);
    if (/\.(lrc|txt)$/i.test(file.name) && state.cur) return toast(T('t.lrcHint'), { action: { label: T('t.loadLrc'), fn: () => runAction('import') } });
    try { await openFile(await call(api.file.info(p))); } catch (err) { errorToast(err); }
  });

  // ---------- en vivo ----------
  async function startLive() {
    if (!state.settings.hasKey) {
      toast(T('t.liveNeedsKey'), { error: true, action: { label: T('t.openSettings'), fn: () => openDrawer('ai') } });
      return;
    }
    if (state.capture) return;
    el.audio.pause();
    newJob();
    $('liveCues').innerHTML = '';
    $('liveHint').hidden = false;
    state.liveQueue = [];
    state.liveLast = '';
    state.liveLang = null;
    state.liveLastCue = null;
    const prevView = state.view;
    setView('live');
    const meter = $('liveMeter');
    const chunk = { fast: [2.5, 6], balanced: [3.5, 9], precise: [5, 13] }[state.settings.liveChunk] || [3.5, 9];
    const cap = new A.SystemCapture({
      minSec: chunk[0],
      maxSec: chunk[1],
      onChunk: (c) => {
        state.liveQueue.push(c);
        if (state.liveQueue.length > 2) state.liveQueue.shift(); // mejor saltar una frase que ir con retraso
        pumpLive();
      },
      onLevel: (v) => { meter.style.transform = `scaleX(${v})`; },
      onEnd: () => { if (state.capture === cap) { state.capture = null; if (state.view === 'live') setView(state.cur ? 'lyrics' : 'empty'); } },
    });
    try {
      await cap.start();
      state.capture = cap;
    } catch (e) {
      setView(prevView === 'live' ? 'empty' : prevView);
      const msg = e.code === 'noAudio' ? T('t.liveNoAudio') : e.message;
      toast(e.name === 'NotAllowedError' ? T('t.liveDenied') : T('t.liveFail', { msg }), { error: true });
    }
  }

  async function pumpLive() {
    if (state.liveBusy) return;
    state.liveBusy = true;
    while (state.liveQueue.length && state.capture) {
      const c = state.liveQueue.shift();
      try {
        const r = await call(api.ai.transcribe({ wav: c.wav, offset: 0, language: state.liveLang || undefined, prompt: state.liveLast }));
        const text = r.lines.map((l) => l.text).join(' ').trim();
        if (!text) continue;
        if (r.language && !state.liveLang) state.liveLang = r.language;
        state.liveLast = text;
        let tr = text;
        const s = state.settings;
        if (state.liveLang !== s.target && (s.hasKey || s.translator === 'ollama')) {
          try { tr = (await call(api.ai.translate({ texts: [text], target: s.target, context: 'live speech or song' })))[0] || text; } catch { /* solo el original */ }
        }
        addLiveCue(text, tr);
      } catch (e) {
        if (e.kind === 'auth') { errorToast(e); stopLive(); break; }
      }
    }
    state.liveBusy = false;
  }

  function addLiveCue(orig, tr) {
    $('liveHint').hidden = true;
    const ol = $('liveCues');
    const li = document.createElement('li');
    li.innerHTML = lineHTML({ text: orig, tr });
    ol.appendChild(li);
    while (ol.children.length > 6) ol.firstElementChild.remove();
    state.liveLastCue = { orig, tr, mode: overlayMode() };
    if (state.overlay) api.overlay.cue(state.liveLastCue);
  }

  function stopLive() {
    if (!state.capture) return;
    const cap = state.capture;
    state.capture = null;
    cap.stop();
    if (state.overlay) api.overlay.cue({ orig: '', tr: '', mode: state.settings.view });
    setView(state.cur ? 'lyrics' : 'empty');
  }

  $('btnLive').onclick = () => (state.capture ? stopLive() : startLive());
  $('btnLiveHero').onclick = startLive;
  $('btnLiveStop').onclick = stopLive;

  // ---------- ajustes ----------
  // Guardado automático: cada cambio se aplica y se guarda al momento (criterio de la skill ux-settings).
  const form = $('settingsForm');
  const FIELDS = {
    radio: ['uiLang', 'provider', 'translator', 'theme', 'accent', 'lyricSize', 'lyricAlign', 'trStyle', 'motion', 'liveChunk', 'overlayView', 'overlayColor', 'overlayPos'],
    check: ['askLang', 'review', 'autoplay', 'clickSeek', 'lineBar', 'overlayLocked', 'overlayShortcut'],
    num: ['followDelay', 'overlaySize', 'overlayBg'],
    text: ['target', 'ollamaModel', 'ollamaUrl', 'sttModel', 'chatModel'],
  };
  let currentTab = 'general';

  function fillForm() {
    const s = state.settings;
    for (const k of FIELDS.radio) {
      const r = form.querySelector(`input[name="${k}"][value="${s[k] ?? ''}"]`);
      if (r) r.checked = true;
    }
    if (!s.uiLang) form.querySelector('input[name="uiLang"][value="es"]').checked = true;
    for (const k of FIELDS.check) form[k].checked = Boolean(s[k]);
    for (const k of FIELDS.num) form[k].value = s[k];
    for (const k of FIELDS.text) form[k].value = s[k] || '';
    form.apiKey.value = '';
    form.apiKey.placeholder = T(s.hasKey ? 'set.keySaved' : 'set.keyPh');
  }

  function readForm() {
    const p = {};
    for (const k of FIELDS.radio) {
      const r = form.querySelector(`input[name="${k}"]:checked`);
      if (r) p[k] = r.value;
    }
    for (const k of FIELDS.check) p[k] = form[k].checked;
    for (const k of FIELDS.num) p[k] = Number(form[k].value);
    for (const k of FIELDS.text) p[k] = form[k].value.trim();
    return p;
  }

  function showTab(tab) {
    currentTab = tab;
    document.querySelectorAll('.set-nav button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === tab)));
    document.querySelectorAll('.set-pane').forEach((p) => { p.hidden = p.dataset.pane !== tab; });
    form.scrollTop = 0;
    if (tab === 'data') updateLibStats();
  }
  document.querySelector('.set-nav').addEventListener('click', (e) => {
    const b = e.target.closest('[data-tab]');
    if (b) showTab(b.dataset.tab);
  });
  document.querySelector('.set-nav').addEventListener('keydown', (e) => {
    if (!['ArrowDown', 'ArrowUp'].includes(e.key)) return;
    const tabs = [...document.querySelectorAll('.set-nav button')];
    const i = tabs.findIndex((b) => b.dataset.tab === currentTab);
    const next = tabs[(i + (e.key === 'ArrowDown' ? 1 : tabs.length - 1)) % tabs.length];
    showTab(next.dataset.tab);
    next.focus();
    e.preventDefault();
  });

  function openDrawer(tab) {
    fillForm();
    syncForm();
    showTab(typeof tab === 'string' ? tab : currentTab);
    $('scrim').hidden = false;
    requestAnimationFrame(() => { $('scrim').classList.add('on'); $('drawer').classList.add('on'); });
    $('drawer').setAttribute('aria-hidden', 'false');
    setTimeout(() => $('drawer').focus({ preventScroll: true }), 80);
  }
  function closeDrawer() {
    $('scrim').classList.remove('on');
    $('drawer').classList.remove('on');
    $('drawer').setAttribute('aria-hidden', 'true');
    setTimeout(() => { $('scrim').hidden = true; }, 260);
  }

  // Textos y vistas previas que dependen del formulario.
  function syncForm() {
    const p = form.querySelector('input[name="provider"]:checked')?.value || 'groq';
    const tr = form.querySelector('input[name="translator"]:checked')?.value;
    $('ollamaFields').classList.toggle('off', tr !== 'ollama');
    $('sizeOut').textContent = `${form.overlaySize.value} px`;
    $('bgOut').textContent = `${form.overlayBg.value} %`;
    $('followOut').textContent = T('set.seconds', { n: form.followDelay.value });
    $('sttModel').placeholder = p === 'openai' ? 'whisper-1' : 'whisper-large-v3';
    $('chatModel').placeholder = p === 'openai' ? 'gpt-4.1' : 'openai/gpt-oss-120b';
    $('btnGetKey').textContent = T(p === 'openai' ? 'set.getOpenai' : 'set.getGroq');
    const v = readForm();
    applyAppearance(v);
    const ov = $('ovPreview');
    const COLOR = { white: 'oklch(0.97 0.012 60)', yellow: 'oklch(0.92 0.15 100)', accent: 'var(--butter)' };
    ov.style.setProperty('--ov-size', `${Math.round(v.overlaySize * 0.6)}px`);
    ov.style.setProperty('--ov-a', String(v.overlayBg / 100));
    ov.style.setProperty('--ov-c', COLOR[v.overlayColor] || COLOR.white);
    ov.classList.toggle('top', v.overlayPos === 'top');
    const mode = v.overlayView === 'follow' ? state.settings.view : v.overlayView;
    ov.dataset.mode = mode;
    ov.querySelector('.ovp-or').hidden = mode === 'translated';
    ov.querySelector('.ovp-tr').hidden = mode === 'original';
  }

  let saveTimer = null;
  function flashSaved() {
    const a = $('autosave');
    a.textContent = T('set.saved');
    a.classList.add('flash');
    clearTimeout(a._t);
    a._t = setTimeout(() => { a.classList.remove('flash'); a.textContent = T('set.autosave'); }, 1400);
  }

  async function saveSettings() {
    const before = state.settings;
    const patch = readForm();
    const key = form.apiKey.value.trim();
    if (key) patch.apiKey = key;
    state.settings = await call(api.settings.set(patch));
    if (key) {
      form.apiKey.value = '';
      form.apiKey.placeholder = T('set.keySaved');
      if (!before.hasKey && state.cur && !state.cur.lines.length && state.buffer) {
        toast(T('t.retryWithKey'), { action: { label: T('t.retryNow'), fn: () => { closeDrawer(); runAction('transcribe'); } } });
      }
    }
    applySettings();
    syncForm();
    flashSaved();
    if (state.cur && state.view === 'lyrics' && before.target !== state.settings.target && state.cur.lines.length) {
      toast(T('t.targetChanged', { to: I.langName(state.settings.target) }), { action: { label: T('t.translateNow'), fn: () => runAction('retranslate') } });
    }
    if (before.lyricSize !== state.settings.lyricSize || before.lyricAlign !== state.settings.lyricAlign) {
      requestAnimationFrame(() => scrollToActive(true));
    }
  }

  form.addEventListener('input', (e) => {
    syncForm();
    if (e.target.name === 'apiKey') return; // la clave se guarda al salir del campo
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => saveSettings().catch(errorToast), e.target.type === 'range' ? 300 : 0);
  });
  form.addEventListener('change', (e) => {
    if (e.target.name === 'apiKey' && e.target.value.trim()) saveSettings().catch(errorToast);
    if (e.target.name === 'uiLang') {
      state.settings.uiLang = e.target.value;
      applyLang();
      syncForm();
    }
  });
  form.addEventListener('submit', (e) => e.preventDefault());
  $('btnGetKey').onclick = () => api.openExternal(form.querySelector('input[name="provider"]:checked')?.value === 'openai' ? 'https://platform.openai.com/api-keys' : 'https://console.groq.com/keys');

  $('btnTest').onclick = async () => {
    const b = $('btnTest');
    b.disabled = true;
    b.textContent = T('set.testing');
    try {
      await saveSettings();
      await call(api.settings.test());
      toast(T('t.connOk'));
    } catch (e) { errorToast(e); }
    b.disabled = false;
    b.textContent = T('set.test');
  };

  // Acciones que borran: dos pulsaciones, sin ventanas emergentes.
  function armed(btn, labelKey, action) {
    btn.addEventListener('click', async () => {
      if (!btn.classList.contains('armed')) {
        btn.classList.add('armed');
        btn.textContent = T('data.confirm');
        clearTimeout(btn._t);
        btn._t = setTimeout(() => { btn.classList.remove('armed'); btn.textContent = T(labelKey); }, 3500);
        return;
      }
      clearTimeout(btn._t);
      btn.classList.remove('armed');
      btn.textContent = T(labelKey);
      try { await action(); } catch (e) { errorToast(e); }
    });
  }
  armed($('btnClearLib'), 'data.clearLib', async () => {
    await call(api.library.clear());
    if (state.cur) { el.audio.pause(); el.audio.removeAttribute('src'); state.cur = null; setView('empty'); }
    await refreshLibrary();
    updateLibStats();
    toast(T('data.cleared'));
  });
  armed($('btnReset'), 'data.reset', async () => {
    state.settings = await call(api.settings.reset());
    applySettings();
    fillForm();
    syncForm();
    toast(T('data.didReset'));
  });
  async function updateLibStats() {
    const items = await call(api.library.list()).catch(() => []);
    $('libStats').textContent = T('data.stats', { n: items.length });
    $('btnClearLib').disabled = !items.length;
  }

  $('btnSettings').onclick = () => openDrawer();
  $('btnHeroKey').onclick = () => openDrawer('ai');
  $('btnDrawerClose').onclick = closeDrawer;
  $('scrim').onclick = closeDrawer;

  // ---------- soporte: reportar un problema ----------
  let supportInfo = null;
  let reportCtx = null;
  const report = $('report');

  async function getSupportInfo() {
    supportInfo = await call(api.support.info()).catch(() => supportInfo || { invite: '', serverName: '', version: '', hasIssues: false });
    return supportInfo;
  }

  async function buildReportText() {
    return call(api.support.report({ context: reportCtx, note: $('repNote').value.trim() }));
  }

  async function openReport(ctx) {
    reportCtx = ctx || null;
    const info = await getSupportInfo();
    $('repIntro').textContent = info.serverName ? T('sup.intro', { server: info.serverName }) : T('sup.introNoName');
    $('repError').hidden = !ctx?.message;
    $('repErrorText').textContent = ctx?.message || '';
    $('repNote').value = '';
    report.querySelectorAll('.report-steps li').forEach((li) => li.classList.remove('done'));
    $('btnRepCopy').querySelector('span').textContent = T('sup.copy');
    // Con invitación: Discord + ticket. Sin ella: aviso en GitHub con el informe ya pegado.
    const useGithub = !info.invite && info.hasIssues;
    $('repStepDiscord').hidden = useGithub;
    $('repStepTicket').hidden = useGithub;
    $('repStepGithub').hidden = !useGithub;
    if (useGithub) $('repIntro').textContent = T('sup.introGh');
    const d = $('btnRepDiscord');
    d.disabled = !info.invite;
    d.title = info.invite ? '' : T('sup.noInvite');
    $('repText').textContent = await buildReportText().catch(() => '');
    if ($('drawer').classList.contains('on')) closeDrawer();
    closePops();
    if (!report.open) report.showModal();
    setTimeout(() => $('repNote').focus(), 60);
  }

  $('repNote').addEventListener('input', () => {
    clearTimeout($('repNote')._t);
    $('repNote')._t = setTimeout(async () => { $('repText').textContent = await buildReportText().catch(() => ''); }, 300);
  });
  $('btnRepCopy').onclick = async () => {
    try {
      const text = await buildReportText();
      $('repText').textContent = text;
      await call(api.support.copy(text));
      $('btnRepCopy').querySelector('span').textContent = T('sup.copied');
      $('btnRepCopy').closest('li').classList.add('done');
    } catch (e) { toast(e.message, { error: true }); }
  };
  $('btnRepDiscord').onclick = async () => {
    try {
      await call(api.support.discord());
      $('btnRepDiscord').closest('li').classList.add('done');
    } catch (e) { toast(e.message, { error: true }); }
  };
  $('btnRepGithub').onclick = async () => {
    try {
      const body = await buildReportText();
      const title = `[${supportInfo?.version || ''}] ${(reportCtx?.message || T('sup.title')).slice(0, 90)}`;
      await call(api.support.github({ title, body }));
      $('btnRepGithub').closest('li').classList.add('done');
    } catch (e) { toast(e.message, { error: true }); }
  };
  // Cerrar al pulsar fuera del cuadro.
  report.addEventListener('click', (e) => { if (e.target === report) report.close(); });

  $('btnHelp').onclick = () => openDrawer('help');
  $('btnHelpReport').onclick = () => openReport(null);
  $('btnLogs').onclick = () => api.support.logs();
  getSupportInfo().then((i) => { $('appVersion').textContent = i.version ? T('help.version', { v: i.version }) : ''; });

  // Fallos inesperados de la interfaz: se registran y se ofrece reportarlos (como mucho un aviso cada 10 s).
  let lastCrashToast = 0;
  function unexpected(where, err) {
    const message = err?.message || String(err || 'Error');
    api.support.logError({ where, message, stack: err?.stack });
    if (Date.now() - lastCrashToast < 10000) return;
    lastCrashToast = Date.now();
    const ctx = errorContext(message);
    toast(T('sup.crash'), { error: true, action: { label: T('sup.report'), fn: () => openReport(ctx) } });
  }
  window.addEventListener('error', (e) => unexpected(e.filename ? e.filename.split('/').pop() + ':' + e.lineno : 'ventana', e.error || e.message));
  window.addEventListener('unhandledrejection', (e) => unexpected('promesa', e.reason));
  api.support.onCrash((c) => unexpected(c.where, { message: c.message }));

  // ---------- aviso sin clave ----------
  $('btnCtaKey').onclick = () => openDrawer('ai');
  $('btnCtaLive').onclick = () => startLive();

  // ---------- etiquetas de los botones de icono ----------
  const tip = document.createElement('div');
  tip.className = 'tip';
  tip.setAttribute('role', 'tooltip');
  document.body.appendChild(tip);
  let tipTimer = null, tipWarmUntil = 0, tipFor = null;
  function showTip(btn) {
    const text = btn.getAttribute('aria-label');
    if (!text || btn.getAttribute('aria-expanded') === 'true') return;
    tipFor = btn;
    const warm = Date.now() < tipWarmUntil;
    clearTimeout(tipTimer);
    tipTimer = setTimeout(() => {
      if (tipFor !== btn) return;
      tip.textContent = text;
      const r = btn.getBoundingClientRect();
      const w = tip.offsetWidth;
      const x = Math.min(window.innerWidth - w / 2 - 8, Math.max(w / 2 + 8, r.left + r.width / 2));
      tip.style.left = `${x}px`;
      tip.style.top = `${r.top - 34 < 8 ? r.bottom + 8 : r.top - 34}px`;
      tip.classList.toggle('instant', warm);
      tip.classList.add('on');
    }, warm ? 0 : 400);
  }
  function hideTip() {
    clearTimeout(tipTimer);
    if (tip.classList.contains('on')) tipWarmUntil = Date.now() + 600;
    tip.classList.remove('on');
    tipFor = null;
  }
  document.querySelectorAll('.icon-btn, .play').forEach((b) => {
    b.addEventListener('pointerenter', (e) => { if (e.pointerType === 'mouse') showTip(b); });
    b.addEventListener('pointerleave', hideTip);
    b.addEventListener('pointerdown', hideTip);
    b.addEventListener('focus', () => { if (b.matches(':focus-visible')) showTip(b); });
    b.addEventListener('blur', hideTip);
  });

  // ---------- teclado ----------
  document.addEventListener('keydown', (e) => {
    if (!$('intro').hidden || report.open) return;
    if (e.key === 'Escape') { closePops(); if ($('drawer').classList.contains('on')) closeDrawer(); return; }
    if (e.target.closest('input, select, textarea') || $('drawer').classList.contains('on')) return;
    if (state.view === 'lyrics') {
      if (e.code === 'Space') { e.preventDefault(); $('btnPlay').click(); }
      if (e.key === 'ArrowLeft' && e.target === document.body) $('btnBack').click();
      if (e.key === 'ArrowRight' && e.target === document.body) $('btnFwd').click();
    }
    if (['lyrics', 'live'].includes(state.view) && !e.ctrlKey && !e.altKey) {
      const m = { 1: 'original', 2: 'translated', 3: 'both' }[e.key];
      if (m) {
        el.seg.classList.add('instant');
        setMode(m);
        requestAnimationFrame(() => requestAnimationFrame(() => el.seg.classList.remove('instant')));
      }
    }
    if (e.ctrlKey && e.key.toLowerCase() === 'o') { e.preventDefault(); pickFile(); }
    if (e.ctrlKey && e.key === ',') { e.preventDefault(); openDrawer(); }
    if (e.ctrlKey || e.altKey || e.metaKey) return;
    if (state.view === 'lyrics') {
      if (e.key.toLowerCase() === 'r') toggleLoop();
      if (e.key === '[') stepSpeed(-1);
      if (e.key === ']') stepSpeed(1);
    }
    if (['lyrics', 'live'].includes(state.view) && e.key.toLowerCase() === 'f') $('btnFloat').click();
  });

  // ---------- inicio ----------
  (async function init() {
    try {
      await loadSettings();
      await refreshLibrary();
    } catch (e) { errorToast(e); }
    setView('empty');
    if (document.fonts) document.fonts.ready.then(() => { buildSegInd(); placeSeg(); });
    const lang = await runIntro();
    if (lang) {
      await chooseLang(lang);
      if (!state.settings.hasKey && state.settings.translator !== 'ollama') await keyStep();
      hideIntro();
    }
  })();

  window.__verso = { state, setView, openItem, openFile, keyStep, showLyrics, addLiveCue, setMode, openDrawer, startEdit, openReport, errorToast };
})();
