/**
 * APICost browser half.
 *
 * A ledger: the sidebar seat shows the model in use and the account balance,
 * and the detail window reads like a statement page — balance on top, the
 * account's all-time figures ruled beneath it, then a daily trend strip.
 *
 * Every number comes from the host snapshot, which reads DeepSeek directly; the
 * bundle keeps no accounting of its own. Hand-written lazy-CJS rather than
 * bundler output, so the only module it resolves is the platform baseline's
 * `react`.
 */
window.__ModuleLoader__.load({
	id: "dsh-plugin-apicost",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		const React = require("react");
		const h = React.createElement;

		/* ------------------------------------------------------------------ *
		 * Styles — a printed ledger: paper, ink, one vermilion accent.
		 * ------------------------------------------------------------------ */

		const css = [
		".apx{--bg:#f5f5f7;--surface:#ffffff;--surface-2:#f5f5f7;--ink:#1d1d1f;--ink-2:#6e6e73;--ink-3:#8e8e93;--rule:rgba(0,0,0,.08);--rule-2:rgba(0,0,0,.10);--accent:#0a84ff;--accent-strong:#007aff;--accent-soft:rgba(10,132,255,.10);--green:#34c759;--green-soft:rgba(52,199,89,.12);--red:#ff3b30;--red-soft:rgba(255,59,48,.10);--glass:rgba(255,255,255,.62);--scrim:rgba(0,0,0,.30);--shadow:0 24px 64px -22px rgba(0,0,0,.34),0 2px 10px rgba(0,0,0,.06);--r-lg:18px;--r-md:12px;--r-sm:9px;--r-pill:999px;--font:-apple-system,BlinkMacSystemFont,\"SF Pro Text\",\"Segoe UI\",\"PingFang SC\",\"Microsoft YaHei\",sans-serif;--mono:ui-monospace,\"SF Mono\",Menlo,Consolas,monospace;--ease-out:cubic-bezier(.23,1,.32,1);--ease-in-out:cubic-bezier(.77,0,.175,1);--ease-drawer:cubic-bezier(.32,.72,0,1);--dur-fast:160ms;--dur:220ms;--dur-slow:300ms;--apx-close-w:38px;color-scheme:light}",
		"body[data-ds-dark-theme] .apx{--bg:#000000;--surface:#1c1c1e;--surface-2:#2c2c2e;--ink:#f5f5f7;--ink-2:#aeaeb2;--ink-3:#8e8e93;--rule:rgba(255,255,255,.10);--rule-2:rgba(255,255,255,.14);--accent:#0a84ff;--accent-strong:#5ac8fa;--accent-soft:rgba(10,132,255,.18);--green:#30d158;--green-soft:rgba(48,209,88,.18);--red:#ff453a;--red-soft:rgba(255,69,58,.18);--glass:rgba(28,28,30,.62);--scrim:rgba(0,0,0,.55);--shadow:0 28px 72px -22px rgba(0,0,0,.72),0 2px 12px rgba(0,0,0,.5);color-scheme:dark}",

		/* ---- the sidebar seat ---- */
		".apx-foot{width:100%}",
		".apx-foot--rail{width:auto;display:flex;justify-content:center}",
		".apx-row{display:flex;align-items:center;gap:10px;width:100%;padding:7px 8px;border:0;border-radius:8px;background:transparent;color:inherit;font-family:var(--font);text-align:left;cursor:pointer;transition:background var(--dur-fast) ease}",
		".apx-row:hover{background:var(--surface-2)}",
		"body[data-ds-dark-theme] .apx-row:hover{background:rgba(255,255,255,.04)}",
		".apx-row:focus-visible{outline:2px solid var(--accent);outline-offset:-2px}",
		".apx-seat{min-width:0;flex:1;display:flex;flex-direction:column;gap:3px}",
		".apx-seat-top{display:flex;align-items:baseline;gap:8px;min-width:0}",
		".apx-seat-label{font-size:10px;font-weight:600;letter-spacing:.14em;text-transform:uppercase;color:var(--ink-3)}",
		".apx-seat-money{margin-left:auto;font-family:var(--mono);font-size:12.5px;font-weight:600;font-variant-numeric:tabular-nums;color:var(--accent);white-space:nowrap}",
		".apx-seat-money small{margin-left:2px;font-size:8.5px;letter-spacing:.08em;opacity:.75}",
		".apx-seat-bottom{display:flex;align-items:center;gap:8px;min-width:0;font-family:var(--mono);font-size:10px;color:var(--ink-3);white-space:nowrap}",
		".apx-seat-model{overflow:hidden;text-overflow:ellipsis;color:var(--ink-2)}",
		".apx-seat-session{margin-left:auto;font-variant-numeric:tabular-nums;color:var(--ink-3)}",
		".apx-dot{flex:none;width:6px;height:6px;border-radius:50%;background:var(--rule-2);margin-left:auto}",
		".apx-dot--live{background:var(--accent);animation:apx-breathe 1.6s ease-in-out infinite}",
		".apx-dot--ok{background:var(--green)}",
		".apx-dot--err{background:var(--red)}",
		"@keyframes apx-breathe{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.35;transform:scale(.7)}}",
		".apx-railwrap{position:relative;display:inline-flex}",
		".apx-rail{display:flex;flex-direction:column;align-items:center;gap:4px;padding:7px 9px;border:0;border-radius:8px;background:transparent;color:inherit;cursor:pointer}",
		".apx-rail:hover{background:var(--surface-2)}",
		".apx-rail-model{font-family:var(--mono);font-size:9px;color:var(--ink-2);max-width:44px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
		".apx-rail-money{font-family:var(--mono);font-size:9px;font-weight:600;color:var(--accent);font-variant-numeric:tabular-nums}",
		".apx-railwrap .apx-dot{position:absolute;top:3px;right:3px}",

		/* ---- the detail window · v9 Apple 紧凑 ---- */
		".apx-ovl{position:fixed;inset:0;z-index:60;display:flex;align-items:center;justify-content:center;padding:20px;pointer-events:auto}",
		".apx-scrim{position:absolute;inset:0;background:var(--scrim);backdrop-filter:blur(10px) saturate(180%);-webkit-backdrop-filter:blur(10px) saturate(180%)}",
		".apx-book{position:relative;display:flex;flex-direction:column;width:min(720px,100%);max-height:86vh;overflow:hidden;font-family:var(--font);color:var(--ink);background:var(--glass);backdrop-filter:blur(30px) saturate(180%);-webkit-backdrop-filter:blur(30px) saturate(180%);border:1px solid var(--rule);border-radius:var(--r-lg);box-shadow:var(--shadow);animation:apx-open var(--dur-slow) var(--ease-drawer) both}",
		".apx-book:focus{outline:none}",
		"@keyframes apx-open{from{opacity:0;transform:translateY(12px) scale(.97)}to{opacity:1;transform:none}}",
		".apx-scroll{overflow:auto;padding:16px 18px 18px}",
		".apx-close{position:absolute;top:12px;right:12px;z-index:5;width:28px;height:28px;border:0;border-radius:50%;background:var(--surface-2);color:var(--ink-2);cursor:pointer;display:grid;place-items:center;transition:transform var(--dur-fast) var(--ease-out),background var(--dur-fast) ease}",
		".apx-close:hover{background:var(--rule)}",
		".apx-close:active{transform:scale(.9)}",

		/* masthead — a proper title bar: title on the left, status + actions on the
		   right. The close button is absolutely positioned over the top-right
		   corner, so the bar reserves room for it (`--apx-close-w`) and never
		   lets a control slide underneath. */
		".apx-mast{display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:center;gap:12px;padding:0 0 9px;border-bottom:1px solid var(--rule);min-height:32px}",
		".apx-mast h1{margin:0;font-family:var(--font);font-size:18px;font-weight:600;letter-spacing:-.01em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
		".apx-mast-sub{font-family:var(--mono);font-size:10px;color:var(--ink-3);text-align:right;line-height:1.6}",
		".apx-mast-sub b{color:var(--ink-2);font-weight:500}",
		".apx-mast-bar{display:flex;align-items:center;gap:8px;min-width:0;padding-right:var(--apx-close-w)}",
		".apx-mast-bar--wrap{flex-wrap:wrap;justify-content:flex-end}",

		/* connection pills in the title bar */
		".apx-pill{display:inline-flex;align-items:center;gap:6px;padding:4px 9px;border:1px solid var(--rule);border-radius:var(--r-pill);background:var(--surface-2);font-family:var(--mono);font-size:10px;line-height:1;color:var(--ink-2);white-space:nowrap;cursor:default}",
		".apx-pill i{flex:none;width:6px;height:6px;border-radius:50%;background:var(--rule-2)}",
		".apx-pill--on i{background:var(--green)}",
		".apx-pill--off i{background:var(--ink-3)}",
		".apx-pill--err i{background:var(--red)}",
		".apx-pill--live i{background:var(--accent);animation:apx-breathe 1.6s ease-in-out infinite}",
		".apx-pill b{font-weight:600;color:var(--ink)}",
		".apx-mast-bar .apx-btn{padding:5px 11px;font-size:11px}",

		/* icon-only refresh button */
		".apx-icon-btn{display:inline-grid;place-items:center;width:26px;height:26px;padding:0;border:1px solid var(--rule);border-radius:50%;background:var(--surface-2);color:var(--ink-2);cursor:pointer;transition:background var(--dur-fast) ease,color var(--dur-fast) ease,transform var(--dur-fast) var(--ease-out)}",
		".apx-icon-btn:hover:not(:disabled){background:var(--rule);color:var(--ink)}",
		".apx-icon-btn:active:not(:disabled){transform:scale(.9)}",
		".apx-icon-btn:disabled{opacity:.5;cursor:default}",
		".apx-icon-btn.is-spin svg{animation:apx-spin .9s linear infinite}",
		"@keyframes apx-spin{to{transform:rotate(360deg)}}",
		".apx-models-head{gap:8px}",
		".apx-models-head .apx-icon-btn{margin-left:auto}",
		/* When there is no timestamp the button still needs to reach the right
		   edge; `margin-left:auto` on `.apx-trend-s` would otherwise be the only
		   thing pushing, and it is absent. */
		".apx-models-head .apx-trend-s{margin-left:auto}",
		".apx-models-head .apx-trend-s + .apx-icon-btn{margin-left:8px}",

		/* three metric cards (replaces the hero + ledger) */
		".apx-metrics{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-top:14px}",
		".apx-card{background:var(--surface-2);border:1px solid var(--rule);border-radius:var(--r-md);padding:12px 14px;display:flex;flex-direction:column;gap:8px}",
		".apx-card-k{font-size:12px;color:var(--ink-3)}",
		".apx-card-v{font-family:var(--mono);font-size:18px;font-weight:600;font-variant-numeric:tabular-nums;color:var(--ink);word-break:break-word}",
		".apx-card-v small{margin-left:4px;font-size:10px;color:var(--ink-3)}",
		".apx-card--sum{background:var(--accent-soft);border-color:transparent}",
		".apx-card--sum .apx-card-v{color:var(--accent)}",
		".apx-card-cta{margin-top:2px;align-self:flex-start;text-decoration:none}",

		/* trend strip */
		".apx-trend{margin-top:14px}",
		".apx-trend-head{display:flex;align-items:center;gap:10px;padding-bottom:8px;border-bottom:1px solid var(--rule)}",
		".apx-trend-t{font-family:var(--font);font-size:14px;font-weight:600}",
		".apx-trend-s{margin-left:auto;font-family:var(--mono);font-size:10px;color:var(--ink-3)}",
		".apx-switch{position:relative;display:inline-flex;background:var(--surface-2);border-radius:var(--r-pill);padding:2px}",
		".apx-switch button{position:relative;z-index:1;border:0;background:transparent;padding:5px 12px;border-radius:var(--r-pill);font-family:var(--mono);font-size:11px;color:var(--ink-2);cursor:pointer;transition:color var(--dur) ease}",
		".apx-switch button.is-on{color:var(--ink)}",
		".apx-switch .apx-thumb{position:absolute;top:2px;bottom:2px;background:var(--surface);border-radius:var(--r-pill);box-shadow:0 1px 3px rgba(0,0,0,.12);transition:transform var(--dur) var(--ease-out),width var(--dur) var(--ease-out)}",
		".apx-plot{display:flex;align-items:flex-end;gap:2px;height:112px;margin-top:12px}",
		".apx-bar{flex:1;background:var(--accent);border-radius:5px 5px 0 0;transform:scaleY(0);transform-origin:bottom;opacity:.92;transition:transform var(--dur-slow) var(--ease-out),background var(--dur-fast) ease,opacity var(--dur-fast) ease}",
		".apx-bar.show{transform:scaleY(1)}",
		".apx-axis{display:flex;justify-content:space-between;margin-top:4px;font-family:var(--mono);font-size:9px;color:var(--ink-3)}",
		".apx-stat-row{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-top:12px}",
		".apx-stat{background:var(--surface-2);border:1px solid var(--rule);border-radius:var(--r-md);padding:10px 12px}",
		".apx-stat-k{font-size:11px;color:var(--ink-3)}",
		".apx-stat-v{margin-top:4px;font-family:var(--mono);font-size:15px;font-weight:600;font-variant-numeric:tabular-nums;color:var(--ink)}",
		".apx-stat-v small{margin-left:3px;font-size:9px;color:var(--ink-3)}",

		/* models + console connection */
		".apx-models{margin-top:14px}",
		".apx-models .apx-trend-head{border-bottom:0;padding-bottom:0}",
		".apx-models-list{display:flex;flex-wrap:wrap;gap:6px;margin-top:10px}",
		".apx-chip{display:inline-flex;align-items:center;gap:5px;padding:5px 11px;border:1px solid transparent;border-radius:var(--r-pill);font-family:var(--mono);font-size:11px;color:var(--ink-2);background:var(--surface-2)}",
		".apx-chip.is-on{background:var(--accent-soft);color:var(--accent)}",
		".apx-chip--warn{border-color:var(--red);color:var(--red)}",
		".apx-chip i{font-style:normal;font-size:8px;letter-spacing:.1em;text-transform:uppercase}",
		".apx-connect{margin-top:14px;padding:14px 16px;border:1px solid var(--rule);border-radius:var(--r-md);background:var(--surface-2);display:flex;flex-direction:column;gap:10px}",
		".apx-form{display:flex;gap:8px;margin-top:12px;flex-wrap:wrap}",
		".apx-input{flex:1;min-width:200px;height:34px;padding:0 12px;border:1px solid var(--rule-2);border-radius:var(--r-sm);background:var(--surface);font-family:var(--mono);font-size:12px;color:var(--ink)}",
		".apx-input:focus{outline:none;border-color:var(--accent);box-shadow:0 0 0 3px var(--accent-soft)}",
		".apx-btn{font-family:var(--font);font-size:13px;border:0;cursor:pointer;border-radius:var(--r-sm);padding:7px 14px;transition:transform var(--dur-fast) var(--ease-out),filter var(--dur-fast) ease,background var(--dur-fast) ease}",
		".apx-btn-ghost{background:var(--surface);border:1px solid var(--rule-2);color:var(--ink)}",
		".apx-btn-ghost:hover{border-color:var(--ink-2)}",
		".apx-btn--go{background:var(--accent);color:#fff;font-weight:500}",
		".apx-btn--go:hover{filter:brightness(1.06)}",
		".apx-btn--go:active{transform:scale(.96)}",
		".apx-btn:disabled{opacity:.5;cursor:default}",
		".apx-warn{color:var(--red)}",
		".apx-auto{margin-top:12px;padding:12px 14px;border:1px dashed var(--rule-2);border-radius:var(--r-sm);background:var(--surface)}",
		".apx-auto p{margin:0 0 10px}",
		".apx-step{margin-top:14px;font-size:12px;font-weight:500;color:var(--ink-2)}",
		".apx-empty{padding:36px 8px;text-align:center;font-size:13px;color:var(--ink-3)}",
		".apx :focus-visible{outline:2px solid var(--accent);outline-offset:2px}",

		/* session scope — ruled like a sub-ledger, deliberately quieter than the
		   account cards so the two bases are never read as one figure */
		".apx-scope{margin-top:14px;border:1px solid var(--rule);border-radius:var(--r-md);padding:12px 14px 14px}",
		".apx-scope-head{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap}",
		".apx-scope-t{font-size:11px;font-weight:600;letter-spacing:.14em;text-transform:uppercase;color:var(--ink-3)}",
		".apx-scope-id{font-family:var(--mono);font-size:11px;color:var(--ink-3)}",
		".apx-scope-note{margin:8px 0 0;font-size:11px;line-height:1.55;color:var(--ink-3)}",
		".apx-scope-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-top:12px}",
		".apx-scope-cell{background:var(--surface-2);border:1px solid var(--rule);border-radius:var(--r-sm);padding:8px 10px}",
		".apx-scope-k{font-size:10px;color:var(--ink-3)}",
		".apx-scope-v{margin-top:3px;font-family:var(--mono);font-size:14px;font-weight:600;font-variant-numeric:tabular-nums;color:var(--ink)}",
		".apx-scope-dl{display:grid;grid-template-columns:auto 1fr;gap:4px 12px;margin:12px 0 0;font-size:11px}",
		".apx-scope-dl dt{color:var(--ink-3)}",
		".apx-scope-dl dd{margin:0;font-family:var(--mono);font-variant-numeric:tabular-nums;color:var(--ink-2);text-align:right}",
		".apx-scope-ctx{margin-top:12px;padding-top:10px;border-top:1px solid var(--rule)}",

		"@media (max-width:760px){.apx-metrics{grid-template-columns:1fr}.apx-stat-row{grid-template-columns:1fr}.apx-scope-grid{grid-template-columns:1fr}.apx-mast{grid-template-columns:minmax(0,1fr)}.apx-mast-bar{justify-content:flex-start;padding-right:var(--apx-close-w)}}",
		"@media (hover:hover) and (pointer:fine){.apx-bar:hover{background:var(--accent-strong);opacity:1}}",
		"@media (prefers-reduced-motion:reduce){*{transition-duration:.01ms!important;animation-duration:.01ms!important;animation-iteration-count:1!important}.apx-bar{transform:none!important}.apx-book{animation:none!important}}",
		].join("");

		if (typeof document !== "undefined") {
			const tagId = "dsh-plugin-apicost/ui.css";
			if (document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") === null) {
				const tag = document.createElement("style");
				tag.dataset.plugin = "dsh-plugin-apicost";
				tag.dataset.pluginCss = tagId;
				tag.textContent = css;
				document.head.appendChild(tag);
			}
		}

		/* ------------------------------------------------------------------ *
		 * Copy
		 * ------------------------------------------------------------------ */

		const DICT = {
			zh: {
				seatLabel: "API 用量",
				bookTitle: "用量概览",
				close: "关闭",
				balance: "总余额",
				granted: "赠金",
				toppedUp: "充值余额",
				updatedAt: "更新",
				allTokens: "累计使用 TOKEN",
				allCost: "累计使用金额",
				monthCost: "本月消费",
				monthTokens: "本月 TOKEN",
				monthCalls: "本月调用次数",
				trend: "每日趋势",
				metricCost: "金额",
				metricTokens: "TOKEN",
				metricCalls: "调用次数",
				topUp: "去充值",
				topUpNote: "在 platform.deepseek.com 完成充值",
				models: "模型列表",
				modelsRefresh: "重新获取模型列表",
				modelsRefreshing: "正在获取模型列表",
				connApi: "API",
				connConsole: "控制台",
				connOn: "已连接",
				connOff: "未连接",
				liveNow: "调用中",
				currentModel: "当前",
				noModel: "尚未调用",
				consoleOff: "平台控制台未连接",
				consoleWhy: "累计使用金额、累计 TOKEN 与每日趋势来自平台控制台的用量接口（官方 API 只有余额与模型列表），需要一次性授权控制台令牌——不是 API Key。",
				consoleAuto: "一键读取",
				consoleAutoHint: "已经在本机浏览器登录 platform.deepseek.com？点这里自动取出令牌，无需手抄。",
				consoleSameOrigin: "当前页面就在 platform.deepseek.com 上，可以直接读取本机已登录的令牌。",
				consoleManual: "手动粘贴",
				consoleHow: "若自动读取不可用，在已登录 platform.deepseek.com 的浏览器里打开开发者工具 → Application → Local Storage → userToken，复制它的值粘贴到这里。",
				consoleInput: "粘贴控制台令牌",
				consoleSave: "保存并读取",
				consoleClear: "断开",
				consoleSaved: "令牌只写入 dsh 凭据库：插件不落盘、不记日志、不发给浏览器。",
				consoleInvalid: "令牌看起来不对（控制台令牌不是 sk- 开头的 API Key）。",
				consoleNoStore: "dsh 凭据服务不可用，无法保存令牌。",
				consoleStoreFailed: "写入凭据库失败。",
				consoleMissing: "没读到令牌：请确认这个浏览器已登录 platform.deepseek.com，或改用手动粘贴。",
				consoleBlocked: "浏览器拒绝读取本机存储，请改用手动粘贴。",
				noApiKey: "未找到 API Key 凭据",
				noConsole: "未连接平台控制台",
				expired: "登录态已失效，请重新授权控制台令牌",
				retry: "重新读取",
				refreshing: "读取中…",
				empty: "连接平台控制台后，这里会显示累计金额、累计 TOKEN 与每日趋势。",
				unavailable: "余额不可用",
				loading: "正在读取…",
				synced: "已同步",
				offline: "连接中断",
				sessionTitle: "本次会话",
				sessionScope: "本次会话由 Harness 自行统计，与平台账单口径不同，两者不可相加。",
				sessionBilled: "计费输入",
				sessionOutput: "输出",
				sessionTotal: "合计",
				sessionCacheRead: "缓存命中",
				sessionCacheWrite: "缓存写入",
				sessionCacheHit: "命中率",
				sessionUncached: "未命中输入",
				sessionContext: "上下文占用",
				sessionApprox: "约",
				sessionNoSession: "还没有活跃会话。",
				sessionNotMeasured: "本次会话尚无用量记录（发出一次请求后出现）。",
				sessionUnusable: "用量数据不完整，已跳过。",
				sessionOf: "第 {n} 个会话",
			},
			en: {
				seatLabel: "API usage",
				bookTitle: "Usage overview",
				close: "Close",
				balance: "Total balance",
				granted: "Granted",
				toppedUp: "Topped up",
				updatedAt: "Updated",
				allTokens: "Tokens used (all time)",
				allCost: "Spend (all time)",
				monthCost: "Spend this month",
				monthTokens: "Tokens this month",
				monthCalls: "Calls this month",
				trend: "Daily trend",
				metricCost: "Cost",
				metricTokens: "Tokens",
				metricCalls: "Calls",
				topUp: "Top up",
				topUpNote: "complete the payment on platform.deepseek.com",
				models: "Models",
				modelsRefresh: "Reload the model list",
				modelsRefreshing: "Reloading the model list",
				connApi: "API",
				connConsole: "Console",
				connOn: "Connected",
				connOff: "Not connected",
				liveNow: "Streaming",
				currentModel: "current",
				noModel: "no calls yet",
				consoleOff: "Platform console not connected",
				consoleWhy: "All-time spend, all-time tokens and the daily trend come from the console usage endpoints — the open API only serves balance and the model list — so a one-off console token is needed (not an API key).",
				consoleHow: "Open devtools on a signed-in platform.deepseek.com → Application → Local Storage → userToken and copy its value.",
				consoleAuto: "Read it for me",
				consoleAutoHint: "Signed in to platform.deepseek.com in this browser? Read the token automatically — no copy-paste.",
				consoleSameOrigin: "This page is on platform.deepseek.com, so the signed-in token can be read directly.",
				consoleManual: "Paste manually",
				consoleClear: "Disconnect",
				consoleSaved: "The token is written to the dsh credential store only: no plugin file, no log line, never sent to the browser.",
				consoleInvalid: "That does not look right (a console token is not an sk- API key).",
				consoleNoStore: "The dsh credential service is unavailable, so the token cannot be stored.",
				consoleStoreFailed: "Writing to the credential store failed.",
				noApiKey: "No API key credential found",
				noConsole: "Platform console not connected",
				expired: "The console session expired; paste the token again",
				retry: "Read again",
				refreshing: "Reading…",
				empty: "Connect the console and the all-time figures and daily trend appear here.",
				unavailable: "Balance unavailable",
				loading: "Loading…",
				synced: "synced",
				offline: "connection lost",
				sessionTitle: "This session",
				sessionScope: "Counted by the harness for this session alone — a different basis from the platform bill, and never added to it.",
				sessionBilled: "Billed input",
				sessionOutput: "Output",
				sessionTotal: "Total",
				sessionCacheRead: "Cache read",
				sessionCacheWrite: "Cache write",
				sessionCacheHit: "Hit rate",
				sessionUncached: "Uncached input",
				sessionContext: "Context",
				sessionApprox: "≈",
				sessionNoSession: "No live session yet.",
				sessionNotMeasured: "This session has no usage yet — it appears after one request.",
				sessionUnusable: "The usage value was incomplete, so it was skipped.",
				sessionOf: "session {n}",
			},
		};

		const LANG = (() => {
			try {
				const fromDocument = typeof document !== "undefined" ? document.documentElement?.lang : "";
				const fromNavigator = typeof navigator !== "undefined" ? navigator.language : "";
				const tag = fromDocument !== "" && fromDocument !== undefined ? fromDocument : (fromNavigator ?? "en");
				return String(tag).toLowerCase().startsWith("zh") ? "zh" : "en";
			} catch {
				return "en";
			}
		})();
		const COPY = DICT[LANG] ?? DICT.en;
		/**
		 * Look one key up, substituting `{name}` placeholders when a vars bag is
		 * supplied. The fallback chain stays: chosen locale, then English, then
		 * the key itself, so a missing string is visible rather than blank.
		 *
		 * @param {string} key - the copy key.
		 * @param {Record<string, string | number>} [vars] - placeholder values.
		 * @returns {string} the resolved copy.
		 */
		function t(key, vars) {
			const raw = COPY[key] ?? DICT.en[key] ?? key;
			if (vars === undefined) return raw;
			return raw.replace(/\{(\w+)\}/gu, (match, name) => (Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : match));
		}

		/* ------------------------------------------------------------------ *
		 * Formatting — money keeps the unit the account quotes; nothing converts.
		 * ------------------------------------------------------------------ */

		function currencySign(code) {
			if (code === "CNY") return "¥";
			if (code === "USD") return "$";
			return typeof code === "string" && code !== "" ? code + " " : "";
		}

		function money(currency, value, digits) {
			if (value === null || value === undefined || !Number.isFinite(Number(value))) return "—";
			return currencySign(currency ?? "CNY") + Number(value).toFixed(digits ?? 2);
		}

		function compact(value) {
			const n = Number(value);
			if (!Number.isFinite(n)) return "—";
			if (n < 1000) return String(Math.round(n));
			if (n < 1e6) return `${(n / 1000).toFixed(n < 1e5 ? 1 : 0)}k`;
			if (n < 1e9) return `${(n / 1e6).toFixed(n < 1e8 ? 2 : 1)}M`;
			return `${(n / 1e9).toFixed(2)}B`;
		}

		function count(value) {
			const n = Number(value);
			if (!Number.isFinite(n)) return "—";
			return Math.round(n).toLocaleString(LANG === "zh" ? "zh-CN" : "en-US");
		}

		function clock(at) {
			if (!at) return "—";
			try {
				return new Date(at).toLocaleString(LANG === "zh" ? "zh-CN" : "en-US", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
			} catch {
				return "—";
			}
		}

		/* ------------------------------------------------------------------ *
		 * Store — snapshot polling plus an SSE feed
		 * ------------------------------------------------------------------ */

		const SNAPSHOT_URL = "/api/apicost/snapshot";
		const EVENTS_URL = "/api/apicost/events";
		const REFRESH_URL = "/api/apicost/refresh";
		const TOKEN_URL = "/api/apicost/console-token";
		/**
		 * Poll cadence. Before the first snapshot lands the store retries quickly:
		 * the first page load races the host, and a single failed fetch used to
		 * leave the seat empty until the user refreshed the page by hand.
		 */
		const FIRST_LOAD_INTERVAL_MS = 2000;
		const KEEPALIVE_INTERVAL_MS = 60000;
		const REQUEST_TIMEOUT_MS = 10000;
		/**
		 * Ceiling on SSE (re)connects before the feed is abandoned in favour of
		 * plain polling. Small on purpose: the server caps concurrent streams and
		 * answers `503` past the cap, and an `EventSource` would otherwise retry
		 * that refusal forever.
		 */
		const STREAM_MAX_ATTEMPTS = 3;

		/** The console origin whose Local Storage holds the signed-in token. */
		const CONSOLE_ORIGIN = "https://platform.deepseek.com";
		/** The Local Storage key the console writes its session token to. */
		const CONSOLE_STORAGE_KEY = "userToken";

		/**
		 * Read the console token out of a `userToken` value.
		 *
		 * The console stores a JSON envelope (`{"value":"<64-char token>",…}`),
		 * so both that envelope and a bare token are accepted. The token itself
		 * is opaque — 48 random bytes, no JWT claims — so there is nothing to
		 * decode or validate beyond its shape.
		 *
		 * @param {unknown} raw - the raw Local Storage value.
		 * @returns {string | null} the bare token, or null when unreadable.
		 */
		function readTokenValue(raw) {
			if (typeof raw !== "string") return null;
			const trimmed = raw.trim();
			if (trimmed === "") return null;
			if (trimmed.startsWith("{")) {
				try {
					const parsed = JSON.parse(trimmed);
					const candidate = parsed && (parsed.value ?? parsed.token ?? parsed.accessToken);
					return typeof candidate === "string" && candidate.trim() !== "" ? candidate.trim() : null;
				} catch {
					return null;
				}
			}
			return trimmed;
		}

		/**
		 * Try to recover the console token from this browser.
		 *
		 * Only the same-origin case can work: `platform.deepseek.com`'s Local
		 * Storage is unreachable from the harness origin, and cross-origin
		 * `localStorage` access is blocked by the browser. When the panel is
		 * served from the harness this therefore reports `unavailable` and the
		 * manual paste stays the fallback — the button is hidden rather than
		 * shown broken.
		 *
		 * @returns {{ status: "found" | "missing" | "blocked" | "unavailable", token: string | null }} outcome.
		 */
		function readConsoleTokenFromBrowser() {
			if (typeof window === "undefined" || typeof window.localStorage === "undefined") {
				return { status: "unavailable", token: null };
			}
			if (window.location.origin !== CONSOLE_ORIGIN) {
				// Same-origin policy: another site's storage is not readable.
				return { status: "unavailable", token: null };
			}
			let raw = null;
			try {
				raw = window.localStorage.getItem(CONSOLE_STORAGE_KEY);
			} catch {
				// Storage can be disabled outright (private mode, site settings).
				return { status: "blocked", token: null };
			}
			const token = readTokenValue(raw);
			return token === null ? { status: "missing", token: null } : { status: "found", token };
		}

		/** The trend's three readings, drawn from the same daily rows. */
		const METRICS = [
			{ id: "cost", label: "metricCost", pick: (day) => day.cost ?? 0 },
			{ id: "tokens", label: "metricTokens", pick: (day) => day.tokens ?? 0 },
			{ id: "calls", label: "metricCalls", pick: (day) => day.calls ?? 0 },
		];

		/**
		 * Build the panel's store.
		 *
		 * @param {object} [options] - optional host hooks.
		 * @param {(error: unknown) => void} [options.onListenerError] - receives a
		 *   listener's failure. Absent, the failure is dropped silently; it is
		 *   never written to the console.
		 * @returns {object} the store handed to every component.
		 */
		function createCostStore(options = {}) {
			let state = {
				data: null,
				error: null,
				open: false,
				connected: false,
				pending: false,
				modelsPending: false,
				saving: false,
				metric: "cost",
				receivedAt: 0,
			};
			const listeners = new Set();
			let source = null;
			let pollTimer = null;
			let pollInterval = 0;
			let started = false;
			/**
			 * How many times the SSE feed has been (re)opened since it last opened
			 * cleanly. Bounded so a server that keeps refusing cannot make the tab
			 * retry forever; see {@link openStream}.
			 */
			let streamAttempts = 0;

			/**
			 * Publish one patch to every listener.
			 *
			 * A throwing listener is isolated so it cannot abort the fan-out, and
			 * the failure is reported through `onListenerError` rather than the
			 * console: the browser half runs inside the harness's own page and
			 * must not write to its console, exactly as the host half does not.
			 * The reporter is a parameter so a host can route it to its logger;
			 * with none, the failure is swallowed rather than printed.
			 */
			function emit(patch) {
				state = Object.assign({}, state, patch);
				for (const listener of Array.from(listeners)) {
					try {
						listener();
					} catch (error) {
						if (typeof options?.onListenerError === "function") options.onListenerError(error);
					}
				}
			}

			/**
			 * Arm the poll. Ignored once the store has been stopped.
			 *
			 * The guard is what makes {@link stop} stick: `start` fires a fetch
			 * that is still in flight when the last reader unsubscribes, and the
			 * fetch's own completion path calls back here. Without the `started`
			 * check that late call re-arms the interval on a store nobody reads
			 * any more, and the tab polls — and holds the server's capped SSE
			 * slot — for as long as it stays open.
			 */
			function schedulePoll(interval) {
				if (!started) return;
				if (pollTimer !== null && pollInterval === interval) return;
				if (pollTimer !== null) clearInterval(pollTimer);
				pollInterval = interval;
				pollTimer = setInterval(() => {
					void fetchSnapshot();
				}, interval);
			}

			/**
			 * Decide the next poll cadence from a snapshot. Keep polling fast until the
			 * panel actually has data: a slow or absent SSE feed, or a token that
			 * resolves late, must not force the user to wait up to the 60s keep-alive
			 * window. Once the balance is known and usage is either present or the
			 * console token is simply not configured, slow down.
			 * @param {object} snapshot - the snapshot to judge.
			 * @returns {number} the interval to schedule.
			 */
			function pollIntervalFor(snapshot) {
				const apiReady = snapshot && snapshot.api && snapshot.api.preferred !== null;
				const creds = snapshot && snapshot.credentials && snapshot.credentials.consoleToken;
				const tokenConfigured = creds && creds.configured === true;
				const usageReady = (snapshot && snapshot.console && snapshot.console.usage !== null) || !tokenConfigured;
				return apiReady && usageReady ? KEEPALIVE_INTERVAL_MS : FIRST_LOAD_INTERVAL_MS;
			}

			function timeoutSignal() {
				try {
					return typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function" ? AbortSignal.timeout(REQUEST_TIMEOUT_MS) : undefined;
				} catch {
					return undefined;
				}
			}

			async function request(url, init) {
				const response = await fetch(url, Object.assign({ cache: "no-store", headers: { accept: "application/json" }, signal: timeoutSignal() }, init));
				let payload = null;
				try {
					payload = await response.json();
				} catch {
					payload = null;
				}
				return { ok: response.ok, status: response.status, payload };
			}

			async function fetchSnapshot() {
				try {
					const { ok, payload } = await request(SNAPSHOT_URL);
					if (!ok || payload === null || payload.ok !== true) throw new Error((payload && payload.error && payload.error.message) || "snapshot failed");
					emit({ data: payload.snapshot, error: null, receivedAt: Date.now() });
					schedulePoll(pollIntervalFor(payload.snapshot));
				} catch (error) {
					emit({ error: String((error && error.message) || error) });
					schedulePoll(FIRST_LOAD_INTERVAL_MS);
				}
			}

			/**
			 * Open the SSE feed, with bounded reconnection.
			 *
			 * An `EventSource` reconnects on its own, forever, and it cannot see
			 * an HTTP status: the server caps concurrent streams (`maxSseClients`)
			 * and answers `503` past the cap, which the browser reads as "the
			 * stream ended" and retries immediately. Left alone that is an
			 * unbounded request loop from a tab the user may have left open —
			 * and combined with the poll below, exactly the "endless spinner"
			 * shape this plugin was reported to cause.
			 *
			 * So reconnection is taken over here rather than delegated: the
			 * browser's own retry is disabled by closing the stream on error, and
			 * this store reopens it itself, at most `STREAM_MAX_ATTEMPTS` times.
			 * A *clean* open resets the budget (a drop after a working connection
			 * is a different event from a server that refuses to serve us), and
			 * when the budget runs out the feed is abandoned for good. The panel
			 * stays live on the poll alone, which asks strictly less of the
			 * server than an unbounded reconnect loop does.
			 */
			function openStream() {
				if (typeof EventSource !== "function") return;
				if (source !== null) return;
				if (streamAttempts >= STREAM_MAX_ATTEMPTS) return;
				streamAttempts += 1;
				let stream;
				try {
					stream = new EventSource(EVENTS_URL);
				} catch {
					return;
				}
				source = stream;
				stream.onopen = () => {
					// A connection that actually opened earns the budget back.
					streamAttempts = 0;
					emit({ connected: true });
					void fetchSnapshot();
				};
				stream.onmessage = (event) => {
					try {
						const payload = JSON.parse(event.data);
						if (payload && payload.type === "snapshot" && payload.snapshot) {
							emit({ data: payload.snapshot, error: null, connected: true, receivedAt: Date.now() });
							schedulePoll(pollIntervalFor(payload.snapshot));
						}
					} catch {
						// A malformed frame is dropped; the next one replaces it.
					}
				};
				stream.onerror = () => {
					emit({ connected: false });
					schedulePoll(FIRST_LOAD_INTERVAL_MS);
					// Close first: this is what stops the browser's own reconnect
					// loop. Reopening is then this store's decision, and countable.
					try {
						stream.close();
					} catch {
						// Already closed; nothing to release.
					}
					if (source === stream) source = null;
					// A stop() took the feed down while this error was in flight;
					// reopening it would resurrect a stream nobody is reading.
					if (!started) return;
					if (streamAttempts < STREAM_MAX_ATTEMPTS) openStream();
				};
			}

			/**
			 * Stop the feed and the poll.
			 *
			 * Nothing else can free these: the subscription is the store's only
			 * lifecycle hook, and `useSyncExternalStore` may drop it when the seat
			 * unmounts or the page tears a subtree down. Leaving the interval armed
			 * would keep the tab fetching forever with nobody reading the result,
			 * and would hold a slot in the server's capped SSE pool open, so the
			 * poll and the stream are both released here and re-armed by
			 * {@link start} if the seat is mounted again.
			 */
			function stop() {
				if (pollTimer !== null) {
					clearInterval(pollTimer);
					pollTimer = null;
					pollInterval = 0;
				}
				if (source !== null) {
					try {
						source.close();
					} catch {
						// Already closed; nothing to release.
					}
					source = null;
				}
				started = false;
				streamAttempts = 0;
			}

			function start() {
				if (started) return;
				started = true;
				openStream();
				schedulePoll(FIRST_LOAD_INTERVAL_MS);
				void fetchSnapshot();
			}

			return {
				getSnapshot() {
					return state;
				},
				subscribe(listener) {
					listeners.add(listener);
					start();
					return () => {
						listeners.delete(listener);
						// The last reader left; release the interval and the stream
						// rather than keep a detached tab polling and streaming.
						if (listeners.size === 0) stop();
					};
				},
				setOpen(open) {
					emit({ open: open === true });
				},
				toggle() {
					emit({ open: !state.open });
				},
				setMetric(metric) {
					emit({ metric });
				},
				async refresh() {
					emit({ pending: true });
					try {
						const { ok, payload } = await request(REFRESH_URL, { method: "POST" });
						if (!ok || payload === null || payload.ok !== true) throw new Error((payload && payload.error && payload.error.message) || "refresh failed");
						emit({ data: payload.snapshot, error: null, pending: false, receivedAt: Date.now() });
					} catch (error) {
						emit({ error: String((error && error.message) || error), pending: false });
					}
				},
				/**
				 * Re-read the model list only.
				 *
				 * Tracked separately from `pending` so the model-list button spins
				 * without the whole panel claiming to be busy — the two refreshes
				 * have different costs and different reasons.
				 */
				async refreshModels() {
					emit({ modelsPending: true });
					try {
						const { ok, payload } = await request(REFRESH_URL, { method: "POST" });
						if (!ok || payload === null || payload.ok !== true) throw new Error((payload && payload.error && payload.error.message) || "refresh failed");
						emit({ data: payload.snapshot, error: null, modelsPending: false, receivedAt: Date.now() });
					} catch (error) {
						emit({ error: String((error && error.message) || error), modelsPending: false });
					}
				},
				/** Store the console token; the value travels one way only. */
				async saveConsoleToken(token) {
					emit({ saving: true });
					try {
						const { ok, payload } = await request(TOKEN_URL, {
							method: "POST",
							headers: { "content-type": "application/json", accept: "application/json" },
							body: JSON.stringify({ token }),
						});
						if (!ok || payload === null || payload.ok !== true) {
							const failure = (payload && payload.error) || null;
							emit({ saving: false });
							return { ok: false, code: (failure && failure.code) || "STORE_FAILED", message: (failure && failure.message) || "" };
						}
						emit({ data: payload.snapshot, error: null, saving: false, receivedAt: Date.now() });
						return { ok: true };
					} catch (error) {
						emit({ saving: false, error: String((error && error.message) || error) });
						return { ok: false, code: "NETWORK", message: String((error && error.message) || error) };
					}
				},
				async clearConsoleToken() {
					try {
						const { payload } = await request(TOKEN_URL, { method: "DELETE" });
						if (payload !== null && payload.ok === true) emit({ data: payload.snapshot, error: null, receivedAt: Date.now() });
					} catch (error) {
						emit({ error: String((error && error.message) || error) });
					}
				},
			};
		}

		/* ------------------------------------------------------------------ *
		 * Primitives
		 * ------------------------------------------------------------------ */

		function useCost(store) {
			return React.useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
		}

		/** One small statistic in the ruled row under the chart. */
		function Stat({ label, value, unit }) {
			return h(
				"div",
				{ className: "apx-stat" },
				h("div", { className: "apx-stat-k" }, label),
				h("div", { className: "apx-stat-v" }, value, unit ? h("small", null, unit) : null),
			);
		}

		/**
		 * The daily strip: one column per day of the month, drawn as plain
		 * HTML bars so the bundle stays dependency-free. Each bar grows from the
		 * baseline when it mounts (a transform-only entrance) and replays when
		 * the metric changes, because the parent remounts this subtree by key.
		 * Days the console did not report stay flat instead of being filled in.
		 */
		function DailyStrip({ month, days, metric, format }) {
			const parts = String(month ?? "").split("-").map((part) => Number.parseInt(part, 10));
			const year = parts[0];
			const monthNumber = parts[1];
			if (!Number.isFinite(year) || !Number.isFinite(monthNumber)) return h("div", { className: "apx-empty" }, t("empty"));
			const lastDay = new Date(year, monthNumber, 0).getDate();
			const now = new Date();
			const isCurrent = now.getFullYear() === year && now.getMonth() + 1 === monthNumber;
			const span = isCurrent ? Math.max(1, now.getDate()) : lastDay;
			const byDay = new Map((days ?? []).map((entry) => [entry.day, entry]));
			const columns = [];
			for (let day = 1; day <= span; day += 1) {
				const key = `${year}-${String(monthNumber).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
				const entry = byDay.get(key) ?? null;
				columns.push({ key, value: entry === null ? 0 : Number(metric.pick(entry)) || 0 });
			}
			const peak = columns.reduce((max, column) => Math.max(max, column.value), 0);
			const BASE = 104;
			const reduce = typeof window !== "undefined" && typeof window.matchMedia === "function" ? window.matchMedia("(prefers-reduced-motion: reduce)").matches : false;
			const ref = React.useRef(null);
			React.useEffect(() => {
				const root = ref.current;
				if (root === null) return;
				const nodes = root.querySelectorAll(".apx-bar");
				if (typeof requestAnimationFrame !== "function") {
					for (const node of Array.from(nodes)) node.classList.add("show");
					return;
				}
				let second = 0;
				const first = requestAnimationFrame(() => {
					second = requestAnimationFrame(() => {
						for (const node of Array.from(nodes)) node.classList.add("show");
					});
				});
				return () => {
					cancelAnimationFrame(first);
					cancelAnimationFrame(second);
				};
			}, [metric.id, span]);
			const labels = [1, Math.round(span / 2), span]
				.filter((day, index, list) => list.indexOf(day) === index && day >= 1 && day <= span)
				.map((day) => h("span", { key: day }, String(day)));
			return h(
				React.Fragment,
				null,
				h(
					"div",
					{ className: "apx-plot", ref, role: "img", "aria-label": t("trend") },
					columns.map((column, index) =>
						h("div", {
							key: column.key,
							className: "apx-bar",
							style: {
								height: (peak === 0 ? 0 : Math.max(2, (column.value / peak) * BASE)) + "px",
								transitionDelay: (reduce ? "0ms" : Math.min(index * 10, 280) + "ms"),
							},
							title: `${column.key} · ${format(column.value)}`,
						}),
					),
				),
				h("div", { className: "apx-axis" }, labels),
			);
		}

		/**
		 * The segmented control: a single thumb slides under the active reading.
		 * It is positioned from the live DOM so it tracks the button it sits on,
		 * and re-positions on metric change and on resize.
		 */
		function Segmented({ metric, onPick }) {
			const wrapRef = React.useRef(null);
			const thumbRef = React.useRef(null);
			const move = React.useCallback(() => {
				const wrap = wrapRef.current;
				const thumb = thumbRef.current;
				if (wrap === null || thumb === null) return;
				const active = wrap.querySelector("button.is-on");
				if (active === null) return;
				thumb.style.width = active.offsetWidth + "px";
				thumb.style.transform = "translateX(" + (active.offsetLeft - 2) + "px)";
			}, []);
			React.useEffect(() => {
				move();
			}, [metric, move]);
			React.useEffect(() => {
				const onResize = () => move();
				if (typeof window !== "undefined" && typeof window.addEventListener === "function") window.addEventListener("resize", onResize);
				return () => {
					if (typeof window !== "undefined" && typeof window.removeEventListener === "function") window.removeEventListener("resize", onResize);
				};
			}, [move]);
			return h(
				"span",
				{ className: "apx-switch", ref: wrapRef },
				h("span", { className: "apx-thumb", ref: thumbRef }),
				METRICS.map((entry) => h("button", { key: entry.id, type: "button", className: metric === entry.id ? "is-on" : undefined, "data-metric": entry.id, onClick: () => onPick(entry.id) }, t(entry.label))),
			);
		}

		/* ------------------------------------------------------------------ *
		 * Sidebar seat
		 * ------------------------------------------------------------------ */

		/** The model in use: the call in flight, else the last one observed. */
		function modelLabel(data) {
			const live = (data && data.live) || {};
			const current = live.model ?? (data && data.currentModel && data.currentModel.model) ?? null;
			if (current === null || current === "") return { label: t("noModel"), short: "--" };
			return { label: current, short: String(current).replace(/^deepseek-/u, "") };
		}

		function statusOf(state) {
			const data = state.data;
			if (data && data.live && data.live.streaming === true) return "live";
			if (state.error || (data && data.api && data.api.error)) return "error";
			if (data && state.connected) return "ok";
			return "idle";
		}

		function dotClass(status) {
			if (status === "live") return "apx-dot apx-dot--live";
			if (status === "error") return "apx-dot apx-dot--err";
			if (status === "ok") return "apx-dot apx-dot--ok";
			return "apx-dot";
		}

		function SidebarCostWidget(props) {
			const state = useCost(props.cost);
			const data = state.data;
			const preferred = data && data.api ? data.api.preferred : null;
			const model = modelLabel(data);
			const status = statusOf(state);
			const hint = t("bookTitle") + (state.error ? " — " + state.error : "");
			// With no balance to show (no API key, or the call failed), the seat
			// falls back to this session's own count rather than sitting empty —
			// the session source needs no credential, so the seat always has
			// something true to report.
			const session = (data && data.session) || null;
			const sessionUsage = session && session.usage ? session.usage : null;
			const balanceText = preferred === null ? "--" : money(preferred.currency, preferred.totalBalance);

			if (props.wide === false) {
				const railMoney = preferred === null ? (sessionUsage === null ? "--" : compact(sessionUsage.totalTokens)) : money(preferred.currency, preferred.totalBalance, 1);
				return h(
					"div",
					{ className: "apx apx-foot--rail" },
					h(
						"span",
						{ className: "apx-railwrap" },
						h(
							"button",
							{ type: "button", className: "apx-rail", onClick: () => props.cost.toggle(), title: hint, "aria-label": hint },
							h("span", { className: "apx-rail-model" }, model.short),
							h("span", { className: "apx-rail-money" }, railMoney),
						),
						h("span", { className: dotClass(status) }),
					),
				);
			}

			return h(
				"div",
				{ className: "apx apx-foot" },
				h(
					"button",
					{ type: "button", className: "apx-row", onClick: () => props.cost.toggle(), title: hint, "aria-label": hint },
					h(
						"span",
						{ className: "apx-seat" },
						h(
							"span",
							{ className: "apx-seat-top" },
							h("span", { className: "apx-seat-label" }, t("seatLabel")),
							h(
								"span",
								{ className: "apx-seat-money" },
								balanceText,
								preferred !== null && preferred.currency ? h("small", null, preferred.currency) : null,
							),
						),
						h(
							"span",
							{ className: "apx-seat-bottom" },
							h("span", { className: "apx-seat-model", title: model.label }, model.label),
							sessionUsage === null
								? null
								: h("span", { className: "apx-seat-session" }, compact(sessionUsage.totalTokens) + " " + t("metricTokens")),
							h("span", { className: dotClass(status) }),
						),
					),
				),
			);
		}

		/* ------------------------------------------------------------------ *
		 * Detail window
		 * ------------------------------------------------------------------ */

		function CloseIcon() {
			return h(
				"svg",
				{ width: 13, height: 13, viewBox: "0 0 16 16", fill: "none", "aria-hidden": "true" },
				h("path", { d: "M4 4l8 8M12 4l-8 8", stroke: "currentColor", strokeWidth: "1.5", strokeLinecap: "round" }),
			);
		}

		/** A circular arrow, for the model-list refresh. */
		function RefreshIcon() {
			return h(
				"svg",
				{ width: 13, height: 13, viewBox: "0 0 16 16", fill: "none", "aria-hidden": "true" },
				h("path", { d: "M13 8a5 5 0 1 1-1.6-3.7", stroke: "currentColor", strokeWidth: "1.5", strokeLinecap: "round" }),
				h("path", { d: "M13 2.5V5.5H10", stroke: "currentColor", strokeWidth: "1.5", strokeLinecap: "round", strokeLinejoin: "round" }),
			);
		}

		/**
		 * One connection pill in the title bar: a coloured dot, a label, and an
		 * optional detail. Reads its state from the facts it is handed, so it
		 * cannot disagree with the rest of the panel about what is connected.
		 *
		 * @param {object} props - `tone` (`on` | `off` | `err` | `live`), `label`,
		 *   and an optional `detail`.
		 */
		function ConnectionPill({ tone, label, detail }) {
			return h(
				"span",
				{ className: "apx-pill apx-pill--" + tone, title: detail === null || detail === undefined ? label : String(detail) },
				h("i", null),
				h("b", null, label),
				detail === null || detail === undefined ? null : h("span", null, String(detail)),
			);
		}

		/**
		 * The current session's own usage, counted by the harness.
		 *
		 * This is the one block that works without either credential, so it is
		 * the panel's floor: even with no API key and no console token, the seat
		 * and the window have something true to say. It is deliberately *not*
		 * merged into the account cards above it — a session is not an account,
		 * and adding the two bases would produce a number that is neither.
		 */
		function SessionScope({ session }) {
			const facts = session ?? {};
			const usage = facts.usage ?? null;
			const context = facts.context ?? null;

			const reasonText = () => {
				if (facts.reason === "NO_SESSION") return t("sessionNoSession");
				if (facts.reason === "UNUSABLE") return t("sessionUnusable");
				return t("sessionNotMeasured");
			};

			return h(
				"div",
				{ className: "apx-scope" },
				h(
					"div",
					{ className: "apx-scope-head" },
					h("span", { className: "apx-scope-t" }, t("sessionTitle")),
					facts.sessionId === null || facts.sessionId === undefined
						? null
						: h("span", { className: "apx-scope-id" }, facts.sessionId),
					// Several live sessions means the figure is a choice, not a fact,
					// so the panel says which one it picked rather than implying there
					// is only one.
					Number(facts.sessions) > 1 ? h("span", { className: "apx-scope-id" }, "· " + t("sessionOf", { n: facts.sessions })) : null,
				),
				usage === null
					? h("p", { className: "apx-scope-note" }, reasonText())
					: h(
							React.Fragment,
							null,
							h(
								"div",
								{ className: "apx-scope-grid" },
								h(
									"div",
									{ className: "apx-scope-cell" },
									h("div", { className: "apx-scope-k" }, t("sessionBilled")),
									h("div", { className: "apx-scope-v" }, count(usage.billedInputTokens)),
								),
								h(
									"div",
									{ className: "apx-scope-cell" },
									h("div", { className: "apx-scope-k" }, t("sessionOutput")),
									h("div", { className: "apx-scope-v" }, count(usage.outputTokens)),
								),
								h(
									"div",
									{ className: "apx-scope-cell" },
									h("div", { className: "apx-scope-k" }, t("sessionTotal")),
									h("div", { className: "apx-scope-v" }, count(usage.totalTokens)),
								),
							),
							h(
								"dl",
								{ className: "apx-scope-dl" },
								h("dt", null, t("sessionUncached")),
								h("dd", null, count(usage.uncachedInputTokens)),
								h("dt", null, t("sessionCacheRead")),
								h("dd", null, count(usage.cacheReadTokens)),
								usage.cacheWriteTokens === 0
									? null
									: h("dt", null, t("sessionCacheWrite")),
								usage.cacheWriteTokens === 0
									? null
									: h("dd", null, count(usage.cacheWriteTokens)),
								usage.cacheHitPercent === null || usage.cacheHitPercent === undefined
									? null
									: h("dt", null, t("sessionCacheHit")),
								usage.cacheHitPercent === null || usage.cacheHitPercent === undefined
									? null
									: h("dd", null, usage.cacheHitPercent.toFixed(1) + "%"),
							),
						),
				context === null
					? null
					: h(
							"div",
							{ className: "apx-scope-ctx" },
							h("dl", { className: "apx-scope-dl" },
								h("dt", null, t("sessionContext")),
								h("dd", null, compact(context.surfaceTokens) + (context.approximated ? " " + t("sessionApprox") : "")),
							),
						),
				h("p", { className: "apx-scope-note" }, t("sessionScope")),
			);
		}

		/**
		 * The console connection card.
		 *
		 * The token is pasted or read once and then lives in the harness
		 * credential store, so this card is only ever seen on a fresh install or
		 * after a disconnect. When the panel happens to be same-origin with the
		 * console it offers a one-click read instead of a paste.
		 */
		function ConsoleCard({ consoleFacts, credentials, store, state }) {
			const tokenState = React.useState("");
			const token = tokenState[0];
			const setToken = tokenState[1];
			const noticeState = React.useState(null);
			const notice = noticeState[0];
			const setNotice = noticeState[1];
			/** Same-origin availability is decided once; it cannot change at runtime. */
			const browserScope = React.useMemo(() => readConsoleTokenFromBrowser(), []);
			const canAutoRead = browserScope.status !== "unavailable";
			const consoleToken = credentials && credentials.consoleToken ? credentials.consoleToken : null;
			const configured = consoleToken !== null && consoleToken.configured === true;
			const writable = consoleToken === null || consoleToken.writable !== false;
			const error = consoleFacts && consoleFacts.error ? consoleFacts.error : null;

			/**
			 * Save a token, mapping the host's failure code onto a message.
			 * @param {string} candidate - the token to store.
			 */
			function submit(candidate) {
				void store.saveConsoleToken(candidate).then((result) => {
					if (result !== null && result.ok === true) {
						setNotice(null);
						setToken("");
						return;
					}
					// Say which failure it was: an unusable shape, an
					// unavailable credential store, or a rejected session.
					const code = (result && result.code) || "STORE_FAILED";
					const detail = (result && result.message) || "";
					if (code === "CREDENTIALS_UNAVAILABLE") setNotice(t("consoleNoStore"));
					else if (code === "STORE_FAILED") setNotice(t("consoleStoreFailed") + (detail === "" ? "" : " · " + detail));
					else setNotice(t("consoleInvalid") + (detail === "" ? "" : " · " + detail));
				});
			}

			/** Read this browser's stored token and save it, or explain the miss. */
			function autoRead() {
				const found = readConsoleTokenFromBrowser();
				if (found.status === "found" && found.token !== null) {
					setNotice(null);
					submit(found.token);
					return;
				}
				if (found.status === "blocked") setNotice(t("consoleBlocked"));
				else setNotice(t("consoleMissing"));
			}

			// Connected: the title bar already reports the state and owns the
			// refresh / disconnect actions, so this card would only repeat them.
			// The one thing it still owes the user is the human-readable reason
			// when the token has stopped working — the pill shows the raw code.
			if (configured) {
				if (error === null) return null;
				return h(
					"div",
					{ className: "apx-connect" },
					h("p", { className: "apx-warn" }, error.code === "EXPIRED" || error.code === "NO_TOKEN" ? t("expired") : `${error.code} · ${error.message}`),
				);
			}

			return h(
				"div",
				{ className: "apx-connect" },
				h("p", { className: "apx-warn" }, t("consoleOff")),
				h("p", null, t("consoleWhy")),
				// One-click read comes first when it can work at all; the paste
				// stays underneath as the always-available fallback.
				canAutoRead
					? h(
							"div",
							{ className: "apx-auto" },
							h("p", null, browserScope.status === "found" ? t("consoleSameOrigin") : t("consoleAutoHint")),
							h(
								"button",
								{ type: "button", className: "apx-btn apx-btn--go", disabled: state.saving === true || !writable, onClick: autoRead },
								state.saving === true ? t("refreshing") : t("consoleAuto"),
							),
						)
					: null,
				h("p", { className: "apx-step" }, canAutoRead ? t("consoleManual") : t("consoleHow")),
				h("p", null, t("consoleSaved")),
				h(
					"div",
					{ className: "apx-form" },
					h("input", {
						className: "apx-input",
						type: "password",
						autoComplete: "off",
						spellCheck: false,
						placeholder: t("consoleInput"),
						value: token,
						onChange: (event) => setToken(event.target.value),
					}),
					h(
						"button",
						{
							type: "button",
							className: "apx-btn apx-btn--go",
							disabled: state.saving === true || token.trim() === "" || !writable,
							onClick: () => submit(token.trim()),
						},
						state.saving === true ? t("refreshing") : t("consoleSave"),
					),
				),
				notice === null ? null : h("p", { className: "apx-warn" }, notice),
				error === null || error.code === "NO_CONSOLE_TOKEN" ? null : h("p", { className: "apx-warn" }, `${error.code} · ${error.message}`),
			);
		}

		function ApiCostOverlay(props) {
			const state = useCost(props.cost);
			const panelRef = React.useRef(null);
			React.useEffect(() => {
				if (state.open === true) panelRef.current?.focus?.();
			}, [state.open]);
			if (state.open !== true) return null;

			const data = state.data;
			const api = (data && data.api) || {};
			const consoleFacts = (data && data.console) || {};
			const usage = consoleFacts.usage ?? null;
			const credentials = (data && data.credentials) || null;
			const preferred = api.preferred ?? null;
			const currency = (preferred && preferred.currency) || (usage && usage.currency) || "CNY";
			const metric = METRICS.find((entry) => entry.id === state.metric) ?? METRICS[0];
			const model = modelLabel(data);
			const close = () => props.cost.setOpen(false);
			const balanceLine = preferred === null ? "—" : money(currency, preferred.totalBalance);

			const format = (value) => {
				if (metric.id === "cost") return money((usage && usage.currency) || currency, value);
				if (metric.id === "tokens") return compact(value);
				return count(value);
			};
			const monthWindow = usage === null ? null : usage.window;

			/*
			 * Title-bar connection state. Derived once here so the pills, the
			 * metrics and the console card can never disagree about whether a
			 * credential is connected: they all read these few booleans.
			 */
			const apiError = api.error ?? null;
			const consoleError = consoleFacts.error ?? null;
			const apiKeyOn = credentials !== null && credentials.apiKey !== null && credentials.apiKey !== undefined && credentials.apiKey.configured === true;
			// An error with no data behind it is a broken link; an error beside
			// usable figures is a stale warning, and the pill stays "on".
			const apiBroken = apiError !== null && preferred === null;
			const consoleOn = credentials !== null && credentials.consoleToken !== null && credentials.consoleToken !== undefined && credentials.consoleToken.configured === true;
			const consoleBroken = consoleError !== null && usage === null;

			return h(
				"div",
				{ className: "apx apx-ovl", onClick: close, onKeyDown: (event) => (event.key === "Escape" ? close() : undefined) },
				h("div", { className: "apx-scrim" }),
				h(
					"div",
					{
						className: "apx-book",
						role: "dialog",
						"aria-modal": "true",
						"aria-label": t("bookTitle"),
						tabIndex: -1,
						ref: panelRef,
						onClick: (event) => event.stopPropagation(),
					},
					h("button", { type: "button", className: "apx-close", onClick: close, "aria-label": t("close"), title: t("close") }, h(CloseIcon, null)),
					h(
						"div",
						{ className: "apx-scroll" },
						h(
							"div",
							{ className: "apx-mast" },
							h("h1", null, t("bookTitle")),
							// Status and actions live here rather than beside the
							// console card: connection state belongs to the window,
							// not to one section of it. The bar reserves `--apx-close-w`
							// so nothing can slide under the absolutely positioned
							// close button.
							h(
								"div",
								{ className: "apx-mast-bar" },
								h(ConnectionPill, {
									tone: apiKeyOn ? (apiBroken ? "err" : "on") : "off",
									label: t("connApi"),
									detail: apiKeyOn ? (apiBroken ? api.error.code : t("connOn")) : t("connOff"),
								}),
								h(ConnectionPill, {
									tone: consoleOn ? (consoleBroken ? "err" : "on") : "off",
									label: t("connConsole"),
									detail: consoleOn ? (consoleBroken ? consoleError.code : t("connOn")) : t("connOff"),
								}),
								data && data.live && data.live.streaming === true ? h(ConnectionPill, { tone: "live", label: t("liveNow") }) : null,
								h(
									"button",
									{ type: "button", className: "apx-btn apx-btn-ghost", disabled: state.pending === true, onClick: () => props.cost.refresh() },
									state.pending === true ? t("refreshing") : t("retry"),
								),
								consoleOn
									? h("button", { type: "button", className: "apx-btn apx-btn--go", disabled: state.saving === true, onClick: () => props.cost.clearConsoleToken() }, t("consoleClear"))
									: null,
							),
						),

						api.error !== null && api.error !== undefined
							? h("p", { className: "apx-warn" }, api.error.code === "NO_API_KEY" ? t("noApiKey") : `${api.error.code} · ${api.error.message}`)
							: null,

						h(
							"div",
							{ className: "apx-metrics" },
							h(
								"div",
								{ className: "apx-card" },
								h("div", { className: "apx-card-k" }, t("allCost")),
								h(
									"div",
									{ className: "apx-card-v" },
									usage === null ? "—" : money(usage.currency ?? currency, usage.allTimeCost),
									usage === null ? null : h("small", null, usage.currency ?? currency),
								),
							),
							h(
								"div",
								{ className: "apx-card" },
								h("div", { className: "apx-card-k" }, t("allTokens")),
								h("div", { className: "apx-card-v" }, usage === null ? "—" : count(usage.allTimeTokens)),
							),
							h(
								"div",
								{ className: "apx-card apx-card--sum" },
								h("div", { className: "apx-card-k" }, t("balance")),
								h(
									"div",
									{ className: "apx-card-v" },
									balanceLine,
									preferred === null ? null : h("small", null, currency),
								),
								h("a", { className: "apx-btn apx-btn--go apx-card-cta", href: "https://platform.deepseek.com/top_up", target: "_blank", rel: "noopener" }, t("topUp")),
							),
						),

						h(
							"div",
							{ className: "apx-trend" },
							h(
								"div",
								{ className: "apx-trend-head" },
								h("span", { className: "apx-trend-t" }, t("trend")),
								h(Segmented, { metric: state.metric, onPick: (id) => props.cost.setMetric(id) }),
								h("span", { className: "apx-trend-s" }, String(consoleFacts.month ?? "—") + " · " + t("updatedAt") + " " + clock(consoleFacts.updatedAt)),
							),
							usage === null
								? h("div", { className: "apx-empty" }, t("empty"))
								: h(
										React.Fragment,
										null,
										h(DailyStrip, { key: metric.id, month: consoleFacts.month, days: usage.days, metric, format }),
										h(
											"div",
											{ className: "apx-stat-row" },
											h(Stat, { label: t("monthCost"), value: monthWindow === null ? "—" : money(usage.currency ?? currency, monthWindow.cost), unit: monthWindow === null ? undefined : (usage.currency ?? currency) }),
											h(Stat, { label: t("monthTokens"), value: monthWindow === null ? "—" : compact(monthWindow.tokens) }),
											h(Stat, { label: t("monthCalls"), value: monthWindow === null ? "—" : count(monthWindow.calls) }),
										),
									),
						),

						h(
							"div",
							{ className: "apx-models" },
							h(
								"div",
								{ className: "apx-trend-head apx-models-head" },
								h("span", { className: "apx-trend-t" }, t("models")),
								api.updatedAt === null || api.updatedAt === undefined ? null : h("span", { className: "apx-trend-s" }, t("updatedAt") + " " + clock(api.updatedAt)),
								h(
									"button",
									{
										type: "button",
										className: "apx-icon-btn" + (state.modelsPending === true ? " is-spin" : ""),
										disabled: state.modelsPending === true,
										onClick: () => props.cost.refreshModels(),
										"aria-label": state.modelsPending === true ? t("modelsRefreshing") : t("modelsRefresh"),
										title: state.modelsPending === true ? t("modelsRefreshing") : t("modelsRefresh"),
									},
									h(RefreshIcon, null),
								),
							),
							h(
								"div",
								{ className: "apx-models-list" },
								(api.models ?? []).length === 0
									? h(
											"span",
											{ className: "apx-chip" + (api.error === null || api.error === undefined ? undefined : " apx-chip--warn") },
											api.error === null || api.error === undefined ? t("loading") : api.error.code === "NO_API_KEY" ? t("noApiKey") : `${api.error.code} · ${api.error.message}`,
										)
									: (api.models ?? []).map((entry) =>
											h(
												"span",
												{ key: entry.id, className: "apx-chip" + (model.label === entry.id ? " is-on" : undefined) },
												entry.id,
											),
										),
							),
						),

						h(SessionScope, { session: data && data.session }),

						h(ConsoleCard, { consoleFacts, credentials, store: props.cost, state }),
					),
				),
			);
		}

		/* ------------------------------------------------------------------ *
		 * Plugin
		 * ------------------------------------------------------------------ */

		const inject = ["slots"];

		function apply(ctx) {
			const store = createCostStore();
			const seat = {
				name: "sidebar.footer.action",
				id: "apicost",
				order: 90,
				label: "API",
				inject: () => ({ cost: store }),
			};
			const overlay = Object.assign({}, seat, { name: "shell.overlay" });
			ctx.slots.inject("sidebar.footer.action", () => ctx.slots.register(seat, SidebarCostWidget));
			ctx.slots.inject("shell.overlay", () => ctx.slots.register(overlay, ApiCostOverlay));
		}

		exports.apply = apply;
		exports.inject = inject;
		exports.SidebarCostWidget = SidebarCostWidget;
		exports.ApiCostOverlay = ApiCostOverlay;
		return module.exports;
	},
});
