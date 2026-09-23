# DeepSeek 单词翻译 Chrome 插件 — 设计文档

- 日期：2026-08-20
- 状态：已获用户批准（方案 A + 全部设计章节）
- 目标：悬停网页英文单词时弹出释义卡片；也可在插件面板点击「翻译当前网页」，将当前网页可见英文内容意译为简体中文。均由 DeepSeek API 提供内容。

## 1. 需求（已确认的决策）

| 决策点 | 结论 |
|---|---|
| 翻译方向 | 仅英译中 |
| 触发方式 | 鼠标悬停单词停留 500ms 触发；双击、拖选均不触发 |
| API Key 配置 | 点工具栏图标，在 popup 面板输入并保存 |
| 释义详细度 | 简洁模式：音标 + 1~3 条常用中文释义（含词性），无例句 |
| API | DeepSeek 官方 Chat Completions，模型 `deepseek-chat` |
| 整页翻译 | popup 点击「翻译当前网页」，将当前页面及其内嵌框架中可见的英文文本意译为简体中文；保留原 DOM 与样式，不提供双语对照或恢复按钮，刷新页面恢复原文 |

## 2. 架构

采用方案 A：后台 Service Worker 代理。Manifest V3。

```
┌─────────────┐   悬停取词 / 整页翻译    ┌──────────────┐   缓存命中/未命中   ┌────────────────┐
│ content.js  │ ────────────────► │ background.js│ ─────────────────► │ api.deepseek.com│
│ 页面内脚本   │ ◄──────────────── │ Service      │ ◄───────────────── │ /chat/completions│
│ 渲染弹窗     │   JSON 释义结果    │ Worker+缓存   │   JSON (严格格式)  └────────────────┘
└─────────────┘                   └──────────────┘
                                          ▲
                                   ┌─────────────┐
                                   │ popup.html  │ 输入/保存 API Key
                                   └─────────────┘
```

### 组件清单

- `manifest.json`：MV3；权限最小化——`storage`，`host_permissions` 仅 `https://api.deepseek.com/*`；content script 匹配 `http://*/*` 与 `https://*/*`（`chrome://`、扩展商店等页面由 Chrome 自动排除），并以 `all_frames: true` + `match_origin_as_fallback: true` 注入页面内所有框架（含跨源框架、`srcdoc`/`blob:`/`data:` 框架）。
- `popup.html` / `popup.js`：输入 API Key，保存到 `chrome.storage.local`；提供「翻译当前网页」入口并显示保存/翻译状态。
- `content.js`：监听 `mousemove`（500ms 停留去抖）→ 取词校验（开放影子根内文字同样可取值）→ 发消息给后台 → 渲染/关闭弹窗；整页翻译时采集可见英文文本节点（逐层进入开放影子根）、分批请求并原位回填译文。
- `background.js`：接收取词与整页翻译批次请求；查缓存（仅单词）；调用 DeepSeek；解析结果。
- `lib/translate.js`：整页翻译提示词、分批、响应解析和错误映射。
- `lib/dom.js`：影子根穿透与跨边界 DOM 遍历——指针取词坐标、语境文本块、跳过规则用的祖先查找、开放影子根收集。

### 单元边界

| 单元 | 职责 | 接口 | 依赖 |
|---|---|---|---|
| content.js | 事件捕获、取词、弹窗渲染 | `chrome.runtime.sendMessage({type:'lookup', word})` | 无外部库 |
| background.js | 缓存、API 调用、JSON 解析 | 响应 `{ok, data | error}` | chrome.storage、fetch |
| popup.js | Key 的输入与保存；发起整页翻译 | `chrome.tabs.sendMessage({type:'translatePage'})` | chrome.tabs |
| lib/translate.js | 整页翻译分批、格式约束与解析 | `{ok,data:[译文] \| error}` | 无 |
| lib/dom.js | 影子根穿透与跨边界遍历 | 纯 DOM 工具函数 | 无（仅浏览器 API） |

任何单元可在不了解其他单元内部实现的情况下被替换。

