// Spool popup: lists the videos found on the current tab and their
// downloads. All work happens in the service worker and offscreen document.
'use strict';

const t = (key, subs) => chrome.i18n.getMessage(key, subs) || key;
const $ = (id) => document.getElementById(id);
const BILI_VIDEO = /^https:\/\/www\.bilibili\.com\/video\//;

const view = { tab: null, items: [], jobs: [], bili: null, choice: {}, probing: new Set() };

function el(tag, attrs, ...children) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (k === 'class') n.className = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else if (v !== false && v != null) n.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c != null && c !== false) n.append(c);
  return n;
}

function fmtTime(sec) {
  if (!sec) return '';
  sec = Math.round(sec);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = String(sec % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

function fmtSize(bytes) {
  if (!bytes) return '';
  return bytes >= 1e9 ? (bytes / 1e9).toFixed(1) + ' GB' : Math.max(1, Math.round(bytes / 1e6)) + ' MB';
}

function shortName(url) {
  try {
    const u = new URL(url);
    const last = decodeURIComponent(u.pathname.split('/').filter(Boolean).pop() || u.hostname);
    return last.length > 28 ? last.slice(0, 25) + '…' : last;
  } catch (_) { return ''; }
}

const send = (msg) => chrome.runtime.sendMessage(msg);

// ---------- Loading ----------

async function init() {
  for (const n of document.querySelectorAll('[data-i18n]')) n.textContent = t(n.dataset.i18n);
  // ?tabId= lets tests and debugging open the popup as a normal page.
  const forced = Number(new URLSearchParams(location.search).get('tabId'));
  const tab = forced ? await chrome.tabs.get(forced) : (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
  view.tab = tab;
  $('title').textContent = tab && tab.title ? tab.title : '';
  if (!tab || !/^https?:/.test(tab.url || '')) return showEmpty(t('emptyPage'));
  if (SpoolDetect.isBlockedHost(new URL(tab.url).hostname)) return showEmpty(t('blockedSite'));
  if (BILI_VIDEO.test(tab.url)) loadBili();
  await refresh();
  chrome.runtime.onMessage.addListener((msg) => { if (msg && msg.type === 'spool:update') refresh(); });
}

async function refresh() {
  const r = await send({ type: 'list', tabId: view.tab.id });
  view.items = r.items || [];
  view.jobs = r.jobs || [];
  render();
  for (const item of view.items) {
    if ((item.kind === 'hls' || item.kind === 'dash') && !item.probe && !view.probing.has(item.id)) {
      view.probing.add(item.id);
      send({ type: 'probe', tabId: view.tab.id, itemId: item.id }).then(refresh);
    }
  }
}

async function loadBili() {
  view.bili = { loading: true };
  render();
  let r;
  try {
    r = await chrome.tabs.sendMessage(view.tab.id, { type: 'bili:options' });
  } catch (_) {
    // Reached through in-page navigation: add the script now.
    try {
      await chrome.scripting.executeScript({ target: { tabId: view.tab.id }, files: ['src/core.js', 'src/bili-content.js'] });
      r = await chrome.tabs.sendMessage(view.tab.id, { type: 'bili:options' });
    } catch (e) { r = { error: { kind: 'unknown', message: String(e.message) } }; }
  }
  view.bili = r || { error: { kind: 'unknown' } };
  render();
}

// ---------- Rendering ----------

function jobFor(itemId) {
  return view.jobs.find((j) => j.itemId === itemId);
}

function showEmpty(text) {
  $('list').replaceChildren();
  $('empty').textContent = text;
  $('empty').hidden = false;
}

function render() {
  const rows = [];
  const b = view.bili;
  if (b) {
    if (b.loading) rows.push(row({ name: 'bilibili', meta: t('loading') }));
    else if (b.error) rows.push(row({ name: 'bilibili', meta: errorText(b.error), err: true }));
    else {
      const a = b.account;
      $('note').textContent = !a.loggedIn ? t('biliSignedOut') : a.vip ? t('biliVip') : t('biliBasic');
      const opts = b.options;
      const chosen = opts.find((o) => o.qn === (view.choice.bili || b.defaultQn)) || opts[0];
      rows.push(row({
        id: 'bili',
        name: chosen ? chosen.label : 'bilibili',
        kind: 'bilibili',
        meta: [fmtTime(b.duration), chosen && chosen.codec.toUpperCase(), chosen && '≈ ' + fmtSize(chosen.bitrate / 8 * b.duration)].filter(Boolean).join(' · '),
        variants: opts.map((o) => ({ key: String(o.qn), label: o.label })),
        selected: chosen && String(chosen.qn),
        onSelect: (v) => { view.choice.bili = Number(v); render(); },
        onDownload: () => send({ type: 'start', tabId: view.tab.id, bili: chosen }),
      }));
    }
  }

  // Hide media playlists that a listed master playlist already covers.
  const covered = new Set();
  for (const i of view.items) for (const c of (i.probe && i.probe.children) || []) covered.add(c);

  for (const item of view.items) {
    if (covered.has(item.url)) continue;
    const p = item.probe;
    const kind = item.kind === 'direct' ? item.ext.toUpperCase() : item.kind.toUpperCase();
    if ((item.kind === 'hls' || item.kind === 'dash') && !p) {
      rows.push(row({ name: t('video'), kind, meta: t('loading') }));
      continue;
    }
    if (p && p.error) { rows.push(row({ name: t('video'), kind, meta: errorText(p.error), err: true, hint: shortName(item.url) })); continue; }
    if (p && p.drm) { rows.push(row({ name: t('video'), kind, meta: t('drm'), disabled: true })); continue; }
    if (p && p.live) { rows.push(row({ name: t('video'), kind, meta: t('live'), disabled: true })); continue; }
    const variants = (p && p.variants) || [];
    const chosen = variants.find((v) => v.key === view.choice[item.id]) || variants[0];
    const duration = p && p.duration;
    const size = item.size || (chosen && chosen.bitrate && duration ? chosen.bitrate / 8 * duration : 0);
    rows.push(row({
      id: item.id,
      // With a quality menu the label lives in the menu; otherwise in the name.
      name: chosen && variants.length < 2 ? chosen.label : (item.audioOnly || (p && p.audioOnly) ? t('audio') : t('video')),
      kind,
      meta: [fmtTime(duration), size && (item.size ? '' : '≈ ') + fmtSize(size), shortName(item.url)].filter(Boolean).join(' · '),
      variants: variants.length > 1 ? variants : [],
      selected: chosen && chosen.key,
      onSelect: (v) => { view.choice[item.id] = v; render(); },
      onDownload: () => send({ type: 'start', tabId: view.tab.id, itemId: item.id, variant: chosen && chosen.key }),
    }));
  }

  $('list').replaceChildren(...rows);
  const empty = !rows.length;
  $('empty').hidden = !empty;
  if (empty) $('empty').textContent = t('empty');
}

function row(o) {
  const job = o.id ? jobFor(o.id) : null;
  const side = el('div', { class: 'side' });
  let meta = el('div', { class: 'meta' + (o.err ? ' err' : '') }, o.meta || '');
  let bar = null;

  if (job && (job.status === 'queued' || job.status === 'running' || job.status === 'saving')) {
    const pct = Math.floor((job.progress || 0) * 100);
    meta = el('div', { class: 'meta' }, job.status === 'queued' ? t('queued') : job.status === 'saving' ? t('saving') : `${t('downloading')} ${pct}%`);
    bar = el('div', { class: 'bar' }, el('div', { style: `width:${pct}%` }));
    side.append(el('button', { onclick: () => send({ type: 'cancel', jobId: job.id }), disabled: job.status === 'saving' }, t('cancel')));
  } else if (job && job.status === 'done') {
    meta = el('div', { class: 'meta' }, t('saved'));
    side.append(el('button', { onclick: () => send({ type: 'show', jobId: job.id }) }, t('show')));
  } else if (o.onDownload) {
    if (job && job.status === 'failed') meta = el('div', { class: 'meta err' }, errorText(job.error));
    if (o.variants && o.variants.length > 1) {
      side.append(el('select', { onchange: (e) => o.onSelect(e.target.value), 'aria-label': t('quality') },
        o.variants.map((v) => el('option', { value: v.key, selected: v.key === o.selected }, v.label))));
    }
    side.append(el('button', { class: 'primary', onclick: o.onDownload, disabled: o.disabled }, job && job.status === 'failed' ? t('retry') : t('download')));
  }

  return el('div', { class: 'row' },
    el('div', { class: 'name' }, o.name, o.kind ? el('span', { class: 'kind' }, o.kind) : null),
    side, meta, bar);
}

function errorText(e) {
  const map = {
    needLogin: 'errNeedLogin', riskControl: 'errRisk', noPermission: 'errNoPermission', notFound: 'errNotFound',
    noDash: 'errNoDash', network: 'errNetwork', http: 'errHttp', drm: 'drm', live: 'live', notMedia: 'errNotMedia',
    saveFailed: 'errSave', notVideoPage: 'errNotFound',
  };
  return t(map[e && e.kind] || 'errGeneric');
}

init();
