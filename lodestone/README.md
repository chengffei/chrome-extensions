# Lodestone

Finds magnet links and info hashes on a web page, guesses each resource's name, copies them in one click and jumps to where they are. Works in Chrome and other Chromium browsers such as Quark.

[中文](#中文)

## Install

1. Open `chrome://extensions` (in Quark, `quark://extensions`)
2. Turn on **Developer mode**
3. Click **Load unpacked** and pick this folder

## What it does

- Detects `<a href="magnet:">` links, plain-text magnet links, and bare info hashes (40-char hex or 32-char Base32), adding the `magnet:?xt=urn:btih:` prefix
- Merges duplicates by btih hash; click a card to scroll to it, click again to jump to the next occurrence
- Name priority: `dn` parameter > link text > nearby text (marked as a guess)
- Opens collapsed `<details>` automatically; tells you when a link sits in another hidden area
- Permissions are only `activeTab` and `scripting`; it reads the page only when you click the icon

## How names are guessed

1. Walk up from the link to the largest element that holds only this one link, and treat it as the record (a table row, a post, a list item)
2. Split the record into lines and look up to 4 lines above and below, never crossing a line that holds another link
3. Score: heading tag or `title`/`name` class +4, a "Name:" label +6, filename-like text (extension, 1080p, S01E02) +4, −1 per line of distance, −0.5 more if below the link
4. Skip generic words ("download", "magnet"), sizes and dates

## Tests

- `test/test.html`: detection and locating, should list 7 items
- `test/names.html`: name guessing; `test/run.sh` checks it against `test/expect.txt`

---

## 中文

Lodestone 磁石：找出网页里的磁力链接和哈希，推测资源名，一键复制，点一下跳到原位置。Chrome 与夸克等 Chromium 浏览器通用。

### 安装

1. 打开 `chrome://extensions`（夸克用 `quark://extensions`）
2. 打开「开发者模式」
3. 点「加载已解压的扩展程序」，选本目录

### 行为

- 识别 `<a href="magnet:">`、正文里的纯文本磁链、裸哈希（40 位十六进制或 32 位 Base32，自动补全前缀）
- 按 btih 哈希去重，多处出现合并为一条；点卡片定位，连点依次跳转
- 资源名优先级：`dn` 参数 > 链接文字 > 就近推测（标「就近推测」）
- 折叠的 `<details>` 自动展开；其他隐藏区域会提示
- 权限只有 activeTab 和 scripting，点开图标时才读取当前页

### 资源名推测

1. 从磁链向上找只含这一条磁链的最大容器，当作它的记录块（表格行、帖子、列表项）
2. 把记录块切成行，在磁链上下各 4 行内找候选，不跨越其他磁链所在的行
3. 打分：标题标签或 title/name 类名 +4，「名称：」标签 +6，像文件名（扩展名、1080p、S01E02）+4，距离每远一行 -1，在磁链下方再 -0.5
4. 排除通用词（下载、磁力）、大小、日期

### 测试

- `test/test.html`：识别与定位，应看到 7 条
- `test/names.html`：资源名推测，`test/run.sh` 自动对照 `test/expect.txt`
