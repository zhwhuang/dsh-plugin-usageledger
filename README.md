# dsh-plugin-apicost

DeepSeek Harness（dsh）插件：**在侧边栏显示当前模型与账户余额，点开是一页用量概览**。

- **座位**：当前模型 + 账户余额（人民币）+ 状态点；调用进行中脉冲，取数失败变红。
  没有余额可显示时（无 API Key 或余额接口失败），座位改显当前会话的 TOKEN 合计
- **用量概览**：总余额、累计使用金额、累计使用 TOKEN、一条「去充值」入口
- **趋势**：按天的**金额 / TOKEN / 调用次数**三种读法，同一批数据切换
- **本次会话**：Harness 自己统计的当前会话用量，**不需要任何令牌**；与账户账单口径不同，单独成块
- **数据全部来自 DeepSeek 官方接口**：余额与模型列表走开放 API（API Key），
  累计金额与每日趋势走平台控制台自己的用量接口（控制台令牌）
- **本地不存数据**：没有状态文件、没有目录、没有用量日志；快照只在内存里按 TTL 缓存
- **零依赖**：宿主半侧只用 `node:` 内置模块，浏览器半侧只用宿主提供的 `react`
- **零令牌也有内容**：不配任何凭据时，用量概览仍会显示 Harness 自己统计的「本次会话」用量

---

## 1. 实现方案

### 为什么是三个数据源

