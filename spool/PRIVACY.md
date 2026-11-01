# Privacy Policy

Last updated: 2026-11-01

Spool collects no personal data. There is no Spool server.

## What Spool accesses

- **Network responses while pages load.** To find videos, Spool looks at the URL, content type and size of responses in your tabs. It keeps only those that are video or audio, at most 40 per tab, in the browser's session storage. The list is cleared when the tab navigates or closes, and when the browser quits. Page content, form data and other requests are not read or kept.
- **Video manifests and files you choose to download.** Spool fetches them from the site that serves them, sending the original page as Referer and your cookies for that site, as the site's own player does. The file is written to the extension's private storage, saved to your Downloads folder, then deleted from private storage.
- **On bilibili video pages, when you open the popup:** Spool asks bilibili's API for the video's stream list from the page, so your browser attaches your bilibili session the same way the bilibili player does. Spool never reads, stores or sends those cookies anywhere else.

## What Spool does not do

- No analytics, telemetry, crash reports or advertising
- No requests to any server other than the one serving the video you chose
- No browsing history, no data shared between tabs or sites
- No remote code: everything runs from the files in the extension package

## Contact

Open an issue at <https://github.com/chengffei/chrome-extensions/issues>.

---

# 隐私政策

更新日期：2026-11-01

Spool 不收集任何个人数据，也没有 Spool 服务器。

## 访问了什么

- **页面加载时的网络响应。** 为了发现视频，Spool 查看标签页中响应的地址、内容类型和大小。只保留视频和音频，每个标签页最多 40 条，存在浏览器的会话存储里。标签页跳转、关闭或浏览器退出时清空。不读取也不保留网页内容、表单数据和其他请求。
- **你选择下载的视频清单和文件。** Spool 从提供视频的网站获取，带上原网页作为 Referer 和该网站的 Cookie，与网站自己的播放器一致。文件先写入插件私有存储，保存到下载文件夹后从私有存储删除。
- **在 B 站视频页打开弹窗时：** Spool 在页面内向 B 站接口请求清晰度列表，浏览器会像 B 站播放器一样带上你的登录信息。Spool 不读取、不保存、也不把 Cookie 发往别处。

## 不做什么

- 无统计、遥测、崩溃上报和广告
- 除提供你所选视频的服务器外，不请求任何服务器
- 不记录浏览历史，不在标签页或网站之间共享数据
- 无远程代码：所有代码都在插件包内

## 联系

在 <https://github.com/chengffei/chrome-extensions/issues> 提 issue。
