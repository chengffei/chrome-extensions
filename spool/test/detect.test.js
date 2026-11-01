const test = require('node:test');
const assert = require('node:assert');
const { load } = require('./load');
load('src/detect.js');
load('src/dash.js');
const D = globalThis.SpoolDetect;
const H = (o) => Object.entries(o).map(([name, value]) => ({ name, value }));

test('classify by content type and extension', () => {
  const c = (url, headers = {}, statusCode = 200) => D.classify({ url, statusCode, responseHeaders: H(headers) });
  assert.strictEqual(c('https://a.com/x/index.m3u8?t=1').kind, 'hls');
  assert.strictEqual(c('https://a.com/play', { 'Content-Type': 'application/vnd.apple.mpegurl' }).kind, 'hls');
  assert.strictEqual(c('https://a.com/x.mpd').kind, 'dash');
  assert.strictEqual(c('https://a.com/v.mp4', { 'Content-Type': 'video/mp4', 'Content-Length': '5000000' }).kind, 'direct');
  assert.strictEqual(c('https://a.com/v', { 'Content-Type': 'video/webm', 'Content-Range': 'bytes 0-99/9000000' }, 206).size, 9000000);
  assert.strictEqual(c('https://a.com/song.mp3', { 'Content-Type': 'audio/mpeg', 'Content-Length': '4000000' }).audioOnly, true);
  assert.strictEqual(c('https://a.com/f.mp4', { 'Content-Type': 'application/octet-stream', 'Content-Length': '4000000' }).kind, 'direct');
});

test('ignore segments, tiny files, errors, non-http and YouTube', () => {
  const c = (url, headers = {}, statusCode = 200) => D.classify({ url, statusCode, responseHeaders: H(headers) });
  assert.strictEqual(c('https://a.com/seg_001.ts', { 'Content-Type': 'video/mp2t' }), null);
  assert.strictEqual(c('https://a.com/chunk.m4s', { 'Content-Type': 'video/mp4' }), null);
  assert.strictEqual(c('https://a.com/ad.mp4', { 'Content-Type': 'video/mp4', 'Content-Length': '1000' }), null);
  assert.strictEqual(c('https://a.com/x.m3u8', {}, 404), null);
  assert.strictEqual(c('blob:https://a.com/1'), null);
  assert.strictEqual(c('https://rr1---sn-x.googlevideo.com/videoplayback?mime=video/mp4', { 'Content-Type': 'video/mp4' }), null);
  assert.strictEqual(c('https://www.youtube.com/x.m3u8'), null);
  assert.strictEqual(c('https://a.com/page.html', { 'Content-Type': 'text/html' }), null);
  assert.ok(D.isBlockedHost('m.youtube.com'));
  assert.ok(!D.isBlockedHost('notyoutube.com'));
});

test('dedupeKey drops range parameters', () => {
  assert.strictEqual(D.dedupeKey('https://a.com/v.mp4?range=0-100&k=1'), D.dedupeKey('https://a.com/v.mp4?k=1&range=200-300'));
});

test('MPD: template, list, single file, inheritance, durations', () => {
  const xml = `<?xml version="1.0"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static" mediaPresentationDuration="PT10.5S">
  <BaseURL>https://cdn.test/v/</BaseURL>
  <Period>
    <AdaptationSet contentType="video" mimeType="video/mp4">
      <SegmentTemplate timescale="1000" duration="4000" startNumber="1" initialization="$RepresentationID$/init.mp4" media="$RepresentationID$/seg-$Number%03d$.m4s"/>
      <Representation id="720" bandwidth="2000000" width="1280" height="720"/>
      <Representation id="1080" bandwidth="4000000" width="1920" height="1080"/>
    </AdaptationSet>
    <AdaptationSet mimeType="audio/mp4">
      <Representation id="a" bandwidth="128000">
        <SegmentList><Initialization sourceURL="a/init.mp4"/><SegmentURL media="a/1.m4s"/><SegmentURL media="a/2.m4s" mediaRange="0-99"/></SegmentList>
      </Representation>
      <Representation id="a2" bandwidth="64000"><BaseURL>audio-low.mp4</BaseURL></Representation>
    </AdaptationSet>
    <AdaptationSet mimeType="text/vtt"><Representation id="sub"/></AdaptationSet>
  </Period>
</MPD>`;
  const m = globalThis.SpoolDash.parseMpd(xml, 'https://site.test/m.mpd');
  assert.strictEqual(m.duration, 10.5);
  assert.deepStrictEqual(m.video.map((r) => r.id), ['1080', '720']);
  assert.deepStrictEqual(m.video[0].segments.map((s) => s.url), [
    'https://cdn.test/v/1080/init.mp4', 'https://cdn.test/v/1080/seg-001.m4s', 'https://cdn.test/v/1080/seg-002.m4s', 'https://cdn.test/v/1080/seg-003.m4s']);
  assert.deepStrictEqual(m.audio[0].segments, [
    { url: 'https://cdn.test/v/a/init.mp4', range: undefined }, { url: 'https://cdn.test/v/a/1.m4s', range: undefined }, { url: 'https://cdn.test/v/a/2.m4s', range: '0-99' }]);
  assert.strictEqual(m.audio[1].single, 'https://cdn.test/v/audio-low.mp4');
  assert.strictEqual(m.drm, false);
  assert.strictEqual(globalThis.SpoolDash.isoDuration('PT1H2M3.5S'), 3723.5);
});

test('MPD: SegmentTimeline with repeats and $Time$', () => {
  const xml = `<MPD><Period duration="PT6S"><AdaptationSet contentType="video">
    <Representation id="v" bandwidth="1" height="360"><SegmentTemplate timescale="10" media="t$Time$.m4s" initialization="i.mp4">
      <SegmentTimeline><S t="0" d="20" r="1"/><S d="20"/></SegmentTimeline></SegmentTemplate></Representation>
  </AdaptationSet></Period></MPD>`;
  const m = globalThis.SpoolDash.parseMpd(xml, 'https://s.test/a/m.mpd');
  assert.deepStrictEqual(m.video[0].segments.map((s) => s.url.split('/').pop()), ['i.mp4', 't0.m4s', 't20.m4s', 't40.m4s']);
});
