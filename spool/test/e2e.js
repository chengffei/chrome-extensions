// End-to-end test in Chrome for Testing: loads the unpacked extension,
// opens a public video signed out, toggles the panel, downloads through the
// real File System Access writer (pointed at the page's private file
// system instead of a save dialog) and checks the file with ffprobe.
//
// Needs puppeteer (not a dependency of the extension):
//   npm i --prefix /tmp/spool-e2e puppeteer
//   NODE_PATH=/tmp/spool-e2e/node_modules node test/e2e.js [BVID]
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const puppeteer = require('puppeteer');

const EXT = path.join(__dirname, '..');
const BVID = process.argv[2] || 'BV1GJ411x7h7';
const OUT = process.env.SPOOL_OUT || fs.mkdtempSync(path.join(os.tmpdir(), 'spool-e2e-'));

(async () => {
  const browser = await puppeteer.launch({
    headless: true,
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--lang=zh-CN'],
  });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900 });
    await page.goto(`https://www.bilibili.com/video/${BVID}/`, { waitUntil: 'domcontentloaded' });

    // Find Spool's isolated world and swap the save dialog for a file in
    // the origin private file system. Everything else is the shipped code.
    const cdp = await page.createCDPSession();
    const worlds = [];
    cdp.on('Runtime.executionContextCreated', (e) => worlds.push(e.context));
    await cdp.send('Runtime.enable');
    const deadline = Date.now() + 20000;
    let world;
    while (!(world = worlds.find((c) => c.name === 'Spool' || c.name.startsWith('Spool'))) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 200));
    }
    if (!world) throw new Error('content script did not load');
    const inWorld = async (expression) => {
      const r = await cdp.send('Runtime.evaluate', { contextId: world.id, expression, awaitPromise: true, returnByValue: true });
      if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
      return r.result.value;
    };
    await inWorld(`window.showSaveFilePicker = async (o) => {
      const dir = await navigator.storage.getDirectory();
      window.__spoolTestName = o.suggestedName;
      return dir.getFileHandle('spool-test.mp4', { create: true });
    }; true`);

    // Toggle the panel the way the toolbar button does.
    const sw = await browser.waitForTarget((t) => t.type() === 'service_worker' && t.url().endsWith('src/background.js'));
    const worker = await sw.worker();
    // Without the "tabs" permission tab URLs are hidden, so try every tab.
    await worker.evaluate(async () => {
      for (const tab of await chrome.tabs.query({})) {
        try { await chrome.tabs.sendMessage(tab.id, { type: 'spool:toggle' }); return; } catch (_) { /* not ours */ }
      }
      throw new Error('no tab with Spool');
    });

    page.on('console', (m) => { if (/Spool/.test(m.text())) console.log('console:', m.text()); });
    const panelState = () => inWorld(`(() => { const p = document.getElementById('spool-host')?.shadowRoot?.querySelector('.panel');
      return p ? { rows: !!p.querySelector('.rows'), ok: !!p.querySelector('.msg.ok'), error: !!p.querySelector('.msg.error'), text: p.innerText } : null; })()`);
    const waitPanel = async (pred, ms) => {
      const end = Date.now() + ms;
      let st;
      while (Date.now() < end) {
        st = await panelState();
        if (st && (pred(st) || st.error)) return st;
        await new Promise((r) => setTimeout(r, 500));
      }
      throw new Error('timeout; panel: ' + JSON.stringify(st));
    };
    let st = await waitPanel((x) => x.rows, 30000);
    if (st.error) { await page.screenshot({ path: path.join(OUT, 'error.png') }); throw new Error(st.text); }
    const shadow = (sel) => page.evaluateHandle((q) => document.getElementById('spool-host').shadowRoot.querySelector(q), sel);
    const rows = await page.evaluate(() => [...document.getElementById('spool-host').shadowRoot.querySelectorAll('.row')]
      .map((e) => e.innerText.replace(/\s+/g, ' ')));
    console.log('options:', rows.join(' | '));
    await page.screenshot({ path: path.join(OUT, 'panel.png') });

    await (await shadow('button.primary')).click();
    st = await waitPanel((x) => x.ok, 5 * 60 * 1000);
    console.log('result:', st.text.split('\n').slice(0, 3).join(' / '));
    await page.screenshot({ path: path.join(OUT, 'done.png') });
    if (!st.ok) throw new Error(st.text);

    // Copy the file out in base64 chunks.
    const size = await inWorld(`navigator.storage.getDirectory().then(d => d.getFileHandle('spool-test.mp4')).then(h => h.getFile()).then(f => (window.__f = f).size)`);
    const file = path.join(OUT, `${BVID}-e2e.mp4`);
    const fd = fs.openSync(file, 'w');
    const CHUNK = 4 * 1024 * 1024;
    for (let off = 0; off < size; off += CHUNK) {
      const b64 = await inWorld(`window.__f.slice(${off}, ${off + CHUNK}).arrayBuffer().then(b => {
        let s = ''; const u = new Uint8Array(b);
        for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000));
        return btoa(s); })`);
      fs.writeSync(fd, Buffer.from(b64, 'base64'));
    }
    fs.closeSync(fd);
    console.log('suggested name:', await inWorld('window.__spoolTestName'));

    const pr = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file]));
    const v = pr.streams.find((s) => s.codec_type === 'video');
    const a = pr.streams.find((s) => s.codec_type === 'audio');
    console.log('file:', file, (size / 1e6).toFixed(1) + 'MB', v.codec_name, v.codec_tag_string, `${v.width}x${v.height}`,
      a && a.codec_name, Number(pr.format.duration).toFixed(1) + 's');
    execFileSync('ffmpeg', ['-v', 'error', '-xerror', '-i', file, '-f', 'null', '-']);
    console.log('PASS');
  } finally {
    await browser.close();
  }
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
