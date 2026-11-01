const $ = (s) => document.querySelector(s);
const t = (key, ...subs) => chrome.i18n.getMessage(key, subs.map(String)) || key;

document.documentElement.lang = chrome.i18n.getUILanguage();
document.querySelectorAll('[data-i18n]').forEach((el) => (el.textContent = t(el.dataset.i18n)));
const RANK = { dn: 3, link: 2, near: 1, '': 0 };
let tabId = 0;
let groups = [];

function message(text) {
  $('#msg').textContent = text;
  $('#msg').hidden = !text;
}

function flash(btn, text) {
  const old = btn.textContent;
  btn.textContent = text;
  setTimeout(() => (btn.textContent = old), 1200);
}

async function copy(text, btn) {
  try {
    await navigator.clipboard.writeText(text);
    flash(btn, t('copied'));
  } catch {
    flash(btn, t('copyFailed'));
  }
}

// 夸克的弹窗里 currentWindow 可能查不到标签页，逐级放宽条件
async function activeTabId() {
  const queries = [
    { active: true, currentWindow: true },
    { active: true, lastFocusedWindow: true },
    { active: true },
  ];
  for (const q of queries) {
    const tabs = await chrome.tabs.query(q);
    const tab = tabs.find((t) => t.id !== undefined && !t.url?.startsWith('chrome-extension://'));
    if (tab) return tab.id;
  }
  throw new Error(t('noTab'));
}

async function scan() {
  $('#count').textContent = t('scanning');
  message('');
  $('#list').replaceChildren();

  let results;
  try {
    tabId = await activeTabId();
    const target = { tabId, allFrames: true };
    await chrome.scripting.executeScript({ target, files: ['content.js'] });
    results = await chrome.scripting.executeScript({
      target,
      func: () => window.__lodestone.scan(),
    });
  } catch (e) {
    $('#count').textContent = t('cannotRead');
    message(`${t('cannotReadMsg')}\n${e?.message || e}`);
    $('#copyAll').disabled = true;
    return;
  }

  // 按 btih 哈希去重，同一条的多处出现合并成一项
  const map = new Map();
  for (const r of results) {
    for (const h of r.result || []) {
      let g = map.get(h.key);
      if (!g) {
        g = { url: h.url, key: h.key, name: '', source: '', spots: [], cur: -1, bare: true };
        map.set(h.key, g);
      }
      g.bare &&= h.bare; // 只要有一处是完整磁链，就不算「仅哈希」
      if (h.name && RANK[h.source] > RANK[g.source]) {
        g.name = h.name;
        g.source = h.source;
      }
      if (h.url.length > g.url.length) g.url = h.url; // 保留带 tracker 的完整版本
      g.spots.push({ frameId: r.frameId, i: h.i });
    }
  }
  groups = [...map.values()];
  render();
}

function tag(text, cls = '') {
  const t = document.createElement('span');
  t.className = `tag ${cls}`;
  t.textContent = text;
  return t;
}

function render() {
  $('#copyAll').disabled = groups.length === 0;
  $('#count').textContent = groups.length ? t('countHint', groups.length) : t('countZero');
  if (!groups.length) {
    message(t('none'));
    return;
  }

  const items = groups.map((g) => {
    const li = document.createElement('li');
    li.className = 'card';
    li.title = g.url;

    const body = document.createElement('div');
    body.className = 'body';

    const name = document.createElement('div');
    name.className = g.name ? 'name' : 'name empty';
    name.textContent = g.name || t('noName');

    const hash = document.createElement('div');
    hash.className = 'hash';
    hash.textContent = g.key.length <= 40 ? g.key : g.url;

    const tags = document.createElement('div');
    tags.className = 'tags';
    const status = tag('', 'status');
    status.hidden = true;
    if (g.source === 'near') tags.append(tag(t('tagGuess')));
    if (g.bare) tags.append(tag(t('tagBare')));
    if (g.spots.length > 1) tags.append(tag(t('tagSpots', g.spots.length)));
    tags.append(status);

    body.append(name, hash, tags);

    const cp = document.createElement('button');
    cp.className = 'copy';
    cp.textContent = t('copy');
    cp.onclick = (e) => {
      e.stopPropagation();
      copy(g.url, cp);
    };

    li.onclick = () => locate(g, li, status);
    li.append(body, cp);
    return li;
  });
  $('#list').replaceChildren(...items);
}

// 多处出现时，连续点击依次跳到下一处
async function locate(g, li, status) {
  g.cur = (g.cur + 1) % g.spots.length;
  const spot = g.spots[g.cur];
  const multi = g.spots.length > 1;
  const show = (text, cls) => {
    status.textContent = text;
    status.className = `tag ${cls}`;
    status.hidden = false;
  };
  document.querySelectorAll('.card.on').forEach((c) => c.classList.remove('on'));
  try {
    const [r] = await chrome.scripting.executeScript({
      target: { tabId, frameIds: [spot.frameId] },
      func: (i) => window.__lodestone.locate(i),
      args: [spot.i],
    });
    if (r.result === 'ok') {
      li.classList.add('on');
      show(multi ? t('locatedN', g.cur + 1, g.spots.length) : t('located'), 'status');
    } else if (r.result === 'hidden') {
      show(t('hidden'), 'warn');
    } else {
      show(t('changed'), 'warn');
    }
  } catch {
    show(t('changed'), 'warn');
  }
}

$('#rescan').onclick = scan;
$('#copyAll').onclick = (e) => copy(groups.map((g) => g.url).join('\n'), e.currentTarget);
scan();
