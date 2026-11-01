// End-to-end test in Chrome for Testing. Loads the unpacked extension,
// opens a local page that plays a direct MP4 and loads HLS, DASH and a
// DRM-protected playlist, downloads each from the popup and checks the
// files with ffprobe. Optionally repeats on a public bilibili video.
//
// Needs puppeteer, which is not a dependency of the extension:
//   npm i --prefix /tmp/spool-e2e puppeteer
//   NODE_PATH=/tmp/spool-e2e/node_modules node test/e2e.js [--bili BV...]
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const puppeteer = require('puppeteer');
const { fixtureDir, serve } = require('./fixtures');

const EXT = path.join(__dirname, '..');
const CONFLICT = path.join(__dirname, 'conflict-ext');
const OUT = process.env.SPOOL_OUT || fs.mkdtempSync(path.join(os.tmpdir(), 'spool-e2e-'));
const DL = path.join(OUT, 'downloads');
const biliArg = process.argv.indexOf('--bili');
const BVID = biliArg > 0 ? process.argv[biliArg + 1] : null;

const PAGE = `<!doctype html><title>Spool test page</title>
<video src="/direct.mp4" controls muted></video>
<script>
  for (const u of ['/hls-ts/master.m3u8', '/hls-ts/v360.m3u8', '/hls-fmp4/master.m3u8', '/dash-number/manifest.mpd', '/drm/fairplay.m3u8']) fetch(u);
  document.querySelector('video').play().catch(() => {});
</script>`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function probe(file) {
  const pr = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file]));
  execFileSync('ffmpeg', ['-v', 'error', '-xerror', '-i', file, '-f', 'null', '-']);
  const v = pr.streams.find((s) => s.codec_type === 'video');
  const a = pr.streams.find((s) => s.codec_type === 'audio');
  return `${v ? `${v.codec_name} ${v.width}x${v.height}` : 'no video'}, ${a ? a.codec_name : 'no audio'}, ${Number(pr.format.duration).toFixed(1)}s`;
}

async function popupRows(popup) {
  return popup.$$eval('.row', (rows) => rows.map((r) => ({
    text: r.innerText.replace(/\s+/g, ' ').trim(),
    canDownload: !!r.querySelector('button.primary:not([disabled])'),
    saved: /Saved|已保存/.test(r.innerText),
    failed: !!r.querySelector('.meta.err'),
  })));
}

async function downloadAll(popup, expectCount) {
  for (let i = 0; i < 60; i++) {
    const btn = await popup.$('.row button.primary:not([disabled])');
    if (!btn) break;
    await btn.click();
    await sleep(300);
  }
  const end = Date.now() + 5 * 60 * 1000;
  let rows;
  while (Date.now() < end) {
    rows = await popupRows(popup);
    if (rows.filter((r) => r.saved).length >= expectCount || rows.some((r) => r.failed)) break;
    await sleep(500);
  }
  return rows;
}

