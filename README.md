# Magnet Finder

列出当前页面的磁力链接，一键复制，点一下跳到原位置。Chrome 与夸克等 Chromium 浏览器通用。

## 安装

1. 打开 `chrome://extensions`（夸克试 `quark://extensions`）
2. 打开「开发者模式」
3. 点「加载已解压的扩展程序」，选本目录

## 行为

- 识别 `<a href="magnet:">` 和正文里的纯文本磁链，跳过脚本与样式
- 按 btih 哈希去重，同一资源多处出现合并为一条，连点「定位」依次跳转
- 折叠的 `<details>` 自动展开；其他隐藏区域会提示
- 权限只有 activeTab 和 scripting，点开图标时才读取当前页

## 测试

打开 `test/test.html` 后点插件图标，应看到 5 条：Ubuntu（2 处）、Debian、CCCC、DDDD（折叠）、EEEE。
