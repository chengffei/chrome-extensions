const $ = (s) => document.querySelector(s);
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
    flash(btn, '已复制');
  } catch {
    flash(btn, '复制失败');
  }
}

async function scan() {
  $('#count').textContent = '扫描中';
  message('');
  $('#list').replaceChildren();

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  tabId = tab.id;
  let results;
  try {
    const target = { tabId, allFrames: true };
    await chrome.scripting.executeScript({ target, files: ['content.js'] });
    results = await chrome.scripting.executeScript({
      target,
      func: () => window.__magnetFinder.scan(),
    });
  } catch {
    $('#count').textContent = '无法读取';
    message('这个页面不允许扩展读取，比如浏览器设置页和应用商店。');
    $('#copyAll').disabled = true;
    return;
  }

  // 按 btih 哈希去重，同一条的多处出现合并成一项
  const map = new Map();
  for (const r of results) {
    for (const h of r.result || []) {
      let g = map.get(h.key);
      if (!g) {
        g = { url: h.url, key: h.key, name: '', spots: [], cur: -1 };
        map.set(h.key, g);
      }
      g.name ||= h.name || h.label;
      if (h.url.length > g.url.length) g.url = h.url; // 保留带 tracker 的完整版本
      g.spots.push({ frameId: r.frameId, i: h.i });
    }
  }
  groups = [...map.values()];
  render();
}

function render() {
  $('#copyAll').disabled = groups.length === 0;
  $('#count').textContent = groups.length ? `${groups.length} 条` : '0 条';
  if (!groups.length) {
    message('当前页面没有找到磁力链接。');
    return;
  }

  const items = groups.map((g) => {
    const li = document.createElement('li');

    const name = document.createElement('div');
    name.className = 'name';
    name.textContent = g.name || '未命名';
    name.title = g.url;

    const meta = document.createElement('div');
    meta.className = 'meta';
    meta.textContent = g.key.length <= 40 ? g.key : g.url.slice(0, 80);

    const row = document.createElement('div');
    row.className = 'row';
    const note = document.createElement('span');
    note.className = 'note';
    if (g.spots.length > 1) note.textContent = `页面中出现 ${g.spots.length} 处`;

    const actions = document.createElement('div');
    actions.className = 'actions';
    const go = document.createElement('button');
    go.className = 'ghost';
    go.textContent = '定位';
    go.onclick = () => locate(g, go, note);
    const cp = document.createElement('button');
    cp.textContent = '复制';
    cp.onclick = () => copy(g.url, cp);
    actions.append(go, cp);

    row.append(note, actions);
    li.append(name, meta, row);
    return li;
  });
  $('#list').replaceChildren(...items);
}

// 多处出现时，连续点击依次跳到下一处
async function locate(g, btn, note) {
  g.cur = (g.cur + 1) % g.spots.length;
  const spot = g.spots[g.cur];
  const multi = g.spots.length > 1;
  try {
    const [r] = await chrome.scripting.executeScript({
      target: { tabId, frameIds: [spot.frameId] },
      func: (i) => window.__magnetFinder.locate(i),
      args: [spot.i],
    });
    if (r.result === 'ok') {
      btn.textContent = multi ? `定位 ${g.cur + 1}/${g.spots.length}` : '定位';
      note.textContent = multi ? `页面中出现 ${g.spots.length} 处` : '';
    } else if (r.result === 'hidden') {
      note.textContent = '在折叠或隐藏区域，展开后再试';
    } else {
      note.textContent = '页面已变化，请重新扫描';
    }
  } catch {
    note.textContent = '页面已变化，请重新扫描';
  }
}

$('#rescan').onclick = scan;
$('#copyAll').onclick = (e) => copy(groups.map((g) => g.url).join('\n'), e.currentTarget);
scan();