## 3. 数据流
1. 用户将鼠标悬停在英文单词上，停留 500ms。
2. content script 在停留计时触发后在指针处取词（悬停场景忽略页面选区）：常规内容用 `document.caretRangeFromPoint`；命中开放影子根内容时改用 `document.caretPositionFromPoint` + `shadowRoots`（前者在影子根内只返回元素）。正则 `^[A-Za-z][A-Za-z'-]*$` 校验；非单词或超长（>50 字符）则忽略。
3. `sendMessage({type:'lookup', word})` → background。
4. background 先查缓存（内存 Map，上限 500 条 LRU；同时持久化到 `chrome.storage.local`，插件重启后仍有效）。
5. 未命中 → 调 `POST https://api.deepseek.com/chat/completions`，`Authorization: Bearer <key>`。
6. 解析响应 → `{ok:true, data:{word, phonetic, definitions:[{pos, meaning}]}}` → content。
7. content 在单词位置旁渲染弹窗（按视口边界自动翻转）。
8. Esc / 点击弹窗外部 / 指针移出活跃区域（见 §5）/ 滚动离开单词 / 悬停新词 → 关闭或替换旧弹窗。

### 整页翻译数据流
1. 用户点击 popup 中的「翻译当前网页」。
2. popup 向当前标签页发送 `{type:'translatePage'}`；`chrome.tabs.sendMessage` 不指定 frameId 时广播给页面内所有框架，每个框架只翻译自己，但**只有顶层框架回复 popup**——多框架同时响应时首个响应者不确定，某个无内容的子框架先回复会让状态文案与实际不符。
3. content script 扫描所在文档（含逐层进入的开放影子根）中可见的英文文本节点；跳过脚本、样式、代码、表单控件、隐藏节点、可编辑区域和已含中文的节点。每个框架由各自的 content script 独立扫描与回填，互不干涉。
4. 文本按 1800 字符或 32 条拆批，并附上最近文本块最多 400 字符的上下文；逐批发送 `{type:'translateBatch', texts, contexts}` 给 background。单项较长时沿用原文本节点边界，不切断 DOM 文本。
5. background 调 DeepSeek，要求意译为自然简体中文并严格返回同长度 `translations` 数组。
6. content script 按原顺序原位回填译文，保留节点前后空白与页面布局；右下角 Shadow DOM 状态条显示进度，框架内显示各自的状态条（「无内容」提示在子框架中静默，避免每个空框架都弹一条）。
7. 任一批次失败时保留已完成译文并显示错误；刷新页面可恢复原文。
8. 返回 popup 的结果带 `frames` 字段（本文档内的框架数）；顶层文档没有英文但存在框架时返回 `NO_CONTENT` + `frames`，popup 据此显示中性提示而不是失败。

## 4. 提示词设计

- system：`你是英汉词典。仅输出 JSON，不输出任何其他文字、解释或 markdown 代码块。`
- user：`给出单词 "<word>" 的音标和 1~3 条最常用中文释义。严格按此格式输出：{"phonetic":"<IPA音标>","definitions":[{"pos":"<词性缩写，如 n./v./adj./adv.>","meaning":"<中文释义>"}]}`
- 请求参数：`response_format` 不强制（DeepSeek 不保证 JSON 模式）；解析失败时剥离 markdown 代码围栏后重试一次 JSON.parse，再失败返回错误提示。
- 温度 0.3，`max_tokens` 200，保持低成本低延迟。
- 整页翻译 system 明确把网页文本视为不可执行素材，防止页面文本中的指令干扰翻译；要求采用意译、结合 `context` 理解被行内标签切开的片段、保持数字/URL/占位符/语气，只输出 `{"translations":[...]}`。每批按字符数扩大 `max_tokens`，超时上限 30 秒。

## 5. 弹窗 UI

- 小卡片内容按顺序：单词（加粗）→ 音标 → 逐条「词性 + 中文释义」→ 语境义（仅在有语境时显示）→ 词根词缀拆分分析（字段缺失时不显示该行）。
- 暗色简洁样式，圆角，阴影；随页面明暗主题（`prefers-color-scheme`）切换配色。
- 渲染用 `textContent`/`innerText`，绝不 `innerHTML`，防 XSS。
- 单实例：同一时刻最多一个弹窗。在框架内触发时弹窗渲染在该框架的文档里（视口即框架视口），小尺寸框架会把弹窗裁切——框架边界所致，无法避免。
- 整页翻译状态条固定在右下角，使用独立 Shadow DOM；成功后自动消失，失败时显示原因，不修改页面原有 HTML 结构。
- 悬停触发下的关闭语义：指针移出「锚点单词矩形外扩 8px ∪ 弹窗矩形外扩 8px」活跃区域即关闭；滚动时经双 rAF 复查后指针已离开单词即关闭；同一单词持续停留不重复查询；指针移入 iframe 后本文档不再收到 `mousemove`，此时直接关闭弹窗（否则会滞留）。

