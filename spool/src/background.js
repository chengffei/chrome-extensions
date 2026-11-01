// Spool service worker: notices video resources as pages load them, keeps a
// per-tab list, and hands downloads to the offscreen document one at a
// time. Nothing leaves the browser except requests to the video's own site.
'use strict';
importScripts('detect.js');

const D = self.SpoolDetect;
const MAX_ITEMS = 40;
const RULE_JOB = 1;
let probeRuleId = 100;

// ---------- State (survives service worker restarts) ----------

let state = null;
let loading = null;
// One shared load, so concurrent events right after a restart all mutate
// the same object.
function getState() {
  if (state) return Promise.resolve(state);
  if (!loading) {
    loading = chrome.storage.session.get('s').then((v) => {
      state = v.s || { tabs: {}, jobs: [], seq: 0 };
      return state;
    });
  }
  return loading;
}
let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => chrome.storage.session.set({ s: state }), 200);
}
function broadcast() {
  chrome.runtime.sendMessage({ type: 'spool:update' }).catch(() => { /* popup closed */ });
}

// ---------- Detection ----------

chrome.webRequest.onBeforeRequest.addListener((d) => {
  if (d.tabId < 0) return;
  getState().then((s) => {
    delete s.tabs[d.tabId];
    chrome.action.setBadgeText({ tabId: d.tabId, text: '' }).catch(() => {});
    save();
  });
}, { urls: ['<all_urls>'], types: ['main_frame'] });

chrome.webRequest.onHeadersReceived.addListener((d) => {
  if (d.tabId < 0) return; // includes Spool's own downloads
  const found = D.classify(d);
  if (found) addItem(d, found);
}, { urls: ['<all_urls>'], types: ['media', 'xmlhttprequest', 'other', 'object'] }, ['responseHeaders']);

async function addItem(d, found) {
  const s = await getState();
  let tab;
  try { tab = await chrome.tabs.get(d.tabId); } catch (_) { return; }
  if (D.isBlockedHost(hostOf(tab.url))) return;
  const t = s.tabs[d.tabId] || (s.tabs[d.tabId] = { items: [] });
  const key = D.dedupeKey(found.url);
  const existing = t.items.find((i) => i.key === key);
  if (existing) {
    if (found.size > existing.size) { existing.size = found.size; save(); }
    return;
  }
  t.items.unshift({
    id: String(++s.seq),
    key,
    ...found,
    // The player's own page is what the media server expects as Referer.
    referer: d.frameId === 0 || !d.initiator ? tab.url : d.initiator + '/',
    title: tab.title || '',
  });
  t.items.length = Math.min(t.items.length, MAX_ITEMS);
  chrome.action.setBadgeBackgroundColor({ tabId: d.tabId, color: '#6e6e73' }).catch(() => {});
  chrome.action.setBadgeText({ tabId: d.tabId, text: String(t.items.length) }).catch(() => {});
  save();
  broadcast();
}

chrome.tabs.onRemoved.addListener(async (tabId) => {
  const s = await getState();
  delete s.tabs[tabId];
  save();
});

function hostOf(url) {
  try { return new URL(url).hostname; } catch (_) { return ''; }
}

// ---------- Referer for Spool's own requests ----------
// Downloads run in the offscreen document, outside any tab. These session
// rules give its requests the Referer of the page the video came from,
// limited to requests made by Spool itself.

function refererRule(id, referer, priority, hosts) {
  const condition = { tabIds: [chrome.tabs.TAB_ID_NONE], initiatorDomains: [chrome.runtime.id] };
  if (hosts) condition.requestDomains = hosts;
  return {
    id, priority,
    action: { type: 'modifyHeaders', requestHeaders: [{ header: 'referer', operation: 'set', value: referer }] },
    condition,
  };
}

async function setRule(rule) {
  await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [rule.id], addRules: [rule] });
}
async function removeRule(id) {
  await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [id] }).catch(() => {});
}