(async () => {
  fs.mkdirSync(DL, { recursive: true });
  const server = await serve(fixtureDir(), { page: PAGE, referer: (s) => `http://127.0.0.1:${s.address().port}/page.html` });
  const base = `http://127.0.0.1:${server.address().port}`;
  // Download folder set through preferences (CDP download overrides rename files).
  const profile = path.join(OUT, 'profile');
  fs.mkdirSync(path.join(profile, 'Default'), { recursive: true });
  fs.writeFileSync(path.join(profile, 'Default', 'Preferences'), JSON.stringify({ download: { default_directory: DL, prompt_for_download: false } }));
  const browser = await puppeteer.launch({
    headless: true,
    userDataDir: profile,
    // A second extension that listens for file names, loaded last, to make
    // sure Spool's files keep their names next to download managers.
    args: [`--disable-extensions-except=${EXT},${CONFLICT}`, `--load-extension=${EXT},${CONFLICT}`],
  });
  let failed = false;
  try {
    const sw = await browser.waitForTarget((t) => t.type() === 'service_worker' && t.url().endsWith('/src/background.js'));
    const extId = new URL(sw.url()).host;
    const worker = await sw.worker();

    // ---- Generic page ----
    const page = await browser.newPage();
    await page.goto(base + '/page.html', { waitUntil: 'networkidle0' });
    const tabId = await worker.evaluate(async () => (await chrome.tabs.query({ title: 'Spool test page' }))[0].id);

    const popup = await browser.newPage();
    await popup.goto(`chrome-extension://${extId}/src/popup.html?tabId=${tabId}`);
    await sleep(2500);
    let rows = await popupRows(popup);
    console.log('found:\n  ' + rows.map((r) => r.text).join('\n  '));
    await popup.screenshot({ path: path.join(OUT, 'popup-list.png') });
    const expect = (cond, msg) => { if (!cond) { failed = true; console.error('FAIL', msg); } };
    // direct MP4, HLS TS master (2 variants), HLS fMP4 master, DASH, DRM; v360.m3u8 is hidden under its master.
    expect(rows.length === 5, '5 rows, got ' + rows.length);
    expect(!rows.some((r) => /v360\.m3u8/.test(r.text)), 'child playlist hidden');
    expect(rows.some((r) => /DRM/.test(r.text) && !r.canDownload), 'DRM row is disabled');
    expect(rows.some((r) => /360P.*240P|360P 240P/.test(r.text)), 'HLS master shows both variants');

    rows = await downloadAll(popup, 4);
    await popup.screenshot({ path: path.join(OUT, 'popup-done.png') });
    console.log('after download:\n  ' + rows.map((r) => r.text).join('\n  '));
    expect(rows.filter((r) => r.saved).length === 4, '4 downloads saved');
    await sleep(1000);
    const files = fs.readdirSync(DL).filter((f) => !f.endsWith('.crdownload') && !f.startsWith('.'));
    for (const f of files) console.log('file:', f, '->', probe(path.join(DL, f)));
    expect(files.length === 4, '4 files, got ' + files.length);
    expect(files.every((f) => f.startsWith('Spool test page')), 'files named after the page');

    // ---- bilibili ----
    if (BVID) {
      await page.goto(`https://www.bilibili.com/video/${BVID}/`, { waitUntil: 'domcontentloaded' });
      await sleep(3000);
      await popup.goto(`chrome-extension://${extId}/src/popup.html?tabId=${tabId}`);
      await popup.waitForFunction(() => /bilibili/.test(document.body.innerText) && !/读取中|Reading/.test(document.body.innerText), { timeout: 30000 });
      console.log('bilibili:', (await popupRows(popup)).map((r) => r.text).join(' | '));
      const before = new Set(fs.readdirSync(DL));
      await (await popup.$('.row button.primary')).click();
      const end = Date.now() + 5 * 60 * 1000;
      let added = [];
      while (Date.now() < end) {
        added = fs.readdirSync(DL).filter((f) => !before.has(f) && !f.endsWith('.crdownload') && !f.startsWith('.'));
        if (added.length) break;
        const r = await popupRows(popup);
        if (r.some((x) => x.failed)) { console.error('bilibili failed:', r.map((x) => x.text)); break; }
        await sleep(500);
      }
      await sleep(1000);
      expect(added.length === 1, 'bilibili file saved');
      for (const f of added) console.log('file:', f, '->', probe(path.join(DL, f)));
    }

    const dls = await worker.evaluate(async () => (await chrome.downloads.search({})).map((d) => `${d.state} ${d.mime} ${d.filename}`));
    console.log('downloads:\n  ' + dls.join('\n  '));
    const leftovers = await worker.evaluate(async () => (await chrome.declarativeNetRequest.getSessionRules()).length);
    expect(leftovers === 0, 'session rules cleaned up, left ' + leftovers);
    console.log(failed ? 'FAIL' : 'PASS', '— output in', OUT);
  } finally {
    await browser.close();
    server.close();
  }
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
