// Spool core: bilibili API access, WBI signing and stream selection.
// Plain script with no dependencies. Loaded as a content script in the
// browser and through vm in the Node tests; exports to globalThis.SpoolCore.
(function (g) {
  'use strict';

  // ---------- MD5 (RFC 1321). WebCrypto has no MD5, and WBI signing needs it. ----------

  function md5(str) {
    const bytes = new TextEncoder().encode(str);
    const n = ((bytes.length + 8) >>> 6) + 1;
    const words = new Uint32Array(n * 16);
    for (let i = 0; i < bytes.length; i++) words[i >> 2] |= bytes[i] << ((i % 4) * 8);
    words[bytes.length >> 2] |= 0x80 << ((bytes.length % 4) * 8);
    const bitLen = bytes.length * 8;
    words[n * 16 - 2] = bitLen >>> 0;
    words[n * 16 - 1] = Math.floor(bitLen / 0x100000000);

    const S = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21];
    const K = new Uint32Array(64);
    for (let i = 0; i < 64; i++) K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 0x100000000);

    let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;
    for (let blk = 0; blk < n; blk++) {
      let a = a0, b = b0, c = c0, d = d0;
      for (let i = 0; i < 64; i++) {
        const r = i >> 4;
        let f, k;
        if (r === 0) { f = (b & c) | (~b & d); k = i; }
        else if (r === 1) { f = (d & b) | (~d & c); k = (5 * i + 1) % 16; }
        else if (r === 2) { f = b ^ c ^ d; k = (3 * i + 5) % 16; }
        else { f = c ^ (b | ~d); k = (7 * i) % 16; }
        const tmp = d;
        d = c;
        c = b;
        const x = (a + f + K[i] + words[blk * 16 + k]) >>> 0;
        const s = S[r * 4 + (i % 4)];
        b = (b + ((x << s) | (x >>> (32 - s)))) >>> 0;
        a = tmp;
      }
      a0 = (a0 + a) >>> 0; b0 = (b0 + b) >>> 0; c0 = (c0 + c) >>> 0; d0 = (d0 + d) >>> 0;
    }
    let hex = '';
    for (const v of [a0, b0, c0, d0]) {
      for (let i = 0; i < 4; i++) hex += ((v >>> (i * 8)) & 0xff).toString(16).padStart(2, '0');
    }
    return hex;
  }

  // ---------- WBI signing ----------

  const MIXIN_TABLE = [
    46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49,
    33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40,
    61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11,
    36, 20, 34, 44, 52,
  ];

  function keyFromUrl(url) {
    return url.slice(url.lastIndexOf('/') + 1).split('.')[0];
  }

  function mixinKey(imgUrl, subUrl) {
    const raw = keyFromUrl(imgUrl) + keyFromUrl(subUrl);
    return MIXIN_TABLE.map((i) => raw[i]).join('').slice(0, 32);
  }

  function signWbi(params, key, wts) {
    const all = { ...params, wts };
    const query = Object.keys(all).sort().map((k) => {
      const v = String(all[k]).replace(/[!'()*]/g, '');
      return encodeURIComponent(k) + '=' + encodeURIComponent(v);
    }).join('&');
    return query + '&w_rid=' + md5(query + key);
  }

  // ---------- Quality and codec tables ----------

  const QUALITIES = {
    127: { label: '8K', tier: 'vip' },
    126: { label: 'Dolby Vision', tier: 'vip' },
    125: { label: 'HDR', tier: 'vip' },
    120: { label: '4K', tier: 'vip' },
    116: { label: '1080P60', tier: 'vip' },
    112: { label: '1080P+', tier: 'vip' },
    100: { label: 'AI 1080P', tier: 'vip' },
    80: { label: '1080P', tier: 'login' },
    74: { label: '720P60', tier: 'login' },
    64: { label: '720P', tier: 'login' },
    32: { label: '480P', tier: 'guest' },
    16: { label: '360P', tier: 'guest' },
    6: { label: '240P', tier: 'guest' },
  };

  const CODECS = { 7: 'avc', 12: 'hevc', 13: 'av1' };

  // Dolby Vision needs a dvcC box that the in-browser muxer does not write,
  // so that quality is saved as the original separate streams instead.
  const NO_MERGE = new Set([126]);

  const AUDIO_LABELS = {
    30251: 'Hi-Res', 30250: 'Dolby Atmos', 30280: '192K', 30232: '132K', 30216: '64K',
  };

  // All feature bits: DASH 16, HDR 64, 4K 128, Dolby audio 256,
  // Dolby Vision 512, 8K 1024, AV1 2048. The server still caps the
  // result at what the signed-in account may play.
  const FNVAL = 16 | 64 | 128 | 256 | 512 | 1024 | 2048;

  // ---------- Page parsing ----------

  function parseVideoPage(href) {
    const u = new URL(href);
    const m = u.pathname.match(/^\/video\/(BV[0-9A-Za-z]{10}|av\d+)/i);
    if (!m) return null;
    const id = m[1];
    const p = Math.max(1, parseInt(u.searchParams.get('p') || '1', 10) || 1);
    return /^bv/i.test(id) ? { bvid: 'BV' + id.slice(2), p } : { aid: id.slice(2), p };
  }

  // ---------- API ----------

  class ApiError extends Error {
    constructor(kind, detail) {
      super(kind + (detail ? ': ' + detail : ''));
      this.kind = kind;
      this.detail = detail;
    }
  }

  function classify(code) {
    if (code === -101) return 'needLogin';
    if (code === -352 || code === -412 || code === -509 || code === 412) return 'riskControl';
    if (code === -404 || code === 62002 || code === 62004) return 'notFound';
    if (code === -403 || code === -10403 || code === 87007 || code === 87008) return 'noPermission';
    return 'apiError';
  }

  // getJson(url) must perform the request the way the environment needs:
  // in the browser with the user's own cookies, in tests with plain headers.
  function createClient(getJson) {
    let cachedKey = null;
    let cachedAt = 0;

    async function call(url) {
      let body;
      try {
        body = await getJson(url);
      } catch (e) {
        if (e && e.status === 412) throw new ApiError('riskControl', 'HTTP 412');
        throw new ApiError('network', e && e.message);
      }
      if (body.code !== 0) throw new ApiError(classify(body.code), body.code + ' ' + (body.message || ''));
      return body.data;
    }

    async function account() {
      // nav answers code -101 for guests but still carries the WBI keys.
      const body = await getJson('https://api.bilibili.com/x/web-interface/nav');
      const d = body.data || {};
      if (!d.wbi_img) throw new ApiError(classify(body.code), 'nav ' + body.code);
      cachedKey = mixinKey(d.wbi_img.img_url, d.wbi_img.sub_url);
      cachedAt = Date.now();
      return {
        loggedIn: !!d.isLogin,
        name: d.uname || '',
        vip: !!(d.isLogin && d.vipStatus === 1),
      };
    }

    async function wbiKey() {
      if (!cachedKey || Date.now() - cachedAt > 10 * 60 * 1000) await account();
      return cachedKey;
    }

    async function view(page) {
      const q = page.bvid ? 'bvid=' + page.bvid : 'aid=' + page.aid;
      const d = await call('https://api.bilibili.com/x/web-interface/view?' + q);
      const part = (d.pages || [])[page.p - 1] || (d.pages || [])[0];
      if (!part) throw new ApiError('notFound', 'no pages');
      return {
        bvid: d.bvid,
        title: d.title,
        owner: d.owner && d.owner.name,
        cid: part.cid,
        p: part.page,
        partTitle: (d.pages || []).length > 1 ? part.part : '',
        duration: part.duration,
      };
    }

    async function playurl(info) {
      const params = { bvid: info.bvid, cid: info.cid, qn: 127, fnval: FNVAL, fnver: 0, fourk: 1 };
      const wts = Math.round(Date.now() / 1000);
      const d = await call('https://api.bilibili.com/x/player/wbi/playurl?' + signWbi(params, await wbiKey(), wts));
      if (!d.dash) throw new ApiError('noDash', 'format ' + d.format);
      return d;
    }

    return { account, view, playurl };
  }

  // ---------- Stream selection ----------

  // Prefer bilibili's own CDN (upos-*.bilivideo.com): it honours range
  // requests. Peer CDN hosts (mcdn.bilivideo.cn and third-party domains)
  // sometimes ignore Range, which forces slower sequential reads.
  function hostScore(url) {
    let host = '';
    try { host = new URL(url).hostname; } catch (_) { return 3; }
    if (/^upos-.*\.bilivideo\.com$/.test(host)) return 0;
    if (/\.bilivideo\.com$/.test(host)) return 1;
    if (/\.bilivideo\.cn$/.test(host)) return 2;
    return 3;
  }

  function urlsOf(s) {
    const list = [s.baseUrl || s.base_url].concat(s.backupUrl || s.backup_url || []).filter(Boolean);
    return list
      .map((url, i) => ({ url, i, score: hostScore(url) }))
      .sort((a, b) => a.score - b.score || a.i - b.i)
      .map((x) => x.url);
  }

  function bestAudio(dash) {
    const flac = dash.flac && dash.flac.audio;
    if (flac) return toAudio(flac, 'flac');
    const dolby = dash.dolby && dash.dolby.audio && dash.dolby.audio[0];
    if (dolby) return toAudio(dolby, 'eac3');
    const plain = (dash.audio || []).slice().sort((a, b) => b.bandwidth - a.bandwidth)[0];
    return plain ? toAudio(plain, 'aac') : null;
  }

  function toAudio(s, codec) {
    return { id: s.id, label: AUDIO_LABELS[s.id] || String(s.id), codec, bandwidth: s.bandwidth, urls: urlsOf(s) };
  }

  // codecOrder: e.g. ['hevc', 'av1', 'avc']; the first one available wins.
  function listOptions(dash, codecOrder) {
    const byQuality = new Map();
    for (const v of dash.video || []) {
      const codec = CODECS[v.codecid];
      if (!codec) continue;
      if (!byQuality.has(v.id)) byQuality.set(v.id, []);
      byQuality.get(v.id).push({ ...v, codec });
    }
    const audio = bestAudio(dash);
    const options = [];
    for (const [id, streams] of byQuality) {
      streams.sort((a, b) => rank(a.codec, codecOrder) - rank(b.codec, codecOrder) || b.bandwidth - a.bandwidth);
      const v = streams[0];
      const q = QUALITIES[id] || { label: String(id), tier: 'vip' };
      options.push({
        qn: id,
        label: q.label,
        tier: q.tier,
        merge: !NO_MERGE.has(id),
        video: {
          codec: v.codec, width: v.width, height: v.height, fps: v.frameRate || v.frame_rate,
          bandwidth: v.bandwidth, urls: urlsOf(v),
        },
        codecs: streams.map((s) => s.codec),
        audio,
      });
    }
    options.sort((a, b) => b.qn - a.qn);
    return options;
  }

  function rank(codec, order) {
    const i = order.indexOf(codec);
    return i < 0 ? 99 : i;
  }

  // Default choice: the highest quality that can be merged into one file.
  function defaultOption(options) {
    return options.find((o) => o.merge) || options[0] || null;
  }

  function estimateBytes(option, seconds) {
    const bps = (option.video.bandwidth || 0) + ((option.audio && option.audio.bandwidth) || 0);
    return Math.round((bps / 8) * (seconds || 0));
  }

  // ---------- File names ----------

  function safeName(s) {
    return String(s)
      .replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 120) || 'video';
  }

  function fileBase(info, option) {
    const part = info.partTitle ? ` P${info.p} ${info.partTitle}` : '';
    return safeName(`${info.title}${part} [${info.bvid}] ${option.label}`);
  }

  g.SpoolCore = {
    md5, mixinKey, signWbi, parseVideoPage, createClient, listOptions, defaultOption,
    estimateBytes, fileBase, safeName, ApiError, QUALITIES, FNVAL,
  };
})(globalThis);
