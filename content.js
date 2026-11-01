// 注入到页面（隔离环境）。重复注入时保留已有实例，scan 会刷新结果。
(() => {
  if (window.__magnetFinder) return;

  const RE = /magnet:\?[^\s"'<>（）【】「」《》，。；！？、]+/gi;
  const TRAIL = /[)\]}.,;:!?'"]+$/;
  // 裸哈希：40 位十六进制或 32 位 Base32，前后不能紧贴字母数字
  const HASH = /(?<![A-Za-z0-9])(?:[0-9a-fA-F]{40}|[A-Z2-7]{32})(?![A-Za-z0-9])/g;
  const PREFIX = 'magnet:?xt=urn:btih:';
  const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEXTAREA', 'TEMPLATE']);
  const HL = 'magnet-finder';
  let hits = [];
  let timer = 0;
  let restore = null;

  const keyOf = (url) => {
    const m = url.match(/xt=urn:btih:([a-z0-9]+)/i);
    return m ? m[1].toLowerCase() : url;
  };

  const nameOf = (url) => {
    try {
      return new URLSearchParams(url.slice(url.indexOf('?') + 1)).get('dn') || '';
    } catch {
      return '';
    }
  };

  function scan() {
    hits = [];
    if (!document.body) return [];

    for (const a of document.querySelectorAll('a[href^="magnet:" i]')) {
      const url = a.getAttribute('href').trim();
      hits.push({ el: a, url, label: a.textContent.trim() });
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

    return hits.map((h, i) => ({
      i,
      url: h.url,
      key: keyOf(h.url),
      name: nameOf(h.url),
      label: h.label,
      bare: !!h.bare,
    }));
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
    const target = h.el || h.node.parentElement;
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

  window.__magnetFinder = { scan, locate };
})();
