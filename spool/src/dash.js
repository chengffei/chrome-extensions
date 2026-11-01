// Spool DASH: parses an MPD into representations with their segment URLs.
// Covers SegmentTemplate (with or without SegmentTimeline), SegmentList and
// single-file representations. Uses its own small XML reader so it also
// runs in service workers and Node. Exports to globalThis.SpoolDash.
(function (g) {
  'use strict';

  // ---------- Minimal XML reader (elements, attributes; enough for MPD) ----------

  function decode(s) {
    return s.replace(/&(lt|gt|amp|quot|apos|#\d+|#x[0-9a-f]+);/gi, (m, e) => {
      const map = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };
      if (map[e.toLowerCase()]) return map[e.toLowerCase()];
      return String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
    });
  }

  function parseXml(text) {
    const root = { name: '#root', attrs: {}, children: [], text: '' };
    const stack = [root];
    const re = /<!--[\s\S]*?-->|<!\[CDATA\[([\s\S]*?)\]\]>|<\?[\s\S]*?\?>|<!DOCTYPE[^>]*>|<\/([^\s>]+)\s*>|<([^\s/>]+)((?:\s+[^\s=/>]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|([^<]+)/g;
    let m;
    while ((m = re.exec(text))) {
      const top = stack[stack.length - 1];
      if (m[1] !== undefined) top.text += m[1];
      else if (m[2]) { if (stack.length > 1) stack.pop(); }
      else if (m[3]) {
        const node = { name: m[3].replace(/^[^:]+:/, ''), attrs: {}, children: [], text: '' };
        const ar = /([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
        let a;
        while ((a = ar.exec(m[4] || ''))) node.attrs[a[1]] = decode(a[2] !== undefined ? a[2] : a[3]);
        top.children.push(node);
        if (!m[5]) stack.push(node);
      } else if (m[6]) top.text += decode(m[6]);
    }
    return root;
  }

  const kids = (n, name) => (n ? n.children.filter((c) => c.name === name) : []);
  const kid = (n, name) => kids(n, name)[0] || null;

  // ---------- Helpers ----------

  // ISO 8601 duration ("PT1H2M3.5S") to seconds.
  function isoDuration(s) {
    const m = /^P(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(String(s || '').trim());
    if (!m) return 0;
    return (Number(m[1] || 0) * 86400) + (Number(m[2] || 0) * 3600) + (Number(m[3] || 0) * 60) + Number(m[4] || 0);
  }

  function resolve(base, rel) {
    try { return new URL(rel, base).href; } catch (_) { return rel; }
  }

  function baseOf(node, base) {
    const b = kid(node, 'BaseURL');
    return b ? resolve(base, b.text.trim()) : base;
  }

  function fill(template, vars) {
    return template.replace(/\$(RepresentationID|Number|Time|Bandwidth)(?:%0(\d+)d)?\$|\$\$/g, (m, name, width) => {
      if (m === '$$') return '$';
      const v = String(vars[name]);
      return width ? v.padStart(Number(width), '0') : v;
    });
  }

  // Merges SegmentTemplate/SegmentList attributes inherited from parents.
  function merged(nodes, name) {
    const found = nodes.map((n) => kid(n, name)).filter(Boolean);
    if (!found.length) return null;
    const out = { attrs: {}, children: [] };
    for (const f of found) {
      Object.assign(out.attrs, f.attrs);
      if (f.children.length) out.children = f.children;
    }
    return out;
  }

  function hasProtection(...nodes) {
    return nodes.some((n) => n && kids(n, 'ContentProtection').length > 0);
  }

  // ---------- Segments ----------

  function segmentsFromTemplate(tpl, rep, base, periodSeconds) {
    const a = tpl.attrs;
    const timescale = Number(a.timescale || 1);
    const startNumber = Number(a.startNumber != null ? a.startNumber : 1);
    const vars = { RepresentationID: rep.attrs.id, Bandwidth: rep.attrs.bandwidth };
    const list = [];
    if (a.initialization) list.push({ url: resolve(base, fill(a.initialization, { ...vars, Number: startNumber, Time: 0 })) });
    const timeline = kid(tpl, 'SegmentTimeline');
    if (timeline) {
      let t = 0;
      let n = startNumber;
      for (const s of kids(timeline, 'S')) {
        if (s.attrs.t != null) t = Number(s.attrs.t);
        const d = Number(s.attrs.d);
        let r = Number(s.attrs.r || 0);
        if (r < 0) r = Math.max(0, Math.ceil((periodSeconds * timescale - t) / d) - 1);
        for (let i = 0; i <= r; i++) {
          list.push({ url: resolve(base, fill(a.media, { ...vars, Number: n, Time: t })) });
          t += d;
          n++;
        }
      }
    } else if (a.duration) {
      const segSeconds = Number(a.duration) / timescale;
      const count = Math.ceil(periodSeconds / segSeconds - 1e-9);
      for (let i = 0; i < count; i++) {
        list.push({ url: resolve(base, fill(a.media, { ...vars, Number: startNumber + i, Time: Math.round(i * Number(a.duration)) })) });
      }
    }
    return list;
  }

  function segmentsFromList(sl, base) {
    const list = [];
    const init = kid(sl, 'Initialization');
    if (init) list.push({ url: resolve(base, init.attrs.sourceURL || ''), range: init.attrs.range });
    for (const s of kids(sl, 'SegmentURL')) list.push({ url: resolve(base, s.attrs.media || ''), range: s.attrs.mediaRange });
    return list;
  }

  // ---------- MPD ----------

  /**
   * @returns {{live:boolean, duration:number, drm:boolean, video:object[], audio:object[]}}
   * Each representation: {id, kind, bandwidth, width, height, codecs, mimeType, single?:url, segments?:[{url, range?}]}
   */
  function parseMpd(text, mpdUrl) {
    const doc = parseXml(text);
    const mpd = kid(doc, 'MPD');
    if (!mpd) throw new Error('not an MPD');
    const live = mpd.attrs.type === 'dynamic';
    const period = kids(mpd, 'Period')[0];
    if (!period) throw new Error('MPD has no Period');
    const duration = isoDuration(period.attrs.duration) || isoDuration(mpd.attrs.mediaPresentationDuration);
    const mpdBase = baseOf(mpd, mpdUrl);
    const periodBase = baseOf(period, mpdBase);
    const out = { live, duration, drm: false, video: [], audio: [] };

    for (const as of kids(period, 'AdaptationSet')) {
      const asBase = baseOf(as, periodBase);
      for (const rep of kids(as, 'Representation')) {
        const mime = rep.attrs.mimeType || as.attrs.mimeType || '';
        const ctype = as.attrs.contentType || mime.split('/')[0];
        const kind = ctype === 'video' ? 'video' : ctype === 'audio' ? 'audio' : null;
        if (!kind) continue;
        const protectedRep = hasProtection(as, rep);
        if (protectedRep) out.drm = true;
        const repBase = baseOf(rep, asBase);
        const r = {
          id: rep.attrs.id,
          kind,
          bandwidth: Number(rep.attrs.bandwidth || 0),
          width: Number(rep.attrs.width || as.attrs.width || 0),
          height: Number(rep.attrs.height || as.attrs.height || 0),
          codecs: rep.attrs.codecs || as.attrs.codecs || '',
          mimeType: mime,
          drm: protectedRep,
        };
        const tpl = merged([period, as, rep], 'SegmentTemplate');
        const sl = merged([period, as, rep], 'SegmentList');
        if (tpl && tpl.attrs.media) r.segments = segmentsFromTemplate(tpl, rep, repBase, duration);
        else if (sl) r.segments = segmentsFromList(sl, repBase);
        else r.single = repBase;
        out[kind].push(r);
      }
    }
    const byQuality = (a, b) => (b.height - a.height) || (b.bandwidth - a.bandwidth);
    out.video.sort(byQuality);
    out.audio.sort((a, b) => b.bandwidth - a.bandwidth);
    return out;
  }

  g.SpoolDash = { parseMpd, parseXml, isoDuration };
})(globalThis);