// ---------- Offscreen document ----------

let creating = null;
async function ensureOffscreen() {
  const url = chrome.runtime.getURL('src/offscreen.html');
  const contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'], documentUrls: [url] });
  if (contexts.length) return;
  if (!creating) {
    creating = chrome.offscreen.createDocument({
      url: 'src/offscreen.html',
      reasons: ['BLOBS'],
      justification: 'Download stream segments and merge them into one file on this device.',
    }).finally(() => { creating = null; });
  }
  await creating;
}

async function toOffscreen(msg) {
  await ensureOffscreen();
  return chrome.runtime.sendMessage({ target: 'offscreen', ...msg });
}

async function maybeCloseOffscreen() {
  const s = await getState();
  if (s.jobs.some((j) => j.status === 'queued' || j.status === 'running' || j.status === 'saving')) return;
  if (probing > 0) return;
  await chrome.offscreen.closeDocument().catch(() => {});
}

// ---------- Probing ----------

let probing = 0;
async function probe(tabId, itemId) {
  const s = await getState();
  const item = s.tabs[tabId] && s.tabs[tabId].items.find((i) => i.id === itemId);
  if (!item) return null;
  if (item.probe) return item.probe;
  const id = ++probeRuleId;
  probing++;
  try {
    // Narrow rule (this host only) above the job rule, so a running
    // download from another site keeps its own Referer.
    await setRule(refererRule(id, item.referer, 2, [hostOf(item.url)]));
    const r = await toOffscreen({ type: 'probe', item: { kind: item.kind, url: item.url } });
    item.probe = r && r.ok ? r.result : { error: (r && r.error) || { kind: 'unknown' } };
  } catch (e) {
    item.probe = { error: { kind: 'unknown', message: String(e && e.message) } };
  } finally {
    probing--;
    await removeRule(id);
    save();
    maybeCloseOffscreen();
  }
  return item.probe;
}

// ---------- Jobs ----------

function filenameFor(title, label, ext) {
  const base = D.safeName([title, label].filter(Boolean).join(' '));
  return `${base}.${ext}`;
}

async function startJob(spec) {
  const s = await getState();
  let job;
  if (spec.bili) {
    const o = spec.bili;
    job = {
      kind: 'pair', videoUrls: o.videoUrls, audioUrls: o.audioUrls, duration: o.duration,
      referer: 'https://www.bilibili.com/', filename: D.safeName(o.fileBase) + '.mp4', label: o.label,
    };
  } else {
    const item = s.tabs[spec.tabId] && s.tabs[spec.tabId].items.find((i) => i.id === spec.itemId);
    if (!item) return null;
    const p = item.probe || {};
    const variant = (p.variants || []).find((v) => v.key === spec.variant) || (p.variants || [])[0];
    const ext = item.kind === 'direct' ? item.ext : (p.audioOnly ? 'm4a' : 'mp4');
    job = {
      kind: item.kind, url: item.url, size: item.size, variant: variant && variant.key, referer: item.referer,
      label: variant ? variant.label : '', filename: filenameFor(item.title, variant && variant.label, ext),
    };
  }
  job.id = 'j' + (++s.seq);
  job.tabId = spec.tabId;
  job.itemId = spec.itemId || 'bili';
  job.status = 'queued';
  job.progress = 0;
  s.jobs.unshift(job);
  s.jobs.length = Math.min(s.jobs.length, 20);
  save();
  broadcast();
  pump();
  return job.id;
}

let pumping = false;
async function pump() {
  if (pumping) return;
  pumping = true;
  try {
    const s = await getState();
    if (s.jobs.some((j) => j.status === 'running')) return;
    const job = [...s.jobs].reverse().find((j) => j.status === 'queued');
    if (!job) { maybeCloseOffscreen(); return; }
    job.status = 'running';
    save();
    broadcast();
    await setRule(refererRule(RULE_JOB, job.referer, 1));
    const { referer, ...payload } = job;
    await toOffscreen({ type: 'run', job: payload });
  } catch (e) {
    console.warn('[Spool] could not start job', e);
  } finally {
    pumping = false;
  }
}

