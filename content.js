// 注入到页面（隔离环境）。重复注入时保留已有实例，scan 会刷新结果。
(() => {
  if (window.__magnetFinder) return;

  const RE = /magnet:\?[^\s"'<>（）【】「」《》，。；！？、]+/gi;
  const TRAIL = /[)\]}.,;:!?'"]+$/;
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
        if (!n.nodeValue.toLowerCase().includes('magnet:')) return NodeFilter.FILTER_REJECT;
        const p = n.parentElement;
        if (!p || SKIP.has(p.tagName)) return NodeFilter.FILTER_REJECT;
        if (p.closest('a[href^="magnet:" i]')) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    for (let n; (n = walker.nextNode()); ) {
      for (const m of n.nodeValue.matchAll(RE)) {
        const url = m[0].replace(TRAIL, '');
        hits.push({ node: n, start: m.index, end: m.index + url.length, url, label: '' });
      }
    }

    return hits.map((h, i) => ({
      i,
      url: h.url,
      key: keyOf(h.url),
      name: nameOf(h.url),
      label: h.label,
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