官方 API 文档（[api-docs.deepseek.com/zh-cn/](https://api-docs.deepseek.com/zh-cn/)）里，
账户级接口只有两个：

| 接口 | 给出什么 |
|---|---|
| `GET /user/balance` | `is_available`、各币种的 `total_balance` / `granted_balance` / `topped_up_balance` |
| `GET /models` | 该 Key 可调用的模型 id 列表 |

**文档里没有任何用量、消费、趋势接口**——`/chat/completions` 只回报单次调用的 `usage`。
而「累计使用金额 / 累计使用 TOKEN / 每日金额·TOKEN·调用次数」只存在于平台控制台自己调用的
`platform.deepseek.com/api/v0/*`（`users/get_user_summary`、`usage/amount`、`usage/cost`），
它们用**控制台登录态令牌**鉴权，不是 API Key。

第三个数据源是**Harness 自己的计量**：`ctx.sessionProjections` 的 `tokenUsage` 投影
（由官方 `@deepseek-ai/dsh-token-meter` 注册），它对持久会话日志做折叠，得出**当前会话**被
供应商计入的 token。它**不需要凭据、不发网络请求**，但**口径与平台账单不同**——一个是「这次会话」，
一个是「这个账户」——所以界面上是两个块，绝不合成一个数字。

所以插件把三处都接上，并在界面上分开标注，绝不把一处包装成另一处：

```
API Key  ──► api.deepseek.com/user/balance      ─┐
API Key  ──► api.deepseek.com/models            ─┤
控制台令牌 ─► platform.deepseek.com/api/v0/…     ─┼─► 宿主快照（内存） ──► /api/apicost/* ──► 浏览器
llm/stream（只读模型名）                          ─┤
sessionProjections.tokenUsage（无凭据、本地）     ─┘
```

### 口径：三个账本各自独立，永不互加

| 账本 | 范围 | 来源 | 是否需要令牌 |
|---|---|---|---|
| `api` | 账户 | `api.deepseek.com` | 需要 API Key |
| `console` | 账户 | `platform.deepseek.com` | 需要控制台令牌 |
| `session` | **单个会话** | Harness 的 `tokenUsage` 投影 | **不需要** |

`session` 块的加法规矩（与官方消费方 `dsh-client-ui-chat` 的 `billedInputTokens` 一致）：

- 四个桶 **互不相交**：`reasoning` 已经算在 `outputTokens` 里，缓存读/写与未命中输入是三笔独立费用
- **计费输入** = `uncachedInputTokens + cacheReadTokens + cacheWriteTokens`
- **合计** = 计费输入 + `outputTokens`
- `tokenMeter` 另给的 `surfaceTokens` 只是**估算**，界面上一律带「约」字，绝不当作账单

### 分层

| 文件 | 职责 |
|---|---|
| `lib/index.js` | 宿主入口：控制器（取数、TTL、失败退避）、内存快照、SSE 扇出、路由注册；凭据服务按操作惰性读取（插件不声明服务依赖，apply 时它还没注册） |
| `lib/deepseek.js` | 开放 API 客户端：`/user/balance`、`/models`，错误码映射 |
| `lib/platform.js` | 控制台客户端 + 归一化：把 summary / amount / cost 折成按天、按模型的用量模型 |
| `lib/session-usage.js` | 会话级数据源：读 `sessionProjections` / `sessions` / `tokenMeter`，按官方口径折算成 `session` 块 |
| `lib/config.js` | 配置默认值与账号级 URL 解析 |
| `lib/routes.js` | `/api/apicost/*` 四个路由：快照、SSE、刷新、控制台令牌 |
| `lib/client.js` | 浏览器半侧：座位与用量概览（手写懒 CJS，无打包器） |

宿主不写磁盘：`state.js` / `pricing.js` / `balance.js` 已删除，包内不再有 `*state.json`。
`lib/session-usage.js` 同样只读内存：它消费的是 Harness 已经算好的投影，不自己记账。

### 令牌放哪

| 凭据 | 谁用 | 存放 |
|---|---|---|
| `DEEPSEEK_API_KEY` | 开放 API（余额、模型列表） | dsh 凭据库或进程环境 |
| `DEEPSEEK_PLATFORM_TOKEN` | 平台控制台（累计与趋势） | 同上；可在用量概览里粘贴一次，写入 dsh 凭据库 |

控制台令牌**只**经过宿主：不写插件文件、不进日志、不随快照发给浏览器；快照里只有
`configured / source / writable` 三个事实。粘贴时会先做形状校验（`sk-` 开头的 API Key 会被拒绝），
并自动剥离 Local Storage 常见的 JSON 信封（取 `.value` / `.token` / `.accessToken`），因此整段复制
`userToken` 的 Value 也能通过校验。

「本次会话」块不需要任何凭据，因此**两个令牌都不配时用量概览也不是空的**。

---

## 2. 安装

```powershell
# 绝对路径安装（开发模式，改完重启即生效）
dsh plugin --profile web add "D:\WorkFolder\Project\DeepseekHarnessPlugins\APICost"

# 或发布到 registry 后按包名安装
dsh plugin --profile web add dsh-plugin-apicost
```

`dsh plugin` 会用 pnpm 把包装进 `$DSH_HOME/profiles/web/node_modules`，并把本包声明为
profile 的 bundle（本包自带 `dsh.bundle.patch` → `cordis.patch.yml`）。

然后**重启 `dsh web`**（该进程持有界面与本插件的宿主半侧）：

```powershell
dsh web
```

### 验证安装

```powershell
# 1) 快照接口可用
Invoke-RestMethod http://127.0.0.1:3080/api/apicost/snapshot | ConvertTo-Json -Depth 4

# 2) 启动图里出现本插件
(Invoke-WebRequest http://127.0.0.1:3080/).Content -match 'dsh-plugin-apicost'

# 3) 浏览器半侧可下载（rev 从启动图里取）
(Invoke-WebRequest http://127.0.0.1:3080/plugins/dsh-plugin-apicost/client.js?rev=<rev>).StatusCode
```

侧边栏底部（设置齿轮上方）会出现 "API 用量" 一行；点击展开用量概览。

### 接上平台控制台

用量概览底部有「平台控制台」卡片：未连接时给出说明、一个密码输入框，以及（在能用的前提下）一个「一键读取」按钮。

**三条路径，按推荐顺序：**

| 方式 | 怎么做 | 什么时候用 |
|---|---|---|
| 一键读取 | 点卡片上的「一键读取」 | 用量概览页面本身就运行在 `platform.deepseek.com` 上（同源），插件能直接读到该站 Local Storage 里已登录的 `userToken` |
| 手动粘贴 | 复制 `userToken` 的值贴进输入框，点「保存并读取」 | 默认路径。插件跑在 dsh 的本地地址上，与平台**不同源**，浏览器禁止跨站读取 Local Storage，此时「一键读取」按钮会自动隐藏而不是给一个点了没反应的按钮 |
| 环境变量 | 设置 `DEEPSEEK_PLATFORM_TOKEN` | CI 或脚本化场景 |

手动粘贴的步骤：

1. 在已登录 `platform.deepseek.com` 的浏览器里打开开发者工具
2. `Application → Local Storage → https://platform.deepseek.com → userToken`，复制它的值
3. 贴进用量概览的输入框，点「保存并读取」

`userToken` 在 Local Storage 里是一个 JSON 信封（`{"value":"<令牌>","__version":"0"}`），
插件会自动解析并取出 `.value`，所以**直接整段复制即可**。

### 为什么令牌只值得读一次

实测（2026-09）这个控制台令牌是 **64 字符的不透明串**（48 字节随机数的 base64），**不是 JWT**：
没有 `.` 分段、没有 `exp` 声明、没有可解出的载荷。平台也**没有任何登录或刷新令牌的接口**
（`/api/v0/users/current`、`/auth/refresh` 等一律 404）。因此：

- 插件**无法自己登录**拿到令牌，也**无法续期**——它的唯一来源就是浏览器里已登录的会话；
- 好在它也**不会自己过期**，所以只需授权一次，之后长期复用，不存在定期重新粘贴的问题；
- 真正做到免复制的办法只有让页面与平台同源（见上表「一键读取」），或把它写进环境变量。

令牌写入 dsh 凭据库（`DEEPSEEK_PLATFORM_TOKEN`），随后累计金额、累计 TOKEN 与每日趋势立即出现。

平台用量接口（`/api/v0/*`）要求带浏览器请求头（`User-Agent`、`x-client-platform: web` 等），
否则会被拒绝；这些头由插件在宿主侧自动添加，浏览器侧与凭据库都不接触裸令牌。

---

## 3. 界面说明

### 座位

| 位置 | 内容 |
|---|---|
| 侧边栏底部 · 宽栏 | `API 用量` 标目 + 余额（主色等宽数字，带币种）+ 当前模型 + 本次会话 TOKEN + 状态点 |
| 侧边栏底部 · 76px 轨道 | 模型缩写 + 一位小数的余额 + 状态点 |
| 用量概览（`shell.overlay`） | 标题栏 → 三张指标卡（累计金额 / 累计 TOKEN / 总余额，总余额卡内含「去充值」）→ 每日趋势（胶囊切换 金额 / TOKEN / 调用 + 三格统计）→ 模型列表 → **本次会话** → 控制台连接（仅未连接或有错时出现） |

### 标题栏

连接状态与窗口级操作集中在标题栏右侧，不再散落在下方卡片里：

| 元素 | 内容 |
|---|---|
| `API` 胶囊 | 开放 API 凭据状态。已连接为绿点；未配置为灰点；有错且**没有可用余额**时为红点并显示错误码（错误但余额仍在 = 旧数据，保持绿点） |
| `控制台` 胶囊 | 平台控制台令牌的同一套三态判断 |
| `调用中` 胶囊 | 仅在 `live.streaming` 为真时出现 |
| `重新读取` | 强制整面板刷新（`POST /refresh`） |
| `断开` | 仅在控制台已连接时出现，清除令牌 |

**已连接的令牌不再另起卡片**：状态与两个按钮都在标题栏了，下方再复述一遍只是噪声。
`ConsoleCard` 在已连接且无错误时返回 `null`（不产生任何 DOM）；只有令牌**失效**时才保留一张卡片，
因为胶囊只放得下错误码，`EXPIRED`/`NO_TOKEN` 的中文提示需要有地方说清楚。

**避让关闭按钮**：`.apx-close` 是 `position:absolute;top:12px;right:12px` 的悬浮按钮，因此
标题栏用 `grid-template-columns:minmax(0,1fr) auto`（标题可收缩、操作组保持固有宽度），
并由 `.apx-mast-bar{padding-right:var(--apx-close-w)}` 预留一条 `38px` 车道；`.apx-mast` 自身
`min-height` 不小于按钮高度，纵向也不会压到。`--apx-close-w` 是具名令牌，改按钮尺寸只需改一处。
窄屏（≤760px）下标题栏改为单列、操作组左对齐并继续保留这条车道。

### 模型列表

区头带一个圆形刷新按钮，单独重取 `GET /models`：

- 走 `store.refreshModels()`，只置 `modelsPending`，**不**把整个面板标记为忙碌——两个刷新的
  代价与理由不同，混用一个 `pending` 会让「换个模型列表」显示成「整页在转」。
- 请求期间按钮禁用并让图标旋转，`aria-label` 换成「正在获取模型列表」，防止连点堆叠请求。
- 区头同时显示 `更新于 HH:MM`（取自 `api.updatedAt`）；没有时间戳时该格不渲染，
  但按钮仍靠 `margin-left:auto` 贴住右边缘。

### 本次会话块

位于「模型列表」之后、控制台连接卡片（若出现）之前，是**唯一不需要凭据就能有内容**的一块：

| 元素 | 内容 |
|---|---|
| 标题行 | `本次会话` + 会话 id；有多个活跃会话时追加「第 N 个会话」 |
| 三格 | 计费输入 / 输出 / 合计（等宽、`tabular-nums`） |
| 明细 | 未命中输入、缓存命中、缓存写入（为 0 时隐藏）、命中率（无计费输入时不显示，而非显示 0%） |
| 上下文 | `tokenMeter` 的 `surfaceTokens`，估算值时带「约」 |
| 脚注 | 一行口径说明：本块由 Harness 自行统计，与平台账单口径不同，两者不可相加 |

三种降级状态各有明确文案，都不显示 0：无活跃会话、会话尚无用量记录、投影值不完整。

### 设计：Apple 紧凑型金融界面

设计方向是 **Apple 紧凑型金融界面**：系统字体（`-apple-system`）+ 单一 Apple 蓝主色 `#0a84ff`，
毛玻璃弹层（`backdrop-filter: blur(30px) saturate(180%)`），大圆角卡片，发丝线分隔；
数字一律等宽并 `tabular-nums` 对齐，文案精简、间距收紧，不混用图表样式、不堆视觉噪点。

| 角色 | 取值 | 用在哪 |
|---|---|---|
| 纸面 | `#ffffff` / `#f5f5f7` | 面板与卡片底 |
| 墨色 | `#1d1d1f` / `#6e6e73` / `#8e8e93` | 正文、次级、标目 |
| 主色（Apple 蓝） | `#0a84ff`（暗色提亮为 `#5ac8fa`） | 金额、主行动、脉冲状态、选中态 |
| 发丝线 | `rgba(0,0,0,.08)` / `rgba(0,0,0,.10)`（暗色转白） | 卡片边 / 分隔 |
| 语义绿 | `#34c759` | 连接正常 |
| 语义红 | `#ff3b30` | 告警、登录态失效 |
| 毛玻璃 | `backdrop-filter: blur(30px) saturate(180%)` | 用量概览弹层 |
| 字体 | `-apple-system` 系统字体 + `ui-monospace` 等宽 | 标题用系统字体，金额与计数用等宽 |

- 金额单位跟随账户：账户报 CNY 就显示 ¥，只报 USD 就显示 $，**不做汇率换算**；
- 没有数据时显示 `—`，不显示 `¥0.00`；
- 暗色下同一套角色映射为墨底（`body[data-ds-dark-theme]`），主色提亮为蓝，其余一一对应；
- 动效遵循 Apple 规范：弹层 `translateY+scale` 毛玻璃升起、胶囊指示器滑动、柱图 `scaleY` 错峰生长、
  按钮 `:active scale(.96)`、状态点 `breathe`；`prefers-reduced-motion` 下全关，`(hover:hover) and (pointer:fine)` 门控 hover。

### 评审稿

[`preview/ui-preview.html`](preview/ui-preview.html)：dsh 设备框（侧栏座位 + 工作区）+ 用量概览弹层全貌，
右上角可切暗色、重放动效，趋势可真的在 金额 / TOKEN / 调用 三种读法间切换；
底部附 Before / After 动效审计表。结构自检：`node test-utils/check-preview.mjs`。

---

## 4. 配置

配置写在 profile 的 `cordis.patch.yml`（或本包 `cordis.patch.yml` 的 `config` 段），字段全部可选：

| 字段 | 默认 | 说明 |
|---|---|---|
| `apiKeyEnv` | `DEEPSEEK_API_KEY` | API Key 的凭据引用名 |
| `consoleTokenEnv` | `DEEPSEEK_PLATFORM_TOKEN` | 控制台令牌的凭据引用名 |
| `trackProviders` | `['deepseek-official']` | 跟随哪个 provider 的在途模型（只读模型名） |
| `trackAllProviders` | `false` | 是否跟随全部 provider |
| `api.enabled` | `true` | 是否读余额与模型列表 |
| `api.baseURL` | `$DEEPSEEK_BASE_URL` → `https://api.deepseek.com` | 开放 API 根地址 |
| `api.intervalMs` / `api.minRefreshMs` | `60000` / `5000` | 轮询间隔 / 手动刷新的最小间隔 |
| `api.timeoutMs` | `8000` | 单次请求超时 |
| `platform.enabled` | `true` | 是否读控制台用量 |
| `platform.baseURL` | `https://platform.deepseek.com` | 控制台根地址 |
| `platform.intervalMs` / `platform.minRefreshMs` | `300000` / `30000` | 用量轮询（用量变化慢，比余额稀） |
| `platform.timeoutMs` | `10000` | 单次请求超时 |
| `sessionId` | 未设 | 钉住「本次会话」报哪个会话；未设时取唯一活跃会话，多个时取日志最长的一个并在界面上写明共有几个 |
| `heartbeatMs` / `maxSseClients` | `15000` / `8` | SSE 心跳与并发上限 |
| `allowRemote` | `false` | 无 `connection` 服务时是否放行非 loopback 请求 |

---

## 5. 数据来源与隐私

| 界面上的数字 | 来源 |
|---|---|
| 总余额 / 充值余额 / 赠金 | `GET {api.baseURL}/user/balance` |
| 模型列表 | `GET {api.baseURL}/models`（区头按钮可单独重取） |
| 累计使用金额 | `GET {platform.baseURL}/api/v0/users/get_user_summary` → `total_costs[].amount` |
| 累计 TOKEN | `GET {platform.baseURL}/api/v0/usage/amount` → `total[].usage[]`（各模型生命周期汇总） |
| 本月消费 / 本月 TOKEN / 本月调用次数 | `GET {platform.baseURL}/api/v0/usage/amount` 与 `/usage/cost` → `days[]` |
| 每日趋势 | 同上 `days[]` 逐日折叠 |
| 本次会话：计费输入 / 输出 / 合计 / 缓存明细 | `ctx.sessionProjections.stateOf(session, 'tokenUsage')`（官方 `@deepseek-ai/dsh-token-meter` 的投影） |
| 本次会话：上下文占用 | `ctx.tokenMeter.measure(session).surfaceTokens`（估算值带「约」） |
| 当前模型 | 宿主 `llm/stream` 事件的 `model` 字段（仅读名字，不计数） |

### 控制台响应的真实形状（2026-09 实测）

三个接口都是**双层信封**，且业务数据可能再包一层数组或 JSON 字符串：

```jsonc
{ "code": 0, "msg": "",
  "data": { "biz_code": 0, "biz_msg": "",
            "biz_data": /* 真正的业务数据 */ } }
```

`normalizeUsage` 因此做了三件事，缺一不可：

1. **循环剥离信封**：`data` / `biz_data` 逐层下钻，`biz_data` 是 JSON 字符串时先 `JSON.parse`，
   是单元素数组时取首元素。
2. **区分两套序列**：`usage/*` 的 `biz_data` 同时带 `days[]`（当月逐日）与 `total[]`（各模型生命周期汇总）。
   **两者是不同口径，绝不能相加**——`total` 只用于「累计 TOKEN」，`days` 只用于「本月」与趋势。
   早期版本把 `days` 之和当作累计值，导致「累计」与「本月」显示同一个数，已修正。
3. **按 `type` 分类**：实测枚举为大写 `PROMPT_TOKEN` · `PROMPT_CACHE_HIT_TOKEN` ·
   `PROMPT_CACHE_MISS_TOKEN` · `RESPONSE_TOKEN` · `REQUEST`，`amount` 是字符串；
   另保留旧的扁平写法（`request_count` / `input_cache_hit_tokens` …）容错。

实测输出（对照平台用量页）：累计金额 ¥164.52、累计 TOKEN 1,571,821,418、
本月 TOKEN 1,571,815,444、本月消费 ¥65.84、本月调用 5,974、余额 ¥35.48。

- API Key 与控制台令牌**只在宿主进程内使用**，每次操作前重新解析；
- 快照与 SSE 里没有密钥，只有 `configured / source / writable`；
- 控制台令牌经校验后写入 dsh 凭据库；插件自己**不写任何文件**；
- 「本次会话」块**不读凭据、不发请求**：它只读 Harness 已在内存里的投影值；
- HTTP 路由默认仅接受 loopback 来源；若宿主提供 `connection` 服务，则复用它自己的
  `requestRejection` 鉴权结论。

---

## 6. 已知限制

- **控制台接口是平台自己的接口**：`platform.deepseek.com/api/v0/*` 不在官方 API 文档里，
  是控制台前端自己在用的接口，形状可能随平台更新变化。解析器按多套键名容错读取，
  读不到的字段显示 `—` 而不是 0；如果某天控制台改了形状，用量概览会退回「未连接」的状态而不是给错数字。
- **登录态可能失效**：控制台令牌是不透明串、没有 `exp` 声明，平台也不提供刷新接口，因此插件无法提前
  判断它何时失效。失效时用量接口会返回业务错误，卡片提示重新授权；重新粘贴或（同源时）一键读取即可。
- **无法自动获取令牌**：令牌只能来自已登录 `platform.deepseek.com` 的浏览器会话。跨站读取被
  同源策略禁止，所以「一键读取」只在同源时出现；否则只能粘贴一次或使用环境变量。
- **用量是账户级的**：控制台给的是整个账号的用量，不区分是不是 dsh 发起的调用；
  余额同理。「本次会话」块才是按会话的，但它与账户账单**口径不同、不可相加**。
- **「本次会话」依赖 Harness 的官方计量包**：没有挂载 `dsh-token-meter` 时该块显示
  「尚无用量记录」而不是报错；官方包的投影只覆盖它自己认识的供应商回报，
  某些路由（例如不回报 `usage` 的适配器）不会产生数字。
- **会话选择是启发式的**：多个会话同时活跃时，插件取持久日志最长的一个（`seq` 最大）
  并在界面上写明共有几个会话；需要确定性时用 `sessionId` 配置钉住。
- **币种不换算**：账户同时有人民币与美元时，界面固定显示人民币那一栏；只有美元时显示美元。
- **一次只读当月**：`usage/amount` 与 `usage/cost` 按月查询，趋势画的是当月（到当天为止）。
- **部分失败仍出数**：summary 与两个 series 接口各自独立读取，只有一个失败时另一半照常显示，并在面板上标出是哪个接口没读到（`PARTIAL`）。
- **累计 TOKEN 会排除两类桶**：`PROMPT_TOKEN` 是聚合项（已由 hit/miss 拆分），`REQUEST` 是调用次数而非 token；
  两者都不计入累计值，否则会把一次 prompt 算两遍、或把调用数当 token 加进去。
- **`total` 下的平铺行只当日线**：老控制台把扁平日行挂在 `total` 下，这类行只进日窗口，不会同时变成累计 roll-up。
- **调用次数行不生成模型条目**：`usage/cost` 里的 `REQUEST`/`CALL` 行是调用计数、没有金额，读取时先跳过再落模型，
  因此不会凭空多出一个 0 token、0 费用的「幽灵模型」。
- **浏览器半边不写 console**：宿主日志走 `ctx.logger`，浏览器半边同样不向宿主页面控制台输出；
  监听器抛错经 `onListenerError` 回调上报，未提供回调时静默丢弃。
- **SSE 重连有上限**：`EventSource` 自带的重连是无上限的，而它看不到 HTTP 状态码——服务端并发上限
  打满时返回 `503`，浏览器只会当成「流结束」并立刻重试。因此重连由插件自己接管（出错即 `close()`，
  最多重开 3 次），用尽后彻底放弃实时流、只靠轮询保活；连接真正打开过则重置额度。
- **退订即释放**：订阅是 store 唯一的生命周期钩子。最后一个监听器退订时（`useSyncExternalStore`
  在挂载点卸载时会这样做）会清掉轮询定时器并关闭 SSE；`stop()` 后到达的响应不再重开轮询或数据流，
  否则一个已被卸载的面板会继续拉取，并一直占着服务端有限的 SSE 槽位。
- **Windows 折叠标题栏**：dsh 自身在 `[data-windows-titlebar]` + 折叠态会隐藏侧边栏底部区（上游行为）。

---

## 7. 开发

```powershell
node --test test/*.test.mjs   # 90 项测试
node --check lib/index.js; node --check lib/client.js; node --check lib/session-usage.js
node test-utils/check-preview.mjs                   # 评审稿结构自检
```

- `lib/index.js` 宿主入口（`name` / `inject` / `apply`）
- `lib/deepseek.js` 开放 API 客户端（余额、模型列表）
- `lib/platform.js` 控制台客户端与用量归一化
- `lib/config.js` 配置解析
- `lib/routes.js` HTTP 路由、SSE、鉴权包装
- `lib/client.js` 手写懒 CJS 浏览器 bundle
- `test-utils/harness.mjs` 测试替身（不参与测试发现）
