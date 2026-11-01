// Stream tests against local ffmpeg-made fixtures (offline).
// Run: node --test test/   (needs ffmpeg and ffprobe)
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { load } = require('./load');
const { fixtureDir, serve, REFERER } = require('./fixtures');

globalThis.Mediabunny = require('../vendor/mediabunny.min.js');
load('src/detect.js');
load('src/dash.js');
load('src/mux.js');
load('src/media.js');
const Media = globalThis.SpoolMedia;

const OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'spool-media-'));
const requestInit = { headers: { Referer: REFERER } };
let server;
let base;

test.before(async () => {
  const dir = fixtureDir();
  server = await serve(dir);
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server && server.close());

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

let tempCount = 0;
async function createTemp(kind) {
  const file = path.join(OUT, `temp-${kind}-${tempCount++}`);
  return {
    writable: fileWritable(file),
    blob: () => fs.openAsBlob(file),
    remove: async () => fs.rmSync(file, { force: true }),
  };
}

function check(file, { width, height, audio = true, video = true }) {
  const pr = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file]));
  const v = pr.streams.find((s) => s.codec_type === 'video');
  const a = pr.streams.find((s) => s.codec_type === 'audio');
  if (video) {
    assert.ok(v, 'has video');
    if (width) assert.strictEqual(v.width, width);
    if (height) assert.strictEqual(v.height, height);
  } else assert.ok(!v, 'no video');
  if (audio) assert.ok(a, 'has audio'); else assert.ok(!a, 'no audio');
  const dur = Number(pr.format.duration);
  assert.ok(Math.abs(dur - 12) < 0.6, 'duration ' + dur);
  execFileSync('ffmpeg', ['-v', 'error', '-xerror', '-i', file, '-f', 'null', '-']);
}

async function download(kind, rel, variant, name) {
  const item = { kind, url: base + rel };
  const file = path.join(OUT, name + '.mp4');
  let last = 0;
  await Media.run({ ...item, variant }, {
    writable: fileWritable(file), requestInit, createTemp, onProgress: (p) => { assert.ok(p >= last - 1e-9, 'progress monotonic'); last = p; },
  });
  assert.strictEqual(last, 1);
  return file;
}

test('HLS TS master: lists variants, downloads best and a chosen one', async () => {
  const info = await Media.probe({ kind: 'hls', url: base + '/hls-ts/master.m3u8' }, { requestInit });
  assert.deepStrictEqual(info.variants.map((v) => v.label), ['360P', '240P']);
  assert.ok(Math.abs(info.duration - 12) < 0.6);
  assert.deepStrictEqual(info.children.map((u) => new URL(u).pathname), ['/hls-ts/v360.m3u8', '/hls-ts/v240.m3u8']);
  check(await download('hls', '/hls-ts/master.m3u8', null, 'hls-best'), { width: 640, height: 360 });
  check(await download('hls', '/hls-ts/master.m3u8', info.variants[1].key, 'hls-240'), { height: 240 });
});

test('HLS media playlist with AES-128', async () => {
  const info = await Media.probe({ kind: 'hls', url: base + '/hls-aes/index.m3u8' }, { requestInit });
  assert.ok(!info.drm);
  check(await download('hls', '/hls-aes/index.m3u8', null, 'hls-aes'), { width: 640, height: 360 });
});

test('HLS fMP4 with separate audio rendition', async () => {
  check(await download('hls', '/hls-fmp4/master.m3u8', null, 'hls-fmp4'), { width: 640, height: 360 });
});

test('DASH SegmentTemplate with timeline and with numbers', async () => {
  for (const name of ['dash-timeline', 'dash-number']) {
    const info = await Media.probe({ kind: 'dash', url: `${base}/${name}/manifest.mpd` }, { requestInit });
    assert.deepStrictEqual(info.variants.map((v) => v.label), ['360P']);
    check(await download('dash', `/${name}/manifest.mpd`, null, name), { width: 640, height: 360 });
  }
});

test('direct file streams through unchanged', async () => {
  const file = await download('direct', '/direct.mp4', null, 'direct');
  assert.strictEqual(fs.statSync(file).size, fs.statSync(path.join(fixtureDir(), 'direct.mp4')).size);
});

test('DRM manifests are recognised and refused', async () => {
  assert.deepStrictEqual(await Media.probe({ kind: 'hls', url: base + '/drm/fairplay.m3u8' }, { requestInit }), { drm: true });
  assert.deepStrictEqual(await Media.probe({ kind: 'dash', url: base + '/drm/widevine.mpd' }, { requestInit }), { drm: true });
  await assert.rejects(Media.run({ kind: 'dash', url: base + '/drm/widevine.mpd' }, { writable: fileWritable(path.join(OUT, 'x')), requestInit, createTemp }), (e) => e.kind === 'drm');
});

test('missing Referer is rejected by the fixture server', async () => {
  await assert.rejects(Media.probe({ kind: 'hls', url: base + '/hls-ts/master.m3u8' }, {}));
});