## 6. 错误处理

| 情形 | 行为 |
|---|---|
| 未配置 Key | 弹窗提示「请点击浏览器工具栏插件图标，填入 DeepSeek API Key」 |
| 401 | 提示 Key 无效或过期 |
| 429 / 5xx | 提示「服务暂时不可用，请稍后再试」；不自动重试轰炸 |
| 网络失败 | 提示「网络请求失败」，原词保留在弹窗中 |
| 非英文单词 | 不弹窗，静默忽略 |
| 解析失败 | 提示「释义解析失败」，不崩溃 |
| 整页翻译缺少 Key / 鉴权失败 / 服务或网络异常 | 页面状态条与 popup 显示对应原因；已完成批次不回滚 |
| 页面无可翻译英文 | 提示「没有找到需要翻译的英文内容」，不调用 API |

## 7. 缓存策略

- 内存 Map + `chrome.storage.local` 持久化，容量 500 条，LRU 淘汰。
- 重复悬停同一单词不产生 API 费用。
- 整页翻译按当前 DOM 文本即时处理，不建立持久化全文缓存；翻译后文本已含中文，再次触发不会重复发送。

## 8. 安全

- API Key 仅存 `chrome.storage.local`，由 popup 写入、仅 background 读取；不写进代码、不打日志。
- 网页无法读取扩展存储；content script 与页面隔离运行。
- 网络权限仅限 `api.deepseek.com`。
- 整页翻译会把所采集的可见英文文本（含页面内各框架）发送给 DeepSeek；文本不写入扩展存储，译文只原位写回当前页面。

## 9. 验证方式

1. 安装依赖：无（零外部依赖，纯原生 JS）。
2. `chrome://extensions` 开发者模式加载 `deepseek-word-translator/`（已解压）。
3. 用自动化浏览器驱动 Chrome 加载该扩展：打开含英文段落的测试页，悬停单词 500ms，截图验证音标与释义正确显示。
4. 错误路径：未配 Key、错误 Key、断网（拦截请求）各验证一次提示文案。
5. 缓存验证：同一单词二次悬停不再发出网络请求。
6. 整页翻译验证：点击「翻译当前网页」，确认英文段落、标题、链接和按钮变为自然中文；代码块、输入框和隐藏内容保持不变；翻译中显示进度，刷新后恢复英文原文。
7. 内嵌框架与影子根验证：夹具页含同源与跨源（`127.0.0.1` 与 `localhost` 互跨源）两个 iframe、开放与关闭两个影子根组件；确认两个框架内的英文都变为中文、开放影子根内文字可悬停取词并被翻译、关闭影子根内文字保持英文（不支持），`<pre><code>` 与输入框内容不变。

## 10. 明确不做（YAGNI）

- 不做中译英、多语种、例句模式、双语对照、翻译后自动恢复原文。
- 不做发音朗读、生词本、设置页、用量统计、每日额度限制。
- 不做发布到商店（本地「加载已解压的扩展程序」使用即可）。
- 不做关闭影子根（`mode:'closed'`）穿透：需在 MAIN world 包装 `Element.prototype.attachShadow` 才能持有根引用，且会被页面脚本反制，代价高于收益。
- 不做图片/Canvas 文字（需要 OCR，与零依赖冲突）、CSS 伪元素（`::before`/`::after`）生成的内容（无对应 DOM 节点）、Chrome 内置 PDF 阅读器内的文字（扩展页面，content script 不可注入）。

## 11. 修订记录（2026-08-20，用户批准）