async function finishJob(jobId, patch) {
  const s = await getState();
  const job = s.jobs.find((j) => j.id === jobId);
  if (!job) return null;
  Object.assign(job, patch);
  if (job.status !== 'running') await removeRule(RULE_JOB);
  save();
  broadcast();
  return job;
}

// Spool's downloads start from an <a download> link in the offscreen
// document, so the file name is the download's own default and survives
// other extensions (download managers, sniffers) that listen here and
// suggest nothing. This listener restates it when Spool is installed last.
chrome.downloads.onDeterminingFilename.addListener((item, suggest) => {
  if (!item.url.startsWith('blob:' + location.origin)) return false;
  getState().then((s) => {
    const job = s.jobs.find((j) => j.blobUrl && (j.blobUrl === item.url || j.blobUrl === item.finalUrl));
    if (job) suggest({ filename: job.filename, conflictAction: 'uniquify' });
    else suggest();
  });
  return true;
});

chrome.downloads.onCreated.addListener(async (item) => {
  if (!item.url.startsWith('blob:' + location.origin)) return;
  const s = await getState();
  const job = s.jobs.find((j) => j.blobUrl === item.url);
  if (job) { job.downloadId = item.id; save(); }
});

chrome.downloads.onChanged.addListener(async (delta) => {
  if (!delta.state || delta.state.current === 'in_progress') return;
  const s = await getState();
  const job = s.jobs.find((j) => j.downloadId === delta.id);
  if (!job) return;
  job.status = delta.state.current === 'complete' ? 'done' : 'failed';
  if (job.status === 'failed') job.error = { kind: 'saveFailed' };
  save();
  broadcast();
  await toOffscreen({ type: 'cleanup', jobId: job.id }).catch(() => {});
  pump();
});

// ---------- Messages ----------

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (msg.target === 'offscreen') return false;
  handle(msg).then(reply, (e) => reply({ error: String(e && e.message) }));
  return true;
});

async function handle(msg) {
  const s = await getState();
  switch (msg.type) {
    case 'list': {
      const t = s.tabs[msg.tabId];
      return { items: t ? t.items : [], jobs: s.jobs.filter((j) => j.tabId === msg.tabId) };
    }
    case 'probe': return probe(msg.tabId, msg.itemId);
    case 'start': return startJob(msg);
    case 'cancel': {
      const job = s.jobs.find((j) => j.id === msg.jobId);
      if (!job) return null;
      if (job.status === 'queued') { await finishJob(job.id, { status: 'cancelled' }); return true; }
      if (job.status === 'running') await toOffscreen({ type: 'cancel', jobId: job.id });
      return true;
    }
    case 'show': {
      const job = s.jobs.find((j) => j.id === msg.jobId);
      if (job && job.downloadId != null) chrome.downloads.show(job.downloadId);
      return true;
    }
    // From the offscreen document.
    case 'job:progress': {
      const job = s.jobs.find((j) => j.id === msg.jobId);
      if (job) { job.progress = msg.progress; save(); broadcast(); }
      return true;
    }
    case 'job:done': {
      // The offscreen document has started the download itself (see
      // offscreen.js); onCreated below links it back to the job.
      const job = await finishJob(msg.jobId, { status: 'saving', progress: 1, blobUrl: msg.blobUrl });
      if (job && msg.error) {
        await finishJob(job.id, { status: 'failed', error: { kind: 'saveFailed', message: msg.error } });
        await toOffscreen({ type: 'cleanup', jobId: job.id }).catch(() => {});
        pump();
      }
      return true;
    }
    case 'job:failed': {
      await finishJob(msg.jobId, msg.cancelled ? { status: 'cancelled' } : { status: 'failed', error: msg.error });
      pump();
      return true;
    }
    default: return null;
  }
}
