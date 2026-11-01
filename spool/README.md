# Spool

Saves bilibili videos you can already watch, in the best quality your own account allows. Video and audio are merged into one MP4 inside your browser. No servers, no tracking. Works in Chrome, Edge and other Chromium browsers (version 116 or later).

[中文](#中文)

## Install

1. Open `chrome://extensions` (Edge: `edge://extensions`)
2. Turn on **Developer mode**
3. Click **Load unpacked** and pick this folder

## Use

1. Open a video page on `www.bilibili.com/video/…`
2. Click the Spool icon in the toolbar (it is greyed out on other pages)
3. Pick a quality and click **Download**, then choose where to save

The quality list comes straight from bilibili for your signed-in account:

| Account | Highest quality |
| --- | --- |
| Signed out | 480P |
| Signed in | 1080P |
| bilibili membership (大会员) | 1080P60, 4K, HDR, Dolby Vision, 8K, where the video has them |

## What it does and does not do

- Saves only the streams bilibili already serves to your account. It never fakes a membership, borrows anyone's session or unlocks paid content.
- One video at a time, only when you click. No batch or channel downloads.
- Ordinary video pages (`/video/`) only. Bangumi, courses and paid content are not supported.
- Merges without re-encoding, so quality is identical to the stream.
- Dolby Vision is saved as the two original files plus a ready-made ffmpeg command, because the in-browser muxer cannot keep the Dolby Vision metadata.
- Video codec: **Auto** picks HEVC on macOS and H.264 elsewhere (Windows cannot play HEVC without an extra codec). You can choose H.264, HEVC or AV1.

## Permissions

| Permission | Why |
| --- | --- |
| Content script on `www.bilibili.com/video/*` | Reads the stream list with your own session and shows the panel |
| `declarativeContent` | Enables the toolbar icon only on video pages |
| `activeTab`, `scripting` | Adds the panel to a tab opened before Spool was installed |
| `storage` | Remembers your codec choice on this device |

No access to other sites, history or cookies. See [PRIVACY.md](PRIVACY.md).

## How it works

1. Signs a `x/player/wbi/playurl` request (WBI) and asks for every quality bit (`fnval=4048`); bilibili caps the answer at what your account may play
2. Picks the chosen quality's video track in your preferred codec and the best audio track (Hi-Res, then Dolby Atmos, then 192K)
3. Reads both tracks with HTTP range requests, preferring bilibili's own CDN, and copies the packets into one MP4 with [Mediabunny](https://mediabunny.dev)
4. Writes straight to the file you picked, so memory stays flat even for multi-gigabyte files

## Tests

- `node --test test/core.test.js`: signing, stream selection, file names (offline)
- `SPOOL_LIVE=1 node --test test/live.test.js`: downloads a public video signed out in H.264, HEVC and AV1, checks each with ffprobe and a full decode (needs ffmpeg)
- `test/e2e.js`: loads the extension in Chrome for Testing with Puppeteer and downloads through the panel; usage in the file header

## Packaging for a store

`zip -r spool.zip . -x 'test/*' '*.DS_Store'`

## Third-party code

`vendor/mediabunny.min.js` is Mediabunny 1.65.0, unmodified, under MPL-2.0. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## Disclaimer

Spool is not affiliated with or endorsed by bilibili. It is for personal offline viewing of content you are entitled to watch. Respect creators' rights and bilibili's terms; do not re-upload or redistribute downloaded videos.

---

## 中文

Spool 卷轴：保存你在 B 站能观看的视频，清晰度以你自己账号的权限为上限。音视频在浏览器内合并成一个 MP4，不经服务器，不收集数据。适用于 Chrome、Edge 等 Chromium 浏览器（116 及以上）。

### 安装

1. 打开 `chrome://extensions`（Edge 用 `edge://extensions`）
2. 开启「开发者模式」
3. 点「加载已解压的扩展程序」，选本目录

### 使用

1. 打开 `www.bilibili.com/video/…` 视频页
2. 点工具栏的 Spool 图标（其他页面是灰的）
3. 选清晰度，点「下载」，选保存位置

清晰度列表由 B 站按你的登录账号返回：

| 账号 | 最高清晰度 |
| --- | --- |
| 未登录 | 480P |
| 已登录 | 1080P |
| 大会员 | 1080P60、4K、HDR、杜比视界、8K（视频本身有才有） |

### 做什么，不做什么

- 只保存 B 站本来就给你账号的流。不伪造会员、不借用他人登录、不解锁付费内容。
- 一次一个视频，只在你点击时运行。不做批量和整个 UP 主下载。
- 只支持普通视频页（`/video/`）。番剧、课程和付费内容不支持。
- 合并不重新编码，画质与原始流一致。
- 杜比视界保存为两个原始文件并给出 ffmpeg 合并命令，因为浏览器内的封装器无法保留杜比视界元数据。
- 视频编码：「自动」在 macOS 选 HEVC，其他系统选 H.264（Windows 默认播不了 HEVC）。也可手动选 H.264、HEVC 或 AV1。

### 权限

| 权限 | 用途 |
| --- | --- |
| `www.bilibili.com/video/*` 内容脚本 | 用你自己的登录态读取清晰度列表，显示面板 |
| `declarativeContent` | 只在视频页点亮工具栏图标 |
| `activeTab`、`scripting` | 给安装前已打开的标签页补上面板 |
| `storage` | 在本机记住编码选择 |

不访问其他网站、历史记录或 Cookie。详见 [PRIVACY.md](PRIVACY.md)。

### 测试

- `node --test test/core.test.js`：签名、选流、文件名（离线）
- `SPOOL_LIVE=1 node --test test/live.test.js`：未登录下载公开视频的 H.264、HEVC、AV1 三种编码，用 ffprobe 和完整解码校验（需要 ffmpeg）
- `test/e2e.js`：用 Puppeteer 在 Chrome for Testing 里加载插件，走面板下载；用法见文件开头

### 第三方代码

`vendor/mediabunny.min.js` 是未修改的 Mediabunny 1.65.0，MPL-2.0 许可。见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

### 声明

Spool 与哔哩哔哩官方无关，也未获其认可。仅供个人离线观看你有权观看的内容。请尊重创作者权益和 B 站用户协议，勿二次上传或传播下载的视频。
