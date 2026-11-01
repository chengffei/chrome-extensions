// Spool mux: copies the DASH video and audio tracks into one MP4 without
// re-encoding. Reads with HTTP range requests and writes straight to the
// target stream, so memory stays bounded for multi-gigabyte files.
// Needs globalThis.Mediabunny; exports to globalThis.SpoolMux.
(function (g) {
  'use strict';

  function retryDelay(attempts) {
    return attempts >= 4 ? null : Math.min(8, 2 ** attempts);
  }

  async function openTrack(urls, kind, requestInit) {
    const MB = g.Mediabunny;
    let lastError;
    for (const url of urls) {
      const input = new MB.Input({
        source: new MB.UrlSource(url, { requestInit, getRetryDelay: retryDelay, parallelism: 4 }),
        formats: MB.ALL_FORMATS,
      });
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

  /**
   * @param {object} o
   * @param {string[]} o.videoUrls  primary URL first, then backups
   * @param {string[]} o.audioUrls
   * @param {WritableStream} o.writable  receives {type:'write', data, position}
   * @param {number} [o.duration]  seconds, for progress
   * @param {(p:number)=>void} [o.onProgress]  0..1
   * @param {AbortSignal} [o.signal]
   * @param {RequestInit} [o.requestInit]
   */
  async function remux(o) {
    const MB = g.Mediabunny;
    const v = await openTrack(o.videoUrls, 'video', o.requestInit);
    const a = o.audioUrls && o.audioUrls.length ? await openTrack(o.audioUrls, 'audio', o.requestInit) : null;
    const output = new MB.Output({
      format: new MB.Mp4OutputFormat({ fastStart: false }),
      target: new MB.StreamTarget(o.writable, { chunked: true, chunkSize: 8 * 1024 * 1024 }),
    });
    const cleanup = () => { v.input.dispose(); if (a) a.input.dispose(); };
    let aborted = false;
    const onAbort = () => { aborted = true; };
    if (o.signal) o.signal.addEventListener('abort', onAbort, { once: true });

    try {
      const vSrc = new MB.EncodedVideoPacketSource(v.track.codec);
      output.addVideoTrack(vSrc);
      let aSrc = null;
      if (a) {
        aSrc = new MB.EncodedAudioPacketSource(a.track.codec);
        output.addAudioTrack(aSrc);
      }
      await output.start();

      const vMeta = { decoderConfig: await v.track.getDecoderConfig() };
      const aMeta = a ? { decoderConfig: await a.track.getDecoderConfig() } : null;
      const duration = o.duration || (await v.track.computeDuration());
      const vIt = new MB.EncodedPacketSink(v.track).packets();
      const aIt = a ? new MB.EncodedPacketSink(a.track).packets() : (async function* () {})();

      let vFirst = true;
      let aFirst = true;
      let lastReport = 0;
      for await (const [kind, packet] of interleave(vIt, aIt)) {
        if (aborted) throw new DOMException('Aborted', 'AbortError');
        if (kind === 'v') {
          await vSrc.add(packet, vFirst ? vMeta : undefined);
          vFirst = false;
          if (o.onProgress && duration && packet.timestamp - lastReport >= 1) {
            lastReport = packet.timestamp;
            o.onProgress(Math.min(0.999, packet.timestamp / duration));
          }
        } else {
          await aSrc.add(packet, aFirst ? aMeta : undefined);
          aFirst = false;
        }
      }
      await output.finalize();
      if (o.onProgress) o.onProgress(1);
    } catch (e) {
      try { await output.cancel(); } catch (_) { /* already failed */ }
      throw e;
    } finally {
      if (o.signal) o.signal.removeEventListener('abort', onAbort);
      cleanup();
    }
  }

  /**
   * Saves one stream as-is (used for Dolby Vision, which must keep its
   * original boxes). Writes chunks sequentially to a plain WritableStream.
   */
  async function saveRaw(o) {
    // Fall back to backup URLs only before any byte is written; once the
    // body is piping, a failure aborts the target and cannot be resumed.
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
    const total = Number(res.headers.get('content-length')) || 0;
    let done = 0;
    const counter = new TransformStream({
      transform(chunk, ctl) {
        done += chunk.byteLength;
        if (o.onProgress && total) o.onProgress(done / total);
        ctl.enqueue(chunk);
      },
    });
    await res.body.pipeThrough(counter).pipeTo(o.writable, { signal: o.signal });
  }

  g.SpoolMux = { remux, saveRaw };
})(globalThis);
