// 注入到页面（隔离环境）。重复注入时保留已有实例，scan 会刷新结果。
(() => {
  if (window.__lodestone) return;

  const RE = /magnet:\?[^\s"'<>（）【】「」《》，。；！？、]+/gi;
  const TRAIL = /[)\]}.,;:!?'"]+$/;
  // 裸哈希：40 位十六进制或 32 位 Base32，前后不能紧贴字母数字
  const HASH = /(?<![A-Za-z0-9])(?:[0-9a-fA-F]{40}|[A-Z2-7]{32})(?![A-Za-z0-9])/g;
  const PREFIX = 'magnet:?xt=urn:btih:';
  const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEXTAREA', 'TEMPLATE']);
  const HL = 'lodestone';

  // 资源名推测用
  const BLOCK = 'p,div,li,td,th,tr,dt,dd,pre,blockquote,section,article,header,footer,h1,h2,h3,h4,h5,h6,figcaption,table,ul,ol,dl';
  const GENERIC = /^(?:magnet|磁力|磁链|链接|下载|复制|点击|种子|bt|迅雷|地址|获取|打开|查看|播放|在线|here|link|download|copy|[\s:：\-—|()（）[\]【】<>《》\d.,，、#*·•])+$/i;
  const META = /^(?:大小|体积|日期|时间|发布|上传|更新|做种|下载数|完成数|文件数|热度|size|date|seeds?|peers?)?\s*[:：]?\s*(?:[\d.]+\s*(?:[kmgt]i?b|字节|bytes?)|\d{4}[-/.年]\d{1,2}[-/.月]\d{1,2}日?.*|\d+\s*(?:秒|分钟|小时|天|周|月|年)前)?\s*$/i;
  const FILEY = /\.(?:mkv|mp4|avi|mov|wmv|flv|ts|m2ts|iso|zip|rar|7z|epub|pdf|mp3|flac|ape)\b|\b(?:480p|720p|1080[pi]|2160p|4k|hdr|x26[45]|h\.?26[45]|hevc|avc|blu-?ray|bdrip|web-?dl|webrip|hdtv|remux|s\d{1,2}e\d{1,3})\b|第\s*\d+\s*[集话季]/i;
  const LABEL = /^(?:名称|资源名称?|文件名|片名|剧名|标题|name|title)\s*[:：]\s*(.+)$/i;
  const LABEL_ONLY = /^[^:：]{1,8}[:：]$/;
  const TITLE_ATTR = /title|name|subject|标题/i;
  const MAX_DIST = 4;

  let hits = [];
  let timer = 0;
  let restore = null;

  const keyOf = (url) => {
    const m = url.match(/xt=urn:btih:([a-z0-9]+)/i);
    return m ? m[1].toLowerCase() : url;
  };

  const dnOf = (url) => {
    try {
      return new URLSearchParams(url.slice(url.indexOf('?') + 1)).get('dn') || '';
    } catch {
      return '';
    }
  };

  const targetOf = (h) => h.el || h.node.parentElement;

  // 去掉磁链、哈希、首尾标点，剩下的才可能是名字
  function clean(text) {
    const t = text
      .replace(RE, ' ')
      .replace(HASH, ' ')
      .replace(/\s+/g, ' ')
      .replace(/^[\s:：\-—|·•>»]+|[\s:：\-—|·•<«]+$/g, '');
    const m = t.match(LABEL);
    return { text: (m ? m[1] : t).trim(), labeled: !!m };
  }

  // 把容器里的文字切成行：块级元素、<br>、pre 里的换行都算断行
  function linesOf(scope) {
    const lines = [];
    let cur = null;
    let block = null;
    const own = new Map();
    hits.forEach((h, i) => {
      const k = h.el || h.node;
      own.set(k, [...(own.get(k) || []), i]);
    });
    const mark = (l, k) => own.get(k).forEach((j) => {
      l.hits.add(j);
      l.pos.set(j, l.text.length);
    });
    const push = () => {
      if (cur && (cur.text.trim() || cur.hits.size)) lines.push(cur);
      cur = null;
    };
    const line = (b) => {
      if (!cur || b !== block) {
        push();
        block = b;
        cur = { text: '', hits: new Set(), pos: new Map(), weight: 0 };
      }
      return cur;
    };
    const walker = document.createTreeWalker(scope, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
      acceptNode(n) {
        if (n.nodeType === 1 && SKIP.has(n.tagName)) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    let count = 0;
    for (let n = walker.currentNode; n && count < 4000; n = walker.nextNode(), count++) {
      if (n.nodeType === 1) {
        if (n.tagName === 'BR') {
          push();
          block = null;
        } else if (own.has(n)) {
          mark(line(n.closest(BLOCK)), n);
        }
        continue;
      }
      const p = n.parentElement;
      if (!p) continue;
      const b = p.closest(BLOCK);
      const inHit = p.closest('a[href^="magnet:" i]');
      const pre = n.nodeValue.includes('\n') && getComputedStyle(p).whiteSpace.startsWith('pre');
      const parts = pre ? n.nodeValue.split('\n') : [n.nodeValue];
      let offset = 0;
      parts.forEach((part, k) => {
        if (k > 0) {
          push();
          block = null;
        }
        const l = line(b);
        // 只标记起点落在这一段里的磁链
        for (const j of own.get(n) || []) {
          const st = hits[j].start - offset;
          if (st >= 0 && st <= part.length) {
            l.hits.add(j);
            l.pos.set(j, l.text.length + st);
          }
        }
        offset += part.length + 1;
        if (inHit) {
          if (own.has(inHit)) mark(l, inHit);
          return; // 磁链锚文本不当作邻近名字
        }
        l.text += part;
        if (/^H[1-6]$/.test(p.tagName) || p.closest('h1,h2,h3,h4,h5,h6')) l.weight = Math.max(l.weight, 4);
        if (TITLE_ATTR.test(p.className + ' ' + p.id) || p.closest('[class*="title" i],[class*="name" i]')) {
          l.weight = Math.max(l.weight, 4);
        }
        if (p.closest('strong,b')) l.weight = Math.max(l.weight, 1);
        if (p.closest('a')) l.weight = Math.max(l.weight, 1);
      });
    }
    push();
    return lines;
  }

  function score(text, labeled, weight, dist, after) {
    if (text.length < 2 || GENERIC.test(text) || META.test(text) || LABEL_ONLY.test(text)) return -Infinity;
    let s = weight;
    if (labeled) s += 6;
    if (FILEY.test(text)) s += 4;
    if (text.length >= 6 && text.length <= 120) s += 1;
    if (text.length > 200) s -= 3;
    s -= dist + (after ? 0.5 : 0);
    return s;
  }

  // 向上找「只装着这一条磁链」的最大容器，当作这条资源的记录块
  function scopeOf(i) {
    const keys = hits.map((h) => keyOf(h.url));
    let el = targetOf(hits[i]);
    for (let p = el.parentElement; p && p !== document.body && p !== document.documentElement; p = p.parentElement) {
      const inside = new Set();
      hits.forEach((h, j) => p.contains(targetOf(h)) && inside.add(keys[j]));
      if (inside.size > 1) break;
      el = p;
    }
    return el;
  }

  function guessName(i) {
    const scope = scopeOf(i);
    const lines = linesOf(scope);
    const at = lines.findIndex((l) => l.hits.has(i));
    if (at < 0) return '';
    const key = keyOf(hits[i].url);
    const other = (l) => [...l.hits].some((j) => keyOf(hits[j].url) !== key);

    let best = '';
    let bestScore = -Infinity;
    const consider = (l, dist, after) => {
      const { text, labeled } = clean(l.text);
      const s = score(text, labeled, l.weight, dist, after) + (dist === 0 ? 2 : 0);
      if (s > bestScore) {
        bestScore = s;
        best = text;
      }
    };
    // 所在行拆成磁链前、磁链后两段分别打分
    const cur = lines[at];
    const pos = cur.pos.get(i) ?? cur.text.length;
    consider({ text: cur.text.slice(0, pos), weight: cur.weight }, 0, false);
    consider({ text: cur.text.slice(pos), weight: cur.weight }, 0, true);
    for (let k = at - 1, d = 1; k >= 0 && d <= MAX_DIST && !other(lines[k]); k--, d++) consider(lines[k], d, false);
    for (let k = at + 1, d = 1; k < lines.length && d <= MAX_DIST && !other(lines[k]); k++, d++) consider(lines[k], d, true);
    return best.length > 120 ? best.slice(0, 120) + '…' : best;
  }

  function scan() {
    hits = [];
    if (!document.body) return [];

    for (const a of document.querySelectorAll('a[href^="magnet:" i]')) {
      const url = a.getAttribute('href').trim();
      hits.push({ el: a, url, label: (a.textContent.trim() || a.title || '').trim() });
    }

    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode(n) {
        if (n.nodeValue.length < 32) return NodeFilter.FILTER_REJECT;
        const p = n.parentElement;
        if (!p || SKIP.has(p.tagName)) return NodeFilter.FILTER_REJECT;
        if (p.closest('a[href^="magnet:" i]')) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    for (let n; (n = walker.nextNode()); ) {
      const text = n.nodeValue;
      const taken = [];
      for (const m of text.matchAll(RE)) {
        const url = m[0].replace(TRAIL, '');
        taken.push([m.index, m.index + m[0].length]);
        hits.push({ node: n, start: m.index, end: m.index + url.length, url, label: '' });
      }
      for (const m of text.matchAll(HASH)) {
        const s = m.index;
        const e = s + m[0].length;
        if (taken.some(([a, b]) => s < b && e > a)) continue; // 已在完整磁链里
        if (/^\d+$/.test(m[0])) continue; // 纯数字多半是编号
        hits.push({ node: n, start: s, end: e, url: PREFIX + m[0], label: '', bare: true });
      }
    }

    // 名字优先级：dn 参数 > 链接文字 > 就近推测
    return hits.map((h, i) => {
      let name = dnOf(h.url);
      let source = name ? 'dn' : '';
      if (!name) {
        const label = clean(h.label).text;
        if (label && !GENERIC.test(label) && !META.test(label)) {
          name = label;
          source = 'link';
        }
      }
      if (!name) {
        try {
          name = guessName(i);
        } catch {
          name = '';
        }
        if (name) source = 'near';
      }
      return { i, url: h.url, key: keyOf(h.url), name, source, bare: !!h.bare };
    });
  }

  function ensureStyle() {
    if (document.getElementById(HL)) return;
    const s = document.createElement('style');
    s.id = HL;
    s.textContent = `::highlight(${HL}){background:#ffd60a;color:#1d1d1f}`;
    (document.head || document.documentElement).appendChild(s);
  }

  function clear() {
    clearTimeout(timer);
    if (window.CSS && CSS.highlights) CSS.highlights.delete(HL);
    if (restore) restore();
    restore = null;
  }

  // 返回 'ok' | 'hidden' | 'gone'
  function locate(i) {
    const h = hits[i];
    if (!h) return 'gone';
    const target = targetOf(h);
    if (!target || !target.isConnected) return 'gone';
    if (h.node && h.end > h.node.nodeValue.length) return 'gone';

    clear();
    // 折叠的 <details> 自动展开；其余隐藏元素如实报告
    for (let d = target.closest('details:not([open])'); d; d = d.parentElement?.closest('details:not([open])')) {
      d.open = true;
    }
    const visible = target.checkVisibility
      ? target.checkVisibility({ visibilityProperty: true })
      : target.getClientRects().length > 0;
    if (!visible) return 'hidden';
    target.scrollIntoView({ block: 'center', behavior: 'smooth' });

    const range = document.createRange();
    if (h.el) range.selectNodeContents(h.el);
    else {
      range.setStart(h.node, h.start);
      range.setEnd(h.node, h.end);
    }
    ensureStyle();
    if (window.CSS && CSS.highlights) CSS.highlights.set(HL, new Highlight(range));

    if (h.el) {
      const { outline, outlineOffset } = h.el.style;
      h.el.style.outline = '3px solid #0071e3';
      h.el.style.outlineOffset = '2px';
      restore = () => {
        h.el.style.outline = outline;
        h.el.style.outlineOffset = outlineOffset;
      };
    }
    timer = setTimeout(clear, 3000);
    return 'ok';
  }

  window.__lodestone = { scan, locate };
})();
