// Panel styles, injected inside the panel's shadow root so they neither
// leak into nor inherit from the bilibili page.
globalThis.SpoolPanelCss = `
:host { all: initial; }
.panel {
  --bg: #fff; --fg: #1d1d1f; --fg2: #424245; --fg3: #6e6e73; --line: #e5e5ea;
  --soft: #f5f5f7; --accent: #0071e3; --ok: #1b6b3a; --err: #c4342d;
  position: fixed; top: 72px; right: 24px; z-index: 2147483647;
  width: 360px; max-height: calc(100vh - 96px); overflow: auto; box-sizing: border-box;
  padding: 16px 18px 12px; border-radius: 18px; background: var(--bg); color: var(--fg);
  box-shadow: 0 12px 40px rgba(0,0,0,.18);
  font: 14px/1.45 -apple-system, BlinkMacSystemFont, "Inter", "PingFang SC", "Noto Sans SC", "Microsoft YaHei", sans-serif;
}
@media (prefers-color-scheme: dark) {
  .panel { --bg: #1c1c1e; --fg: #f5f5f7; --fg2: #d1d1d6; --fg3: #a1a1a6; --line: #38383a; --soft: #2c2c2e; --accent: #2997ff; --ok: #4cd964; --err: #ff6961; }
}
header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px; }
header strong { font-size: 15px; font-weight: 600; }
button { font: inherit; color: var(--fg); background: var(--soft); border: 0; border-radius: 10px; padding: 7px 14px; cursor: pointer; }
button:hover { filter: brightness(.96); }
button:disabled { opacity: .5; cursor: default; }
button.primary { background: var(--accent); color: #fff; font-weight: 600; }
button.icon { background: none; font-size: 20px; line-height: 1; padding: 2px 6px; color: var(--fg3); }
.title { font-weight: 600; margin: 4px 0 2px; overflow: hidden; text-overflow: ellipsis; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
.account { color: var(--fg3); font-size: 13px; margin: 0 0 10px; }
.rows { display: flex; flex-direction: column; gap: 4px; }
.row { display: grid; grid-template-columns: 18px 1fr; column-gap: 8px; padding: 8px 10px; border-radius: 12px; cursor: pointer; }
.row.on { background: var(--soft); }
.row input { grid-row: span 3; margin: 3px 0 0; accent-color: var(--accent); }
.q { font-weight: 600; }
.meta { color: var(--fg2); font-size: 12px; font-family: "Geist Mono", ui-monospace, SFMono-Regular, Menlo, monospace; }
.note { color: var(--fg3); font-size: 12px; }
.field { display: flex; align-items: center; justify-content: space-between; margin: 12px 0 0; color: var(--fg2); }
select { font: inherit; color: var(--fg); background: var(--soft); border: 0; border-radius: 8px; padding: 5px 8px; }
.actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 14px; }
.msg { margin: 8px 0; }
.msg.error { color: var(--err); }
.msg.ok { color: var(--ok); }
.detail { color: var(--fg3); font-size: 12px; margin: 4px 0; word-break: break-all; }
.bar { height: 6px; border-radius: 3px; background: var(--soft); overflow: hidden; }
.bar > div { height: 100%; background: var(--accent); transition: width .2s; }
pre { white-space: pre-wrap; word-break: break-all; background: var(--soft); border-radius: 10px; padding: 8px 10px; font-size: 12px; margin: 6px 0 0; }
footer { color: var(--fg3); font-size: 11px; margin-top: 14px; border-top: 1px solid var(--line); padding-top: 8px; }
`;
