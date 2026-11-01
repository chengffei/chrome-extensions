// Spool offscreen document: runs probes and downloads. Writes each job to
// the extension's private file system, then starts the download of the
// finished file with an <a download> link so it keeps its name.
'use strict';

const running = new Map(); // jobId -> AbortController
const finished = new Map(); // jobId -> blob URL
const MIME = {
  mp4: 'video/mp4', m4v: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', mkv: 'video/x-matroska', flv: 'video/x-flv',
  ogv: 'video/ogg', m4a: 'audio/mp4', mp3: 'audio/mpeg', ogg: 'audio/ogg', oga: 'audio/ogg', opus: 'audio/ogg', wav: 'audio/wav', flac: 'audio/flac',
};
let rootDir = null;

async function root() {
  if (!rootDir) rootDir = await navigator.storage.getDirectory();
  return rootDir;
}

// Leftovers from a previous session (browser closed mid-download).
(async () => {
  const dir = await root();
  for await (const name of dir.keys()) {
    if (name.startsWith('job-')) await dir.removeEntry(name).catch(() => {});
  }
})();

function errorInfo(e) {
  return { kind: (e && e.kind) || (e && e.name === 'AbortError' ? 'cancelled' : 'unknown'), message: String((e && e.message) || e) };
}

const send = (msg) => chrome.runtime.sendMessage(msg).catch(() => {});

async function createTempFor(jobId) {
  const dir = await root();
  return async (kind) => {
    const name = `job-${jobId}-${kind}`;
    const handle = await dir.getFileHandle(name, { create: true });
    return {
      writable: await handle.createWritable(),
      blob: () => handle.getFile(),
      remove: () => dir.removeEntry(name),
    };
  };
}

async function runJob(job) {
  const ctl = new AbortController();
  running.set(job.id, ctl);
  const dir = await root();
  const name = `job-${job.id}`;
  let lastSent = 0;
  try {
    const handle = await dir.getFileHandle(name, { create: true });
    const writable = await handle.createWritable();
    try {
      await SpoolMedia.run(job, {
        writable,
        signal: ctl.signal,
        requestInit: { credentials: 'include' },
        createTemp: await createTempFor(job.id),
        onProgress: (p) => {
          const now = Date.now();
          if (p >= 1 || now - lastSent > 400) { lastSent = now; send({ type: 'job:progress', jobId: job.id, progress: p }); }
        },
      });
    } catch (e) {
      try { await writable.abort(); } catch (_) { /* already closed */ }
      throw e;
    }
    // Start the download from here with <a download>. The name is then the
    // download's default, not a suggestion from chrome.downloads.download,
    // which Chrome drops when another extension handles onDeterminingFilename.
    const type = MIME[(job.filename.match(/\.([a-z0-9]+)$/i) || [])[1]] || 'application/octet-stream';
    const url = URL.createObjectURL(new Blob([await handle.getFile()], { type }));
    finished.set(job.id, url);
    // Tell the service worker first, so onCreated can match the URL.
    await chrome.runtime.sendMessage({ type: 'job:done', jobId: job.id, blobUrl: url });
    const a = document.createElement('a');
    a.href = url;
    a.download = job.filename;
    document.body.append(a);
    a.click();
    a.remove();
  } catch (e) {
    console.warn('[Spool] job failed', job.id, e);
    await dir.removeEntry(name).catch(() => {});
    send({ type: 'job:failed', jobId: job.id, cancelled: ctl.signal.aborted, error: errorInfo(e) });
  } finally {
    running.delete(job.id);
  }
}

async function cleanup(jobId) {
  const url = finished.get(jobId);
  if (url) URL.revokeObjectURL(url);
  finished.delete(jobId);
  const dir = await root();
  for await (const name of dir.keys()) {
    if (name === `job-${jobId}` || name.startsWith(`job-${jobId}-`)) await dir.removeEntry(name).catch(() => {});
  }
}

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (msg.target !== 'offscreen') return false;
  if (msg.type === 'probe') {
    SpoolMedia.probe(msg.item, { requestInit: { credentials: 'include' } })
      .then((result) => reply({ ok: true, result }), (e) => reply({ ok: false, error: errorInfo(e) }));
    return true;
  }
  if (msg.type === 'run') { runJob(msg.job); reply({ ok: true }); return false; }
  if (msg.type === 'cancel') { const c = running.get(msg.jobId); if (c) c.abort(); reply({ ok: true }); return false; }
  if (msg.type === 'cleanup') { cleanup(msg.jobId).then(() => reply({ ok: true })); return true; }
  return false;
});
