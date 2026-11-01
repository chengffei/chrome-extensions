// Network test against the real bilibili API, signed out. Downloads one
// public video in every codec offered, remuxes it and checks the result
// with ffprobe. Run: SPOOL_LIVE=1 node --test test/live.test.js
// Optional: SPOOL_BVID=BV... SPOOL_OUT=/some/dir
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { load } = require('./load');

globalThis.Mediabunny = require('../vendor/mediabunny.min.js');
load('src/core.js');
load('src/mux.js');
const C = globalThis.SpoolCore;
const M = globalThis.SpoolMux;

const skip = !process.env.SPOOL_LIVE && 'set SPOOL_LIVE=1 to run';
const BVID = process.env.SPOOL_BVID || 'BV1GJ411x7h7';
const OUT = process.env.SPOOL_OUT || fs.mkdtempSync(path.join(os.tmpdir(), 'spool-'));
fs.mkdirSync(OUT, { recursive: true });
// The browser sends these on its own; Node has to add them.
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36',
  Referer: 'https://www.bilibili.com/',
};

async function getJson(url) {
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) { const e = new Error('HTTP ' + res.status); e.status = res.status; throw e; }
  return res.json();
}

// A WritableStream that honours {position} like FileSystemWritableFileStream.
function fileWritable(file) {
  const fd = fs.openSync(file, 'w');
  return new WritableStream({
    write(chunk) {
      if (chunk instanceof Uint8Array) fs.writeSync(fd, chunk);
      else fs.writeSync(fd, chunk.data, 0, chunk.data.length, chunk.position);
    },
    close() { fs.closeSync(fd); },
    abort() { fs.closeSync(fd); },
  });
}

function probe(file) {
  return JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file]));
}

test('live: sign, list and remux every codec', { skip, timeout: 10 * 60 * 1000 }, async () => {
  const client = C.createClient(getJson);
  const acct = await client.account();
  assert.strictEqual(acct.loggedIn, false);
  const info = await client.view(C.parseVideoPage('https://www.bilibili.com/video/' + BVID));
  const play = await client.playurl(info);
  const base = C.listOptions(play.dash, ['avc']);
  assert.ok(base.length > 0, 'got streams');
  const top = base[0];
  console.log('qualities', base.map((o) => o.label).join(','), 'codecs at top', top.codecs.join(','));

  const expectName = { avc: 'h264', hevc: 'hevc', av1: 'av1' };
  for (const codec of top.codecs) {
    const opt = C.listOptions(play.dash, [codec])[0];
    const file = path.join(OUT, `${BVID}-${codec}.mp4`);
    let last = 0;
    const t0 = Date.now();
    await M.remux({
      videoUrls: opt.video.urls,
      audioUrls: opt.audio.urls,
      writable: fileWritable(file),
      duration: info.duration,
      requestInit: { headers: HEADERS },
      onProgress: (p) => { last = p; },
    });
    const pr = probe(file);
    const v = pr.streams.find((s) => s.codec_type === 'video');
    const a = pr.streams.find((s) => s.codec_type === 'audio');
    const dur = Number(pr.format.duration);
    console.log(codec, v.codec_name, v.codec_tag_string, `${v.width}x${v.height}`, a.codec_name,
      dur.toFixed(1) + 's', (fs.statSync(file).size / 1e6).toFixed(1) + 'MB', ((Date.now() - t0) / 1000).toFixed(1) + 's');
    assert.strictEqual(last, 1);
    assert.strictEqual(v.codec_name, expectName[codec]);
    if (codec === 'hevc') assert.strictEqual(v.codec_tag_string, 'hvc1', 'QuickTime needs hvc1');
    assert.strictEqual(a.codec_name, 'aac');
    assert.ok(Math.abs(dur - info.duration) < 2, `duration ${dur} vs ${info.duration}`);
    // Decode the whole file once to catch broken packets.
    execFileSync('ffmpeg', ['-v', 'error', '-xerror', '-i', file, '-f', 'null', '-']);
  }
});

test('live: raw save keeps the original stream', { skip, timeout: 5 * 60 * 1000 }, async () => {
  const client = C.createClient(getJson);
  const info = await client.view(C.parseVideoPage('https://www.bilibili.com/video/' + BVID));
  const play = await client.playurl(info);
  const opt = C.listOptions(play.dash, ['avc'])[0];
  const file = path.join(OUT, `${BVID}-raw.m4s`);
  await M.saveRaw({ urls: opt.audio.urls, writable: fileWritable(file), requestInit: { headers: HEADERS } });
  assert.strictEqual(probe(file).streams[0].codec_name, 'aac');
});
