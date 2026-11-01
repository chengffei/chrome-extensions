// Spool mux: copies encoded video and audio packets into one MP4 without
// re-encoding, reading lazily and writing straight to the target stream so
// memory stays bounded for multi-gigabyte files.
// Needs globalThis.Mediabunny; exports to globalThis.SpoolMux.
(function (g) {
  'use strict';

  const MB = () => g.Mediabunny;

  function retryDelay(attempts) {
    return attempts >= 4 ? null : Math.min(8, 2 ** attempts);
  }

  function urlSource(url, requestInit) {
    return new (MB().UrlSource)(url, { requestInit, getRetryDelay: retryDelay, parallelism: 4 });
  }

  function openInput(source) {
    return new (MB().Input)({ source, formats: MB().ALL_FORMATS });
  }

  // Real video tracks only: HLS manifests also list I-frame (trick play)
  // renditions, which contain key frames alone.
  async function videoTracks(input) {
    const out = [];
    for (const t of await input.getVideoTracks()) {
      if (!(await t.hasOnlyKeyPackets())) out.push(t);
    }
    const info = await Promise.all(out.map(async (t) => ({ t, h: await t.getDisplayHeight(), br: (await t.getBitrate()) || 0 })));
    info.sort((a, b) => (b.h - a.h) || (b.br - a.br));
    return info.map((x) => x.t);
  }

  async function describeVideo(t) {
    return { width: await t.getDisplayWidth(), height: await t.getDisplayHeight(), bitrate: (await t.getBitrate()) || 0, codec: await t.getCodec() };
  }

  async function firstTrack(urls, kind, requestInit) {
    let lastError;
    for (const url of urls) {
      const input = openInput(urlSource(url, requestInit));
      try {
        const track = kind === 'video' ? await input.getPrimaryVideoTrack() : await input.getPrimaryAudioTrack();
        if (!track) throw new Error('no ' + kind + ' track');
        return { input, track };
      } catch (e) {
        lastError = e;
        input.dispose();
      }
    }
    throw lastError || new Error('no url');
  }

  // Merge two async packet iterators in timestamp order.
  async function* interleave(a, b) {
    let x = await a.next();
    let y = await b.next();
    while (!x.done || !y.done) {
      if (y.done || (!x.done && x.value.timestamp <= y.value.timestamp)) {
        yield ['v', x.value];
        x = await a.next();
      } else {
        yield ['a', y.value];
        y = await b.next();
      }
    }
  }

  const empty = async function* () {};

  /**
   * Copies one video and/or one audio track into an MP4.
   * @param {object} o
   * @param {object} [o.video]  Mediabunny InputVideoTrack
   * @param {object} [o.audio]  Mediabunny InputAudioTrack
   * @param {WritableStream} o.writable  receives {type:'write', data, position}
   * @param {number} [o.duration]  seconds, for progress
   * @param {(p:number)=>void} [o.onProgress]
   * @param {AbortSignal} [o.signal]
   */
  async function copyTracks(o) {
    const M = MB();
    if (!o.video && !o.audio) throw new Error('nothing to copy');
    const output = new M.Output({
      format: new M.Mp4OutputFormat({ fastStart: false }),
      target: new M.StreamTarget(o.writable, { chunked: true, chunkSize: 8 * 1024 * 1024 }),
    });
    try {
      let vSrc = null;
      let aSrc = null;
      if (o.video) { vSrc = new M.EncodedVideoPacketSource(await o.video.getCodec()); output.addVideoTrack(vSrc); }
      if (o.audio) { aSrc = new M.EncodedAudioPacketSource(await o.audio.getCodec()); output.addAudioTrack(aSrc); }
      await output.start();

      const vMeta = o.video ? { decoderConfig: await o.video.getDecoderConfig() } : null;
      const aMeta = o.audio ? { decoderConfig: await o.audio.getDecoderConfig() } : null;
      const main = o.video || o.audio;
      const start = await main.getFirstTimestamp().catch(() => 0);
      const duration = o.duration || (await main.computeDuration());
      const vIt = o.video ? new M.EncodedPacketSink(o.video).packets() : empty();
      const aIt = o.audio ? new M.EncodedPacketSink(o.audio).packets() : empty();

      let vFirst = true;
      let aFirst = true;
      let lastReport = -1;
      for await (const [kind, packet] of interleave(vIt, aIt)) {
        if (o.signal && o.signal.aborted) throw new DOMException('Aborted', 'AbortError');
        if (kind === 'v') {
          await vSrc.add(packet, vFirst ? vMeta : undefined);
          vFirst = false;
        } else {
          await aSrc.add(packet, aFirst ? aMeta : undefined);
          aFirst = false;
        }
        if (o.onProgress && duration && ((kind === 'v') === !!o.video)) {
          const at = packet.timestamp - start;
          if (at - lastReport >= 1) {
            lastReport = at;
            o.onProgress(Math.max(0, Math.min(0.999, at / duration)));
          }
        }
      }
      await output.finalize();
      if (o.onProgress) o.onProgress(1);
    } catch (e) {
      try { await output.cancel(); } catch (_) { /* already failed */ }
      throw e;
    }
  }

  /** Separate video and audio URLs (bilibili DASH) into one MP4. */
  async function remux(o) {
    const v = await firstTrack(o.videoUrls, 'video', o.requestInit);
    let a = null;
    try {
      if (o.audioUrls && o.audioUrls.length) a = await firstTrack(o.audioUrls, 'audio', o.requestInit);
      await copyTracks({ video: v.track, audio: a && a.track, writable: o.writable, duration: o.duration, onProgress: o.onProgress, signal: o.signal });
    } finally {
      v.input.dispose();
      if (a) a.input.dispose();
    }
  }

  /**
   * Streams one URL as-is to a plain WritableStream. Falls back to backup
   * URLs only before any byte is written.
   */
  async function saveRaw(o) {
    let res;
    let lastError;
    for (const url of o.urls) {
      try {
        res = await fetch(url, { ...(o.requestInit || {}), signal: o.signal });
        if (res.ok) break;
        lastError = new Error('HTTP ' + res.status);
        res = null;
      } catch (e) {
        if (e && e.name === 'AbortError') throw e;
        lastError = e;
      }
    }
    if (!res) throw lastError || new Error('no url');
    const total = Number(res.headers.get('content-length')) || o.size || 0;
    let done = 0;
    const counter = new TransformStream({
      transform(chunk, ctl) {
        done += chunk.byteLength;
        if (o.onProgress && total) o.onProgress(Math.min(0.999, done / total));
        ctl.enqueue(chunk);
      },
    });
    await res.body.pipeThrough(counter).pipeTo(o.writable, { signal: o.signal });
    if (o.onProgress) o.onProgress(1);
  }

  g.SpoolMux = { urlSource, openInput, videoTracks, describeVideo, copyTracks, remux, saveRaw };
})(globalThis);
