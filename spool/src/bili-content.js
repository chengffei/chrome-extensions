// Spool on bilibili video pages: answers the popup with the qualities this
// account may play. Runs in the page so requests carry the user's own
// session, exactly like the bilibili player.
(function () {
  'use strict';
  if (globalThis.__spoolBili) return;
  globalThis.__spoolBili = true;
  const C = globalThis.SpoolCore;

  const client = C.createClient(async (url) => {
    const res = await fetch(url, { credentials: 'include' });
    if (!res.ok) { const e = new Error('HTTP ' + res.status); e.status = res.status; throw e; }
    return res.json();
  });

  // HEVC plays natively on macOS; Windows needs an extra codec for it.
  function codecOrder() {
    const mac = /Mac/i.test(navigator.platform || '') || /Mac OS X/.test(navigator.userAgent);
    return mac ? ['hevc', 'avc', 'av1'] : ['avc', 'hevc', 'av1'];
  }

  async function options() {
    const page = C.parseVideoPage(location.href);
    if (!page) return { error: { kind: 'notVideoPage' } };
    const account = await client.account();
    const info = await client.view(page);
    const play = await client.playurl(info);
    // Dolby Vision cannot be kept by the in-browser muxer; HDR10 is
    // offered instead whenever bilibili has it.
    const list = C.listOptions(play.dash, codecOrder()).filter((o) => o.merge);
    return {
      account,
      title: info.title,
      options: list.map((o) => ({
        qn: o.qn, label: o.label, height: o.video.height, codec: o.video.codec,
        bitrate: (o.video.bandwidth || 0) + ((o.audio && o.audio.bandwidth) || 0),
        videoUrls: o.video.urls, audioUrls: o.audio ? o.audio.urls : [],
        duration: info.duration, fileBase: C.fileBase(info, o),
      })),
      defaultQn: (C.defaultOption(list) || {}).qn,
      duration: info.duration,
    };
  }

  chrome.runtime.onMessage.addListener((msg, sender, reply) => {
    if (!msg || msg.type !== 'bili:options') return false;
    options().then(reply, (e) => reply({ error: { kind: e.kind || 'apiError', message: String(e.message) } }));
    return true;
  });
})();
