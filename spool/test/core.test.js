// Offline unit tests. Run: node --test test/
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const { load } = require('./load');
load('src/core.js');
const C = globalThis.SpoolCore;

test('md5 matches node:crypto', () => {
  for (const s of ['', 'a', 'abc', '中文 bilibili', 'x'.repeat(55), 'x'.repeat(56), 'x'.repeat(64), 'y'.repeat(1000)]) {
    assert.strictEqual(C.md5(s), crypto.createHash('md5').update(s, 'utf8').digest('hex'), JSON.stringify(s.slice(0, 10)));
  }
});

test('WBI signature matches the published example', () => {
  const key = C.mixinKey(
    'https://i0.hdslb.com/bfs/wbi/7cd084941338484aae1ad9425b84077c.png',
    'https://i0.hdslb.com/bfs/wbi/4932caff0ff746eab6f01bf08b70ac45.png');
  assert.strictEqual(key, 'ea1db124af3c7062474693fa704f4ff8');
  const q = C.signWbi({ foo: '114', bar: '514', zab: 1919810 }, key, 1702204169);
  assert.strictEqual(q, 'bar=514&foo=114&wts=1702204169&zab=1919810&w_rid=8f6f2b5b3d485fe1886cec6a0be8c5d4');
});

test('WBI strips reserved characters from values', () => {
  assert.match(C.signWbi({ a: "x!'()*y" }, 'k'.repeat(32), 1), /^a=xy&wts=1&/);
});

test('fnval enables every feature bit', () => {
  assert.strictEqual(C.FNVAL, 4048);
});

test('parseVideoPage', () => {
  assert.deepStrictEqual(C.parseVideoPage('https://www.bilibili.com/video/BV1GJ411x7h7/?p=3&t=1'), { bvid: 'BV1GJ411x7h7', p: 3 });
  assert.deepStrictEqual(C.parseVideoPage('https://www.bilibili.com/video/av170001'), { aid: '170001', p: 1 });
  assert.strictEqual(C.parseVideoPage('https://www.bilibili.com/bangumi/play/ep1'), null);
  assert.strictEqual(C.parseVideoPage('https://space.bilibili.com/1'), null);
});

const dash = {
  video: [
    { id: 126, codecid: 12, bandwidth: 20e6, baseUrl: 'dv', width: 3840, height: 2160 },
    { id: 120, codecid: 7, bandwidth: 16e6, baseUrl: '4k-avc' },
    { id: 120, codecid: 12, bandwidth: 12e6, baseUrl: '4k-hevc', backupUrl: ['4k-hevc-b'] },
    { id: 120, codecid: 13, bandwidth: 10e6, baseUrl: '4k-av1' },
    { id: 80, codecid: 7, bandwidth: 3e6, baseUrl: '1080-avc' },
    { id: 80, codecid: 99, bandwidth: 3e6, baseUrl: 'unknown-codec' },
  ],
  audio: [
    { id: 30216, bandwidth: 64e3, baseUrl: 'a64' },
    { id: 30280, bandwidth: 192e3, baseUrl: 'a192' },
  ],
  dolby: { audio: [{ id: 30250, bandwidth: 448e3, baseUrl: 'dolby' }] },
  flac: null,
};

test('listOptions orders by quality and codec preference', () => {
  const opts = C.listOptions(dash, ['hevc', 'av1', 'avc']);
  assert.deepStrictEqual(opts.map((o) => o.qn), [126, 120, 80]);
  const k4 = opts[1];
  assert.strictEqual(k4.video.codec, 'hevc');
  assert.deepStrictEqual(k4.video.urls, ['4k-hevc', '4k-hevc-b']);
  assert.deepStrictEqual(k4.codecs, ['hevc', 'av1', 'avc']);
  assert.strictEqual(C.listOptions(dash, ['avc'])[1].video.codec, 'avc');
  assert.strictEqual(opts[2].video.codec, 'avc', 'falls back when preferred codec is missing');
});

test('audio prefers Hi-Res, then Dolby, then highest AAC', () => {
  assert.strictEqual(C.listOptions(dash, ['avc'])[0].audio.codec, 'eac3');
  const withFlac = { ...dash, flac: { audio: { id: 30251, bandwidth: 1e6, baseUrl: 'flac' } } };
  assert.strictEqual(C.listOptions(withFlac, ['avc'])[0].audio.codec, 'flac');
  const plain = { ...dash, dolby: null };
  assert.strictEqual(C.listOptions(plain, ['avc'])[0].audio.urls[0], 'a192');
});

test('Dolby Vision is not merged and not the default', () => {
  const opts = C.listOptions(dash, ['hevc']);
  assert.strictEqual(opts[0].merge, false);
  assert.strictEqual(C.defaultOption(opts).qn, 120);
});

test('file names are safe', () => {
  const name = C.fileBase({ title: 'a/b:c*?"<>|\n d', bvid: 'BV1', p: 2, partTitle: 'x' }, { label: '4K' });
  assert.strictEqual(name, 'a b c d P2 x [BV1] 4K');
});

test('client maps API errors', async () => {
  const navOk = { code: 0, data: { isLogin: false, wbi_img: { img_url: '/a.png', sub_url: '/b.png' } } };
  const client = C.createClient(async (url) => (url.includes('/nav') ? navOk : { code: -412, message: 'blocked' }));
  await assert.rejects(client.view({ bvid: 'BV1', p: 1 }), (e) => e.kind === 'riskControl');
  const c2 = C.createClient(async () => { const e = new Error('x'); e.status = 412; throw e; });
  await assert.rejects(c2.view({ bvid: 'BV1', p: 1 }), (e) => e.kind === 'riskControl');
});

test('official CDN hosts come first', () => {
  const opts = C.listOptions({
    video: [{ id: 80, codecid: 7, bandwidth: 1, baseUrl: 'https://xy1.mcdn.bilivideo.cn:8082/v.m4s',
      backupUrl: ['https://h.edge.mountaintoys.cn:4483/v.m4s', 'https://upos-sz-mirrorcos.bilivideo.com/v.m4s'] }],
    audio: [],
  }, ['avc']);
  assert.deepStrictEqual(opts[0].video.urls.map((u) => new URL(u).hostname),
    ['upos-sz-mirrorcos.bilivideo.com', 'xy1.mcdn.bilivideo.cn', 'h.edge.mountaintoys.cn']);
  assert.strictEqual(opts[0].audio, null);
});