1. **滚动 bug 修复**：根因——弹窗 host 用 `position: absolute`（文档坐标）却按视口坐标定位，页面滚动后弹窗落在「视口位置 − 滚动量」的文档坐标处，滚出屏幕不可见。修复——改用 `position: fixed`（视口锚定）；滚动时弹窗跟随锚点单词（`anchorRange.getBoundingClientRect()` 重定位），单词滚出视口才隐藏；scroll 事件可能携带来不及结算的中间位置，故在双 rAF 后用最终位置复查一次。
2. **语境义功能**：双击时提取所在文本块、单词前后各约 180 字符作为语境随消息发送；提示词要求额外输出 `contextMeaning`（该词在此语境的一句话中文含义）；弹窗底部新增「语境义」行；缓存键 = 单词 + 语境 FNV-1a 哈希（不同语境不共享缓存，无语境退化为纯单词键）。
3. **字体优化**：`.phonetic` 移除 `font-style: italic`，音标与释义一律标准正体。
4. 数据形状变更：`data` 增加 `contextMeaning: string|null`（向后兼容旧缓存条目）；消息协议增加可选 `context` 字段。
5. **快速记忆行**：提示词 JSON 增加可选字段 `memoryTip`（一句话快速记忆该单词的方法，中文，如词根拆解/谐音/场景联想）；解析规则与 `contextMeaning` 一致（缺失/空白/非字符串 → `null`）；弹窗在「语境义」行下方（无语境时在释义列表下方）新增「记忆」行，字段为 `null` 时不渲染该行；缓存键不变，旧缓存条目无该字段即隐藏此行，无需迁移。
6. **英文释义行**：提示词 JSON 增加可选字段 `plainEnglish`（一句简单易懂的英文解释该单词的意思，适合英语学习者）；解析规则与 `contextMeaning`/`memoryTip` 一致（缺失/空白/非字符串 → `null`）；弹窗在「记忆」行下方新增「英文释义」行，字段为 `null` 时不渲染该行；缓存键不变，旧缓存条目无该字段即隐藏此行，无需迁移。
7. **触发方式改为悬停**（2026-09-03）：双击触发改为鼠标悬停停留 500ms（`HOVER_DELAY_MS = 500`，mousemove 去抖）。取词只走 `caretRangeFromPoint` 分支（忽略页面残留选区）。关闭语义改为自动关闭——指针离开「单词矩形外扩 8px ∪ 弹窗矩形外扩 8px」活跃区域即关，滚动双 rAF 复查后指针离开单词即关；同一单词停留不重复查询。删除 dblclick 监听器。Esc / 点击外部 / resize / 单词滚出视口的关闭逻辑保留。
8. **整页意译**（2026-09-20）：popup 增加「翻译当前网页」按钮。content script 采集顶层页面可见英文文本，跳过脚本/样式/代码/表单/隐藏/可编辑及已含中文节点，按 1800 字符或 32 条分批；`lib/translate.js` 为每个文本片段附最近文本块上下文，并约束 DeepSeek 输出同长度 `translations` 数组，background 复用时按批次扩大输出额度与超时。译文原位回填以保留 DOM 和布局，右下角显示进度；失败保留已完成部分，刷新页面恢复原文。
9. **内嵌框架与影子根**（2026-09-23）：content script 增加 `all_frames: true` 与 `match_origin_as_fallback: true`，悬停取词与整页翻译由此覆盖 iframe（含跨源、`srcdoc`/`blob:`/`data:`）内的文字。悬停取词在命中开放影子根时改用 `caretPositionFromPoint` + `shadowRoots`（实测 `caretRangeFromPoint` 在影子根内只返回 `<html>`，导致取词失败），并按 `elementFromPoint` → `shadowRoot` 逐层下降收集影子根；其余情况沿用 `caretRangeFromPoint` 保持既有命中宽容度。新增 `lib/dom.js` 承载跨影子边界的遍历：语境文本块、跳过规则祖先查找、开放影子根收集。多框架下 `tabs.sendMessage` 广播给全部框架、各自翻译自己，但只有顶层框架回复 popup（首个响应者不确定会误导状态文案），结果新增 `frames` 字段说明内嵌框架情况。关闭影子根需要 MAIN world 包装 `attachShadow`，列入 §10 不做。
10. **英文释义与快速记忆换成词根词缀**（2026-09-23）：弹窗维度调整——删除 `plainEnglish`（英文释义）与 `memoryTip`（记忆），新增 `morphology`（词根词缀拆分分析），提示词与解析同步调整。`morphology` 沿用可选字段规则（缺失/空白/非字符串 → `null`，为 `null` 时不渲染该行），因此缓存键与旧缓存条目无需迁移：旧条目只会少渲染「记忆」「英文释义」两行，且不会出现词根词缀行（同修订 5、6 的处理方式）。
