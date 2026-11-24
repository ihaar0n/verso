// Ventana flotante de subtítulos: siempre encima, transparente, arrastrable.
(function () {
  const api = window.verso;
  const cue = document.getElementById('cue');
  const orig = document.getElementById('orig');
  const tr = document.getElementById('tr');
  const hint = document.getElementById('hint');
  let shown = '';
  let timer = null;

  document.getElementById('close').onclick = () => api.overlay.close();

  api.overlay.onSettings((s) => {
    const I = window.I18N;
    I.set(s.lang || 'es');
    document.documentElement.lang = I.get();
    document.getElementById('dragTxt').textContent = I.t('ov.drag');
    document.getElementById('close').textContent = I.t('ov.close');
    document.getElementById('waitTxt').textContent = I.t('ov.wait');
    document.documentElement.style.setProperty('--size', `${s.size || 34}px`);
    const ACCENT = { mantequilla: 'oklch(0.89 0.12 92)', rosa: 'oklch(0.8 0.11 10)', mandarina: 'oklch(0.8 0.14 55)', menta: 'oklch(0.86 0.11 165)', cielo: 'oklch(0.84 0.09 235)' };
    const COLOR = { white: 'oklch(0.97 0.012 60)', yellow: 'oklch(0.92 0.15 100)', accent: ACCENT[s.accent] || ACCENT.mantequilla };
    const root = document.documentElement.style;
    root.setProperty('--text', COLOR[s.color] || COLOR.white);
    root.setProperty('--bg-a', String(Math.max(0, Math.min(100, s.bg ?? 78)) / 100));
    document.body.classList.toggle('top', s.pos === 'top');
    document.body.classList.toggle('locked', Boolean(s.locked));
  });

  api.overlay.onCue((c) => {
    const mode = c.mode || 'both';
    document.body.dataset.mode = mode;
    const same = !c.tr || c.tr.trim().toLowerCase() === c.orig.trim().toLowerCase();
    const showOrig = mode !== 'translated' || !c.tr;
    const showTr = mode === 'translated' ? Boolean(c.tr) : mode === 'both' && !same;
    const key = `${mode}|${c.orig}|${c.tr}`;
    if (key === shown) return;
    shown = key;
    if (!c.orig) { cue.classList.add('empty'); return; }
    hint.hidden = true;
    // Cruce corto con un poco de desenfoque al cambiar de frase.
    cue.classList.add('swap');
    clearTimeout(timer);
    timer = setTimeout(() => {
      orig.textContent = c.orig;
      tr.textContent = c.tr || '';
      orig.hidden = !showOrig;
      tr.hidden = !showTr;
      cue.classList.remove('empty', 'swap');
    }, cue.classList.contains('empty') ? 0 : 120);
  });
})();
