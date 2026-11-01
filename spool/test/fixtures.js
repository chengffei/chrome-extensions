// Builds local test streams with ffmpeg and serves them over HTTP, so the
// stream tests run offline and deterministically. The server rejects
// requests without the expected Referer, like many video CDNs do.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { execFileSync } = require('node:child_process');

const REFERER = 'https://example.test/watch';

function ff(args, cwd) {
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { cwd, stdio: ['ignore', 'ignore', 'inherit'] });
}

function build(dir) {
  const src = ['-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=25', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '12'];
  const enc = ['-c:v', 'libx264', '-preset', 'ultrafast', '-g', '50', '-keyint_min', '50', '-sc_threshold', '0', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '96k'];
  const mk = (d) => fs.mkdirSync(path.join(dir, d), { recursive: true });

  // Direct file.
  ff([...src, ...enc, '-movflags', '+faststart', 'direct.mp4'], dir);

  // HLS, MPEG-TS segments, two variants plus a master.
  mk('hls-ts');
  for (const [h, br] of [[360, '800k'], [240, '400k']]) {
    ff([...src, ...enc, '-vf', `scale=-2:${h}`, '-b:v', br, '-f', 'hls', '-hls_time', '2', '-hls_playlist_type', 'vod',
      '-hls_segment_filename', `v${h}_%03d.ts`, `v${h}.m3u8`], path.join(dir, 'hls-ts'));
  }
  fs.writeFileSync(path.join(dir, 'hls-ts', 'master.m3u8'), [
    '#EXTM3U',
    '#EXT-X-STREAM-INF:BANDWIDTH=900000,RESOLUTION=640x360,CODECS="avc1.42c01e,mp4a.40.2"', 'v360.m3u8',
    '#EXT-X-STREAM-INF:BANDWIDTH=500000,RESOLUTION=426x240,CODECS="avc1.42c015,mp4a.40.2"', 'v240.m3u8', '',
  ].join('\n'));

  // HLS with AES-128 encryption.
  mk('hls-aes');
  fs.writeFileSync(path.join(dir, 'hls-aes', 'key.bin'), Buffer.from('00112233445566778899aabbccddeeff', 'hex'));
  fs.writeFileSync(path.join(dir, 'hls-aes', 'keyinfo'), 'key.bin\nkey.bin\n');
  ff([...src, ...enc, '-f', 'hls', '-hls_time', '2', '-hls_playlist_type', 'vod', '-hls_key_info_file', 'keyinfo',
    '-hls_segment_filename', 's_%03d.ts', 'index.m3u8'], path.join(dir, 'hls-aes'));

  // HLS, fMP4 segments, audio as a separate rendition.
  mk('hls-fmp4');
  const fdir = path.join(dir, 'hls-fmp4');
  ff([...src, ...enc, '-an', '-f', 'hls', '-hls_time', '2', '-hls_playlist_type', 'vod', '-hls_segment_type', 'fmp4',
    '-hls_fmp4_init_filename', 'v_init.mp4', '-hls_segment_filename', 'v_%03d.m4s', 'video.m3u8'], fdir);
  ff([...src, ...enc, '-vn', '-f', 'hls', '-hls_time', '2', '-hls_playlist_type', 'vod', '-hls_segment_type', 'fmp4',
    '-hls_fmp4_init_filename', 'a_init.mp4', '-hls_segment_filename', 'a_%03d.m4s', 'audio.m3u8'], fdir);
  fs.writeFileSync(path.join(fdir, 'master.m3u8'), [
    '#EXTM3U', '#EXT-X-VERSION:7',
    '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="English",LANGUAGE="en",DEFAULT=YES,AUTOSELECT=YES,URI="audio.m3u8"',
    '#EXT-X-STREAM-INF:BANDWIDTH=900000,RESOLUTION=640x360,CODECS="avc1.42c01e,mp4a.40.2",AUDIO="aud"', 'video.m3u8', '',
  ].join('\n'));

  // DASH, SegmentTemplate with and without SegmentTimeline.
  for (const [name, timeline] of [['dash-timeline', '1'], ['dash-number', '0']]) {
    mk(name);
    ff([...src, ...enc, '-map', '0:v', '-map', '1:a', '-f', 'dash', '-seg_duration', '2', '-use_template', '1',
      '-use_timeline', timeline, '-adaptation_sets', 'id=0,streams=v id=1,streams=a', 'manifest.mpd'], path.join(dir, name));
  }

  // DRM-protected manifests (never downloaded, only recognised).
  mk('drm');
  fs.writeFileSync(path.join(dir, 'drm', 'fairplay.m3u8'), [
    '#EXTM3U', '#EXT-X-TARGETDURATION:2', '#EXT-X-KEY:METHOD=SAMPLE-AES,URI="skd://key",KEYFORMAT="com.apple.streamingkeydelivery",KEYFORMATVERSIONS="1"',
    '#EXTINF:2,', 'seg.ts', '#EXT-X-ENDLIST', '',
  ].join('\n'));
  const mpd = fs.readFileSync(path.join(dir, 'dash-number', 'manifest.mpd'), 'utf8')
    .replace(/<AdaptationSet([^>]*)>/g, '<AdaptationSet$1><ContentProtection schemeIdUri="urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed"/>');
  fs.writeFileSync(path.join(dir, 'drm', 'widevine.mpd'), mpd);
}

const TYPES = { m3u8: 'application/vnd.apple.mpegurl', mpd: 'application/dash+xml', mp4: 'video/mp4', ts: 'video/mp2t', m4s: 'video/iso.segment', bin: 'application/octet-stream' };

// Static server with Range support and a Referer check.
function serve(dir, opts = {}) {
  const server = http.createServer((req, res) => {
    const pathname = new URL(req.url, 'http://x').pathname;
    if (opts.page && pathname === '/page.html') { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(opts.page); return; }
    const expected = opts.referer ? opts.referer(server) : REFERER;
    if (req.headers.referer !== expected) { res.writeHead(403); res.end('referer'); return; }
    const file = path.join(dir, decodeURIComponent(new URL(req.url, 'http://x').pathname));
    if (!file.startsWith(dir) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end(); return; }
    const size = fs.statSync(file).size;
    const type = TYPES[path.extname(file).slice(1)] || 'application/octet-stream';
    const m = /bytes=(\d+)-(\d*)/.exec(req.headers.range || '');
    if (m) {
      const start = Number(m[1]);
      const end = m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
      res.writeHead(206, { 'Content-Type': type, 'Content-Length': end - start + 1, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Accept-Ranges': 'bytes' });
      fs.createReadStream(file, { start, end }).pipe(res);
    } else {
      res.writeHead(200, { 'Content-Type': type, 'Content-Length': size, 'Accept-Ranges': 'bytes' });
      fs.createReadStream(file).pipe(res);
    }
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

function fixtureDir() {
  const dir = path.join(os.tmpdir(), 'spool-fixtures-v1');
  if (!fs.existsSync(path.join(dir, 'drm', 'widevine.mpd'))) {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    build(dir);
  }
  return dir;
}

module.exports = { fixtureDir, serve, REFERER };
