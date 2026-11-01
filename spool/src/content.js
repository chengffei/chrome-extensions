// Spool panel: injected on bilibili video pages, opened from the toolbar
// icon. Runs only on the user's click and only with the user's own session.
(function () {
  'use strict';
  if (globalThis.__spoolLoaded) return;
  globalThis.__spoolLoaded = true;

  const C = globalThis.SpoolCore;
  const M = globalThis.SpoolMux;
  const t = (key, subs) => chrome.i18n.getMessage(key, subs) || key;

  // Fallback without the File System Access API keeps the whole file in
  // memory, so it is capped.
  const MEMORY_LIMIT = 1024 * 1024 * 1024;

  const client = C.createClient(async (url) => {
    const res = await fetch(url, { credentials: 'include' });
    if (!res.ok) { const e = new Error('HTTP ' + res.status); e.status = res.status; throw e; }
    return res.json();
  });
  // CDN requests: no cookies; the browser adds the bilibili Referer itself.
  const CDN_INIT = { credentials: 'omit' };

  const state = {
    host: null, root: null, href: '', info: null, account: null, options: [],
    selected: null, codecPref: 'auto', busy: null,
  };

  // ---------- Settings ----------

  function codecOrder(pref) {
    if (pref === 'avc') return ['avc', 'hevc', 'av1'];
    if (pref === 'hevc') return ['hevc', 'avc', 'av1'];
    if (pref === 'av1') return ['av1', 'hevc', 'avc'];
    // Auto: HEVC plays natively on macOS; Windows needs a paid extension
    // for it, so H.264 is the safer default there.
    const mac = /Mac/i.test(navigator.platform || '') || /Mac OS X/.test(navigator.userAgent);
    return mac ? ['hevc', 'avc', 'av1'] : ['avc', 'hevc', 'av1'];
  }

  async function loadPrefs() {
    try {
      const v = await chrome.storage.local.get('codecPref');
      if (v.codecPref) state.codecPref = v.codecPref;
    } catch (_) { /* storage unavailable: keep default */ }
  }

  // ---------- DOM ----------

  function el(tag, attrs, ...children) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (k === 'class') node.className = v;
      else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
      else if (v !== false && v != null) node.setAttribute(k, v === true ? '' : v);
    }
    for (const c of children.flat()) if (c != null && c !== false) node.append(c);
    return node;
  }

  function ensureHost() {
    if (state.host && state.host.isConnected) return;
    state.host = el('div', { id: 'spool-host' });
    state.root = state.host.attachShadow({ mode: 'open' });
    // Inline styles: no web_accessible_resources, so pages cannot probe for the extension.
    state.root.append(el('style', {}, globalThis.SpoolPanelCss));
    state.root.append(el('div', { class: 'panel', role: 'dialog', 'aria-label': t('extName') }));
    document.documentElement.append(state.host);
  }

  function panel() { return state.root.querySelector('.panel'); }

  function render(...body) {
    const p = panel();
    p.replaceChildren(
      el('header', {},
        el('strong', {}, t('extName')),
        el('button', { class: 'icon', title: t('close'), 'aria-label': t('close'), onclick: close }, '×')),
      ...body,
      el('footer', {}, t('disclaimer')));
  }

  function close() {
    if (state.busy) return;
    if (state.host) state.host.remove();
    state.host = null;
  }

  function fmtSize(bytes) {
    if (!bytes) return '';
    return bytes >= 1e9 ? (bytes / 1e9).toFixed(1) + ' GB' : Math.max(1, Math.round(bytes / 1e6)) + ' MB';
  }

  function accountLine() {
    const a = state.account;
    if (!a) return '';
    if (!a.loggedIn) return t('signedOut');
    return a.vip ? t('signedInVip', [a.name]) : t('signedInBasic', [a.name]);
  }

  // ---------- Loading ----------

  async function open() {
    ensureHost();
    if (state.busy) return;
    const page = C.parseVideoPage(location.href);
    if (!page) { render(el('p', { class: 'msg' }, t('notVideoPage'))); return; }
    render(el('p', { class: 'msg' }, t('loading')));
    try {
      await loadPrefs();
      state.account = await client.account();
      state.info = await client.view(page);
      const play = await client.playurl(state.info);
      state.dash = play.dash;
      state.href = location.href;
      rebuildOptions();
      renderChoose();
    } catch (e) {
      renderError(e);
    }
  }

  function rebuildOptions() {
    const keep = state.selected && state.selected.qn;
    state.options = C.listOptions(state.dash, codecOrder(state.codecPref));
    state.selected = state.options.find((o) => o.qn === keep) || C.defaultOption(state.options);
  }

  function errorText(e) {
    const map = {
      needLogin: 'errNeedLogin', riskControl: 'errRisk', noPermission: 'errNoPermission',
      notFound: 'errNotFound', noDash: 'errNoDash', network: 'errNetwork', tooLarge: 'errTooLarge',
    };
    return t(map[e && e.kind] || 'errGeneric');
  }

  function renderError(e) {
    console.warn('[Spool]', e);
    render(
      el('p', { class: 'msg error' }, errorText(e)),
      el('p', { class: 'detail' }, String((e && (e.detail || e.message)) || e)),
      el('div', { class: 'actions' }, el('button', { class: 'primary', onclick: open }, t('retry'))));
  }

  // ---------- Choosing ----------

  function renderChoose() {
    const info = state.info;
    const rows = state.options.map((o) => {
      const res = o.video.height ? `${o.video.width}×${o.video.height}` : '';
      const size = fmtSize(C.estimateBytes(o, info.duration));
      const meta = [res, o.video.codec.toUpperCase(), o.audio && o.audio.label, size && '≈ ' + size].filter(Boolean).join(' · ');
      return el('label', { class: 'row' + (o === state.selected ? ' on' : '') },
        el('input', {
          type: 'radio', name: 'q', checked: o === state.selected,
          onchange: () => { state.selected = o; renderChoose(); },
        }),
        el('span', { class: 'q' }, o.label),
        el('span', { class: 'meta' }, meta),
        o.merge ? null : el('span', { class: 'note' }, t('dvNote')));
    });

    const codecSelect = el('select', {
      onchange: async (ev) => {
        state.codecPref = ev.target.value;
        try { await chrome.storage.local.set({ codecPref: state.codecPref }); } catch (_) { /* ignore */ }
        rebuildOptions();
        renderChoose();
      },
    }, ['auto', 'avc', 'hevc', 'av1'].map((v) =>
      el('option', { value: v, selected: v === state.codecPref }, t('codec_' + v))));

    render(
      el('p', { class: 'title' }, info.title + (info.partTitle ? ` · P${info.p} ${info.partTitle}` : '')),
      el('p', { class: 'account' }, accountLine()),
      el('div', { class: 'rows', role: 'radiogroup' }, rows),
      el('div', { class: 'field' }, el('span', {}, t('codec')), codecSelect),
      el('div', { class: 'actions' },
        el('button', { class: 'primary', onclick: start, disabled: !state.selected }, t('download'))));
  }

  // ---------- Downloading ----------

  function renderProgress(label, fraction, onCancel) {
    const pct = Math.round((fraction || 0) * 100);
    render(
      el('p', { class: 'title' }, state.info.title),
      el('p', { class: 'msg' }, `${label} ${pct}%`),
      el('div', { class: 'bar' }, el('div', { style: `width:${pct}%` })),
      el('div', { class: 'actions' }, el('button', { onclick: onCancel }, t('cancel'))));
  }

  // A WritableStream that keeps positioned writes in memory, for browsers
  // without showSaveFilePicker. Assembled into a Blob at the end.
  function memoryWritable() {
    const parts = [];
    let size = 0;
    const stream = new WritableStream({
      write(chunk) {
        const c = chunk instanceof Uint8Array ? { data: chunk, position: size } : chunk;
        parts.push({ data: c.data.slice(), position: c.position });
        size = Math.max(size, c.position + c.data.byteLength);
        if (size > MEMORY_LIMIT) throw Object.assign(new Error('too large'), { kind: 'tooLarge' });
      },
    });
    stream.toBlob = (type) => {
      const out = new Uint8Array(size);
      for (const p of parts) out.set(p.data, p.position);
      return new Blob([out], { type });
    };
    return stream;
  }

  function saveBlob(blob, name) {
    const url = URL.createObjectURL(blob);
    const a = el('a', { href: url, download: name });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }

  async function start() {
    const opt = state.selected;
    if (!opt || state.busy) return;
    if (location.href !== state.href) { await open(); return; }
    const base = C.fileBase(state.info, opt);
    const fsApi = typeof window.showSaveFilePicker === 'function';
    if (!fsApi && C.estimateBytes(opt, state.info.duration) > MEMORY_LIMIT) {
      renderError(Object.assign(new Error(t('errTooLarge')), { kind: 'tooLarge' }));
      return;
    }

    // Ask for the destination first, while the click still counts as a
    // user gesture.
    let targets;
    try {
      targets = fsApi ? await pickTargets(opt, base) : null;
    } catch (e) {
      if (e && e.name === 'AbortError') return; // user closed the dialog
      renderError(e);
      return;
    }

    const ctl = new AbortController();
    state.busy = ctl;
    const cancel = () => ctl.abort();
    let last = -1;
    const progress = (label) => (f) => {
      const pct = Math.floor(f * 100);
      if (pct !== last) { last = pct; renderProgress(label, f, cancel); }
    };
    renderProgress(t('preparing'), 0, cancel);

    try {
      if (opt.merge) {
        const writable = targets ? targets.video : memoryWritable();
        await M.remux({
          videoUrls: opt.video.urls,
          audioUrls: opt.audio ? opt.audio.urls : [],
          writable,
          duration: state.info.duration,
          requestInit: CDN_INIT,
          signal: ctl.signal,
          onProgress: progress(t('merging')),
        });
        if (!targets) saveBlob(writable.toBlob('video/mp4'), base + '.mp4');
        renderDone(t('done', [base + '.mp4']));
      } else {
        const vw = targets ? targets.video : memoryWritable();
        await M.saveRaw({ urls: opt.video.urls, writable: vw, requestInit: CDN_INIT, signal: ctl.signal, onProgress: progress(t('savingVideo')) });
        if (!targets) saveBlob(vw.toBlob('video/mp4'), base + '.video.m4s');
        if (opt.audio) {
          last = -1;
          const aw = targets ? targets.audio : memoryWritable();
          await M.saveRaw({ urls: opt.audio.urls, writable: aw, requestInit: CDN_INIT, signal: ctl.signal, onProgress: progress(t('savingAudio')) });
          if (!targets) saveBlob(aw.toBlob('audio/mp4'), base + '.audio.m4s');
        }
        renderDone(t('doneRaw'), ffmpegCommand(base, !!opt.audio));
      }
    } catch (e) {
      if (targets) for (const w of Object.values(targets)) { try { await w.abort(); } catch (_) { /* closed */ } }
      if (ctl.signal.aborted || (e && e.name === 'AbortError')) renderChoose();
      else renderError(e);
    } finally {
      state.busy = null;
    }
  }

  async function pickTargets(opt, base) {
    if (opt.merge) {
      const handle = await window.showSaveFilePicker({
        suggestedName: base + '.mp4',
        types: [{ description: 'MP4', accept: { 'video/mp4': ['.mp4'] } }],
      });
      return { video: await handle.createWritable() };
    }
    const dir = await window.showDirectoryPicker({ mode: 'readwrite', id: 'spool' });
    const out = {};
    out.video = await (await dir.getFileHandle(base + '.video.m4s', { create: true })).createWritable();
    if (opt.audio) out.audio = await (await dir.getFileHandle(base + '.audio.m4s', { create: true })).createWritable();
    return out;
  }

  function ffmpegCommand(base, hasAudio) {
    const q = (s) => '"' + s.replace(/(["\\$`])/g, '\\$1') + '"';
    return hasAudio
      ? `ffmpeg -i ${q(base + '.video.m4s')} -i ${q(base + '.audio.m4s')} -c copy -strict unofficial ${q(base + '.mp4')}`
      : `ffmpeg -i ${q(base + '.video.m4s')} -c copy -strict unofficial ${q(base + '.mp4')}`;
  }

  function renderDone(text, command) {
    const body = [el('p', { class: 'msg ok' }, text)];
    if (command) {
      const copy = el('button', {
        onclick: async () => {
          try { await navigator.clipboard.writeText(command); copy.textContent = t('copied'); } catch (_) { /* ignore */ }
        },
      }, t('copy'));
      body.push(el('p', { class: 'detail' }, t('ffmpegHint')), el('pre', {}, command), el('div', { class: 'actions' }, copy));
    }
    body.push(el('div', { class: 'actions' }, el('button', { class: 'primary', onclick: renderChoose }, t('back'))));
    render(...body);
  }

  // ---------- Messages ----------

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === 'spool:toggle') {
      if (state.host && state.host.isConnected && !state.busy) close();
      else open();
    }
  });
})();
