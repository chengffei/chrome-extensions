# Spool

Finds the videos on a web page and saves them as files. Handles direct files (MP4, WebM and others), HLS and DASH streams, and bilibili in the best quality your own account allows. Streams are merged into one MP4 in your browser, without re-encoding. No servers, no tracking. Chrome, Edge and other Chromium browsers, version 116 or later.

[中文](#中文)

## Install

1. Open `chrome://extensions` (Edge: `edge://extensions`)
2. Turn on **Developer mode**
3. Click **Load unpacked** and pick this folder

## Use

1. Open a page and play the video. The toolbar icon shows how many videos Spool has found
2. Click the icon, pick a quality if there is a choice, click **Download**
3. The file goes to your Downloads folder, named after the page

## What it supports

| Source | How |
| --- | --- |
| Direct files | MP4, WebM, MOV, MKV, FLV, MP3, M4A and similar, saved as they are |
| HLS (`.m3u8`) | All variants listed; TS or fMP4 segments, separate audio, AES-128 |
| DASH (`.mpd`) | SegmentTemplate (number or timeline), SegmentList, single-file representations |
| bilibili | Qualities your signed-in account may play, up to 8K with a membership |

Not supported, on purpose:

- **DRM-protected video** (Widevine, PlayReady, FairPlay). Spool recognises it and shows it as protected. It never touches encryption keys or the browser's DRM system.
- **YouTube.** The Chrome Web Store does not allow YouTube downloaders.
- **Live streams.** They are recognised and marked; recording may come later.
- Paywalls and logins. Spool only sees what the page already loaded for you.

## Permissions

| Permission | Why |
| --- | --- |
| `webRequest` on all sites | Notice video responses (by content type or file extension) while pages load. Only the URL, type and size are kept, per tab, in memory |
| `declarativeNetRequestWithHostAccess` | Send the original page as Referer on Spool's own download requests, as many video servers require |
| `offscreen` | Download and merge streams outside the popup, so closing it does not stop a download |
| `downloads` | Save the finished file to your Downloads folder |
| `storage` | Keep the per-tab list and download progress for this browser session |
| `scripting` | Read bilibili's quality list on a video page opened before Spool was installed |

See [PRIVACY.md](PRIVACY.md).

## How it works

1. The service worker classifies responses as they arrive and keeps up to 40 per tab. Stream segments, tiny files, failed requests and YouTube are ignored
2. When you open the popup, HLS and DASH manifests are read to list qualities, duration and DRM status. Media playlists already covered by a master playlist are hidden
3. A download runs in an offscreen document. HLS is read with [Mediabunny](https://mediabunny.dev); DASH segments are fetched in order to temporary files; both are then copied packet by packet into one MP4
4. The result is written to the extension's private storage, handed to Chrome's download manager, then deleted
5. One download runs at a time; others wait in a queue

For bilibili, the page asks bilibili's own API with your session for the stream list (WBI signed, `fnval=4048`), so the quality is capped by your account, never unlocked. Dolby Vision is left out because the merger cannot keep its metadata; HDR10 is offered when available.

## Tests

| Command | What it covers |
| --- | --- |
| `node --test test/` | bilibili signing and selection; detection rules; DASH parsing; downloads of locally built HLS (TS, fMP4, separate audio, AES-128), DASH (timeline, number), a direct file and DRM refusal, all checked with ffprobe and a full decode. Needs ffmpeg |
| `SPOOL_LIVE=1 node --test test/live.test.js` | A public bilibili video signed out, in H.264, HEVC and AV1 |
| `test/e2e.js` | The real extension in Chrome for Testing: a local page with every kind of resource, downloads from the popup, optional `--bili BV…`. Usage in the file header |

## Packaging for a store

`zip -r spool.zip . -x 'test/*' '*.DS_Store'`

## Third-party code

`vendor/mediabunny.min.js` is Mediabunny 1.65.0, unmodified, under MPL-2.0. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## Disclaimer

Spool is not affiliated with or endorsed by any website it works on. Use it only for videos you have the right to save, such as your own uploads, freely licensed media or content a site allows you to keep. Respect creators' rights and each site's terms.

---

## 中文

Spool 卷轴：发现网页里的视频并保存为文件。支持直链文件（MP4、WebM 等）、HLS 和 DASH 流；B 站按你自己账号的最高权限下载。流在浏览器内合并为一个 MP4，不重新编码。不经服务器，不收集数据。适用于 Chrome、Edge 等 Chromium 浏览器 116 及以上。

### 安装

1. 打开 `chrome://extensions`（Edge 用 `edge://extensions`）
2. 开启「开发者模式」
3. 点「加载已解压的扩展程序」，选本目录

### 使用

1. 打开网页并播放视频，工具栏图标上的数字是发现的视频数
2. 点图标，有多个清晰度时先选，再点「下载」
3. 文件保存到下载文件夹，以网页标题命名

### 支持范围

| 来源 | 说明 |
| --- | --- |
| 直链文件 | MP4、WebM、MOV、MKV、FLV、MP3、M4A 等，原样保存 |
| HLS（`.m3u8`） | 列出全部清晰度；TS 或 fMP4 分片、独立音轨、AES-128 |
| DASH（`.mpd`） | SegmentTemplate（编号或时间线）、SegmentList、单文件 |
| B 站 | 登录账号能播放的档位，大会员最高 8K |

刻意不支持：

- **DRM 保护的视频**（Widevine、PlayReady、FairPlay）。Spool 会识别并标为受保护，不接触密钥和浏览器的 DRM 模块。
- **YouTube**。Chrome 应用商店不允许 YouTube 下载器。
- **直播流**。会识别并标出，录制以后再做。
- 付费墙和登录限制。Spool 只看得到页面已经为你加载的内容。

### 权限

| 权限 | 用途 |
| --- | --- |
| 全部网站的 `webRequest` | 页面加载时按类型或扩展名识别视频响应。只按标签页在内存里保留地址、类型、大小 |
| `declarativeNetRequestWithHostAccess` | 给 Spool 自己的下载请求带上原网页作为 Referer，很多视频服务器要求这一点 |
| `offscreen` | 在弹窗之外下载和合并，关掉弹窗不中断 |
| `downloads` | 把完成的文件存到下载文件夹 |
| `storage` | 在本次浏览器会话中保留各标签页的列表和下载进度 |
| `scripting` | 给安装前已打开的 B 站视频页补上读取清晰度的脚本 |

详见 [PRIVACY.md](PRIVACY.md)。

### 工作方式

1. 后台在响应到达时分类，每个标签页最多保留 40 条；分片、小文件、失败请求和 YouTube 忽略
2. 打开弹窗时读取 HLS、DASH 清单，列出清晰度、时长、是否 DRM；已被主列表覆盖的子列表隐藏
3. 下载在离屏文档中进行：HLS 由 Mediabunny 读取，DASH 分片按顺序下载到临时文件，再逐包复制进一个 MP4
4. 成品先写入插件私有存储，交给浏览器下载管理器保存后删除
5. 同一时间只下载一个，其余排队

B 站由页面用你的登录态调用 B 站接口取流（WBI 签名，`fnval=4048`），清晰度以账号权限为上限，从不解锁。杜比视界因合并后无法保留元数据而不提供，有 HDR10 时提供 HDR10。

### 测试

- `node --test test/`：B 站签名与选流、识别规则、DASH 解析，以及本地生成的 HLS（TS、fMP4、独立音轨、AES-128）、DASH（时间线、编号）、直链和 DRM 拒绝，全部用 ffprobe 和完整解码校验。需要 ffmpeg
- `SPOOL_LIVE=1 node --test test/live.test.js`：未登录下载公开 B 站视频的 H.264、HEVC、AV1
- `test/e2e.js`：在 Chrome for Testing 中加载真实插件，测试页包含各类资源，从弹窗下载，可加 `--bili BV…`；用法见文件开头

### 第三方代码

`vendor/mediabunny.min.js` 是未修改的 Mediabunny 1.65.0，MPL-2.0 许可。见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

### 声明

Spool 与它所作用的任何网站均无关联，也未获其认可。仅用于你有权保存的视频，例如自己上传的内容、自由许可的媒体或网站允许保存的内容。请尊重创作者权益和各网站条款。
