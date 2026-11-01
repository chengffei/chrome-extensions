// Spool detection: decides whether a network response is a video resource
// worth listing. Shared by the service worker and the Node tests; exports
// to globalThis.SpoolDetect.
(function (g) {
  'use strict';

  const HLS_TYPES = new Set([
    'application/vnd.apple.mpegurl', 'application/x-mpegurl', 'audio/mpegurl', 'audio/x-mpegurl',
  ]);
  const DASH_TYPES = new Set(['application/dash+xml']);
  // Pieces of a stream, never useful on their own.
  const SEGMENT_TYPES = new Set(['video/mp2t', 'video/iso.segment', 'audio/iso.segment']);
  const SEGMENT_EXT = new Set(['ts', 'm4s', 'm4f', 'm4v-seg', 'cmfv', 'cmfa', 'aac', 'key', 'vtt', 'webvtt']);
  const DIRECT_EXT = new Set(['mp4', 'm4v', 'webm', 'mov', 'mkv', 'flv', 'ogv', 'm4a', 'mp3', 'ogg', 'oga', 'opus', 'wav', 'flac']);
  const AUDIO_EXT = new Set(['m4a', 'mp3', 'ogg', 'oga', 'opus', 'wav', 'flac']);

  // Sites whose videos Spool deliberately does not download (store policy).
  const BLOCKED_HOSTS = [/(^|\.)youtube\.com$/, /(^|\.)googlevideo\.com$/, /(^|\.)youtube-nocookie\.com$/, /(^|\.)ytimg\.com$/];

  const MIN_DIRECT_BYTES = 256 * 1024;

  function isBlockedHost(host) {
    return BLOCKED_HOSTS.some((re) => re.test(host));
  }

  function extOf(pathname) {
    const last = pathname.slice(pathname.lastIndexOf('/') + 1);
    const dot = last.lastIndexOf('.');
    return dot > 0 ? last.slice(dot + 1).toLowerCase() : '';
  }

  function header(headers, name) {
    if (!headers) return '';
    const h = headers.find((x) => x.name.toLowerCase() === name);
    return h ? h.value || '' : '';
  }

  // Total size from Content-Range ("bytes 0-99/12345") or Content-Length.
  function totalSize(headers, status) {
    const range = header(headers, 'content-range');
    const m = range.match(/\/(\d+)\s*$/);
    if (m) return Number(m[1]);
    const len = Number(header(headers, 'content-length'));
    return status === 200 && len > 0 ? len : 0;
  }

  /**
   * @param {{url:string, statusCode?:number, responseHeaders?:{name:string,value:string}[]}} d
   * @returns {null | {kind:'hls'|'dash'|'direct', url:string, ext:string, size:number, audioOnly:boolean}}
   */
  function classify(d) {
    let u;
    try { u = new URL(d.url); } catch (_) { return null; }
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    if (isBlockedHost(u.hostname)) return null;
    if (d.statusCode && d.statusCode >= 400) return null;

    const ct = header(d.responseHeaders, 'content-type').split(';')[0].trim().toLowerCase();
    const ext = extOf(u.pathname);

    if (HLS_TYPES.has(ct) || ext === 'm3u8') return { kind: 'hls', url: d.url, ext: 'm3u8', size: 0, audioOnly: false };
    if (DASH_TYPES.has(ct) || ext === 'mpd') return { kind: 'dash', url: d.url, ext: 'mpd', size: 0, audioOnly: false };
    if (SEGMENT_TYPES.has(ct) || SEGMENT_EXT.has(ext)) return null;

    const mediaType = ct.startsWith('video/') || ct.startsWith('audio/');
    const knownExt = DIRECT_EXT.has(ext);
    if (!mediaType && !(knownExt && (ct === '' || ct === 'application/octet-stream' || ct === 'binary/octet-stream'))) return null;

    const size = totalSize(d.responseHeaders, d.statusCode);
    if (size && size < MIN_DIRECT_BYTES) return null;
    const finalExt = knownExt ? ext : (ct.split('/')[1] || 'bin').replace(/^x-/, '').replace('quicktime', 'mov').replace('mpeg', 'mp3');
    return {
      kind: 'direct', url: d.url, ext: finalExt, size,
      audioOnly: ct.startsWith('audio/') || AUDIO_EXT.has(ext),
    };
  }

  // Strips query parameters that only select a byte range, so the same file
  // fetched in pieces shows up once.
  function dedupeKey(url) {
    try {
      const u = new URL(url);
      for (const k of ['range', 'bytes', 'byterange', 'start', 'end']) u.searchParams.delete(k);
      u.hash = '';
      return u.href;
    } catch (_) {
      return url;
    }
  }

  function safeName(s) {
    return String(s || '')
      .replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 120) || 'video';
  }

  g.SpoolDetect = { classify, dedupeKey, isBlockedHost, safeName, extOf };
})(globalThis);
