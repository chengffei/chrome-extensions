// Spool media: probes a detected resource (qualities, duration, DRM, live)
// and runs a download job into a WritableStream. Environment-agnostic: the
// offscreen document and the Node tests supply temp files and fetch options.
// Needs SpoolMux, SpoolDash, Mediabunny; exports to globalThis.SpoolMedia.
(function (g) {
  'use strict';

  const X = () => g.SpoolMux;

  class MediaError extends Error {
    constructor(kind, detail) {
      super(kind + (detail ? ': ' + detail : ''));
      this.kind = kind;
    }
  }

  function heightLabel(h) {
    if (!h) return '';
    if (h >= 4000) return '8K';
    if (h >= 2000) return '4K';
    if (h >= 1400) return '1440P';
    return h + 'P';
  }

  // Encrypted HLS that is not the open AES-128 / identity scheme is DRM.
  function hlsDrm(text) {
    return /#EXT-X-(?:SESSION-)?KEY:[^\n]*KEYFORMAT="(?!identity")/i.test(text)
      || /#EXT-X-(?:SESSION-)?KEY:[^\n]*URI="skd:/i.test(text);
  }

  function isDrmError(e) {
    return /KEYFORMAT|DRM|FairPlay|Widevine|PlayReady/i.test(String(e && e.message));
  }

  async function fetchText(url, requestInit, signal) {
    const res = await fetch(url, { ...(requestInit || {}), signal });
    if (!res.ok) throw new MediaError('http', 'HTTP ' + res.status);
    return res.text();
  }

  // ---------- Probe ----------

  async function probeHls(item, env) {
    const text = await fetchText(item.url, env.requestInit);
    if (!/^#EXTM3U/.test(text.trimStart())) throw new MediaError('notMedia');
    if (hlsDrm(text)) return { drm: true };
    // Child playlists listed by this master, so the list can hide them.
    const children = [];
    if (/#EXT-X-STREAM-INF/.test(text)) {
      for (const line of text.split(/\r?\n/)) {
        const l = line.trim();
        if (l && !l.startsWith('#')) children.push(new URL(l, item.url).href);
        const m = l.match(/URI="([^"]+)"/);
        if (m && /#EXT-X-(MEDIA|I-FRAME-STREAM-INF)/.test(l)) children.push(new URL(m[1], item.url).href);
      }
    }
    const input = X().openInput(X().urlSource(item.url, env.requestInit));
    try {
      const vids = await X().videoTracks(input);
      const main = vids[0] || (await input.getPrimaryAudioTrack());
      if (!main) throw new MediaError('notMedia');
      if (await main.isLive()) return { live: true, children };
      const duration = (await main.getDurationFromMetadata().catch(() => null)) || 0;
      const variants = await Promise.all(vids.map(async (t) => {
        const d = await X().describeVideo(t);
        return { key: `${d.width}x${d.height}@${d.bitrate}`, label: heightLabel(d.height), height: d.height, bitrate: d.bitrate };
      }));
      return { duration, variants, audioOnly: vids.length === 0, children };
    } catch (e) {
      if (isDrmError(e)) return { drm: true };
      throw e;
    } finally {
      input.dispose();
    }
  }

  async function probeDash(item, env) {
    const mpd = g.SpoolDash.parseMpd(await fetchText(item.url, env.requestInit), item.url);
    if (mpd.live) return { live: true };
    const clear = mpd.video.filter((r) => !r.drm);
    const clearAudio = mpd.audio.filter((r) => !r.drm);
    if (mpd.drm && !clear.length && !clearAudio.length) return { drm: true };
    const variants = clear.map((r) => ({
      key: r.id, label: heightLabel(r.height), height: r.height,
      bitrate: r.bandwidth + ((clearAudio[0] && clearAudio[0].bandwidth) || 0),
    }));
    return { duration: mpd.duration, variants, audioOnly: !clear.length };
  }

  async function probe(item, env) {
    if (item.kind === 'hls') return probeHls(item, env);
    if (item.kind === 'dash') return probeDash(item, env);
    return { variants: [] };
  }

  // ---------- Run ----------

  async function runHls(job, env) {
    const input = X().openInput(X().urlSource(job.url, env.requestInit));
    try {
      const vids = await X().videoTracks(input);
      let video = vids[0] || null;
      if (job.variant) {
        for (const t of vids) {
          const d = await X().describeVideo(t);
          if (`${d.width}x${d.height}@${d.bitrate}` === job.variant) { video = t; break; }
        }
      }
      const audio = video ? await video.getPrimaryPairableAudioTrack() : await input.getPrimaryAudioTrack();
      if (video && await video.isLive()) throw new MediaError('live');
      await X().copyTracks({ video, audio, writable: env.writable, onProgress: env.onProgress, signal: env.signal });
    } catch (e) {
      if (isDrmError(e)) throw new MediaError('drm');
      throw e;
    } finally {
      input.dispose();
    }
  }

  // Downloads a segmented representation into one temp file, in order,
  // a few requests at a time.
  async function fetchSegments(segments, temp, env, onBytes) {
    const writer = temp.writable.getWriter();
    const PARALLEL = 4;
    const pending = new Map();
    const get = async (s) => {
      const init = { ...(env.requestInit || {}), signal: env.signal };
      if (s.range) init.headers = { ...(init.headers || {}), Range: 'bytes=' + s.range };
      for (let attempt = 0; ; attempt++) {
        try {
          const res = await fetch(s.url, init);
          if (!res.ok) throw new MediaError('http', 'HTTP ' + res.status + ' ' + s.url);
          return new Uint8Array(await res.arrayBuffer());
        } catch (e) {
          if (e.name === 'AbortError' || attempt >= 3) throw e;
          await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
        }
      }
    };
    try {
      for (let i = 0; i < segments.length; i++) {
        for (let j = i; j < Math.min(segments.length, i + PARALLEL); j++) {
          if (!pending.has(j)) pending.set(j, get(segments[j]));
        }
        const data = await pending.get(i);
        pending.delete(i);
        await writer.write(data);
        onBytes(data.byteLength, (i + 1) / segments.length);
      }
      await writer.close();
    } catch (e) {
      for (const p of pending.values()) p.catch(() => {});
      try { await writer.abort(e); } catch (_) { /* closed */ }
      throw e;
    }
  }

  async function openRepresentation(rep, env, share, offset) {
    if (rep.single) return X().openInput(X().urlSource(rep.single, env.requestInit));
    const temp = await env.createTemp(rep.kind);
    env.temps.push(temp);
    await fetchSegments(rep.segments, temp, env, (_, f) => {
      if (env.onProgress) env.onProgress(offset + f * share);
    });
    return X().openInput(new g.Mediabunny.BlobSource(await temp.blob()));
  }

  async function runDash(job, env) {
    const mpd = g.SpoolDash.parseMpd(await fetchText(job.url, env.requestInit, env.signal), job.url);
    if (mpd.live) throw new MediaError('live');
    const videos = mpd.video.filter((r) => !r.drm);
    const audios = mpd.audio.filter((r) => !r.drm);
    const vRep = videos.find((r) => r.id === job.variant) || videos[0] || null;
    const aRep = audios[0] || null;
    if (!vRep && !aRep) throw new MediaError(mpd.drm ? 'drm' : 'notMedia');
    env.temps = [];
    const inputs = [];
    try {
      // Segment download is the slow part: 0–90 %; packet copy: 90–100 %.
      const vShare = vRep && aRep ? 0.75 : 0.9;
      const vIn = vRep ? await openRepresentation(vRep, env, vShare, 0) : null;
      if (vIn) inputs.push(vIn);
      const aIn = aRep ? await openRepresentation(aRep, env, 0.9 - (vRep ? vShare : 0), vRep ? vShare : 0) : null;
      if (aIn) inputs.push(aIn);
      await X().copyTracks({
        video: vIn && (await vIn.getPrimaryVideoTrack()),
        audio: aIn && (await aIn.getPrimaryAudioTrack()),
        writable: env.writable,
        duration: mpd.duration,
        signal: env.signal,
        onProgress: (p) => env.onProgress && env.onProgress(0.9 + p * 0.1),
      });
    } finally {
      for (const i of inputs) i.dispose();
      for (const t of env.temps) await t.remove().catch(() => {});
    }
  }

  /**
   * @param {object} job  {kind:'hls'|'dash'|'direct'|'pair', url, variant?, videoUrls?, audioUrls?, duration?, size?}
   * @param {object} env  {writable, requestInit?, signal?, onProgress?, createTemp?(kind) -> {writable, blob(), remove()}}
   */
  async function run(job, env) {
    if (job.kind === 'hls') return runHls(job, env);
    if (job.kind === 'dash') return runDash(job, env);
    if (job.kind === 'pair') {
      return X().remux({
        videoUrls: job.videoUrls, audioUrls: job.audioUrls, writable: env.writable, duration: job.duration,
        requestInit: env.requestInit, signal: env.signal, onProgress: env.onProgress,
      });
    }
    if (job.kind === 'direct') {
      return X().saveRaw({ urls: [job.url], size: job.size, writable: env.writable, requestInit: env.requestInit, signal: env.signal, onProgress: env.onProgress });
    }
    throw new MediaError('unsupported', job.kind);
  }

  g.SpoolMedia = { probe, run, heightLabel, hlsDrm, MediaError };
})(globalThis);
