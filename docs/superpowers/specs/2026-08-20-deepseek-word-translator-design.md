# DeepSeek 单词翻译 Chrome 插件 — 设计文档

- 日期：2026-08-20
- 状态：已获用户批准（方案 A + 全部设计章节）
- 目标：双击网页英文单词，在词旁弹出小卡片，显示音标与 1~3 条中文释义（含词性），由 DeepSeek API 提供释义内容。

## 1. 需求（已确认的决策）

| 决策点 | 结论 |
|---|---|
| 翻译方向 | 仅英译中 |
| 触发方式 | 双击单词（dblclick）；拖动选择不触发 |
| API Key 配置 | 点工具栏图标，在 popup 面板输入并保存 |
| 释义详细度 | 简洁模式：音标 + 1~3 条常用中文释义（含词性），无例句 |
| API | DeepSeek 官方 Chat Completions，模型 `deepseek-chat` |

## 2. 架构

采用方案 A：后台 Service Worker 代理。Manifest V3。

```
┌─────────────┐   dblclick+取词    ┌──────────────┐   缓存命中/未命中   ┌────────────────┐
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

- `manifest.json`：MV3；权限最小化——`storage`，`host_permissions` 仅 `https://api.deepseek.com/*`；content script 匹配 `http://*/*` 与 `https://*/*`（`chrome://`、扩展商店等页面由 Chrome 自动排除）。
- `popup.html` / `popup.js`：输入 API Key，保存到 `chrome.storage.local`；显示保存状态。
- `content.js`：监听 `dblclick` → 取词校验 → 发消息给后台 → 渲染/关闭弹窗。
- `background.js`：接收取词请求；查缓存；调用 DeepSeek；解析结果；维护缓存。

### 单元边界

| 单元 | 职责 | 接口 | 依赖 |
|---|---|---|---|
| content.js | 事件捕获、取词、弹窗渲染 | `chrome.runtime.sendMessage({type:'lookup', word})` | 无外部库 |
| background.js | 缓存、API 调用、JSON 解析 | 响应 `{ok, data | error}` | chrome.storage、fetch |
| popup.js | Key 的输入与保存 | `chrome.storage.local` | 无 |

任何单元可在不了解其他单元内部实现的情况下被替换。

## 3. 数据流

1. 用户双击页面上的英文单词。
2. content script 用 `document.caretRangeFromPoint`（或 `selection`）取词，正则 `^[A-Za-z][A-Za-z'-]*$` 校验；非单词或超长（>50 字符）则忽略。
3. `sendMessage({type:'lookup', word})` → background。
4. background 先查缓存（内存 Map，上限 500 条 LRU；同时持久化到 `chrome.storage.local`，插件重启后仍有效）。
5. 未命中 → 调 `POST https://api.deepseek.com/chat/completions`，`Authorization: Bearer <key>`。
6. 解析响应 → `{ok:true, data:{word, phonetic, definitions:[{pos, meaning}]}}` → content。
7. content 在单词位置旁渲染弹窗（`position: absolute`，按视口边界自动翻转）。
8. Esc / 点击弹窗外部 / 开始新的双击 → 关闭旧弹窗。

## 4. 提示词设计

- system：`你是英汉词典。仅输出 JSON，不输出任何其他文字、解释或 markdown 代码块。`
- user：`给出单词 "<word>" 的音标和 1~3 条最常用中文释义。严格按此格式输出：{"phonetic":"<IPA音标>","definitions":[{"pos":"<词性缩写，如 n./v./adj./adv.>","meaning":"<中文释义>"}]}`
- 请求参数：`response_format` 不强制（DeepSeek 不保证 JSON 模式）；解析失败时剥离 markdown 代码围栏后重试一次 JSON.parse，再失败返回错误提示。
- 温度 0.3，`max_tokens` 200，保持低成本低延迟。

## 5. 弹窗 UI

- 小卡片：单词（加粗）+ 音标（斜体）+ 逐条「词性 + 中文释义」。
- 暗色简洁样式，圆角，阴影；随页面明暗主题（`prefers-color-scheme`）切换配色。
- 渲染用 `textContent`/`innerText`，绝不 `innerHTML`，防 XSS。
- 单实例：同一时刻最多一个弹窗。

## 6. 错误处理

| 情形 | 行为 |
|---|---|
| 未配置 Key | 弹窗提示「请点击浏览器工具栏插件图标，填入 DeepSeek API Key」 |
| 401 | 提示 Key 无效或过期 |
| 429 / 5xx | 提示「服务暂时不可用，请稍后再试」；不自动重试轰炸 |
| 网络失败 | 提示「网络请求失败」，原词保留在弹窗中 |
| 非英文单词 | 不弹窗，静默忽略 |
| 解析失败 | 提示「释义解析失败」，不崩溃 |

## 7. 缓存策略

- 内存 Map + `chrome.storage.local` 持久化，容量 500 条，LRU 淘汰。
- 重复双击同一单词不产生 API 费用。

## 8. 安全

- API Key 仅存 `chrome.storage.local`，由 popup 写入、仅 background 读取；不写进代码、不打日志。
- 网页无法读取扩展存储；content script 与页面隔离运行。
- 网络权限仅限 `api.deepseek.com`。

## 9. 验证方式

1. 安装依赖：无（零外部依赖，纯原生 JS）。
2. `chrome://extensions` 开发者模式加载 `deepseek-word-translator/`（已解压）。
3. 用自动化浏览器驱动 Chrome 加载该扩展：打开含英文段落的测试页，双击单词，截图验证音标与释义正确显示。
4. 错误路径：未配 Key、错误 Key、断网（拦截请求）各验证一次提示文案。
5. 缓存验证：同一单词二次双击不再发出网络请求。

## 10. 明确不做（YAGNI）

- 不做中译英、多语种、词组/句子翻译、例句模式。
- 不做发音朗读、生词本、设置页、用量统计、每日额度限制。
- 不做发布到商店（本地「加载已解压的扩展程序」使用即可）。

## 11. 修订记录（2026-08-20，用户批准）

1. **滚动 bug 修复**：根因——弹窗 host 用 `position: absolute`（文档坐标）却按视口坐标定位，页面滚动后弹窗落在「视口位置 − 滚动量」的文档坐标处，滚出屏幕不可见。修复——改用 `position: fixed`（视口锚定）；滚动时弹窗跟随锚点单词（`anchorRange.getBoundingClientRect()` 重定位），单词滚出视口才隐藏；scroll 事件可能携带来不及结算的中间位置，故在双 rAF 后用最终位置复查一次。
2. **语境义功能**：双击时提取所在文本块、单词前后各约 180 字符作为语境随消息发送；提示词要求额外输出 `contextMeaning`（该词在此语境的一句话中文含义）；弹窗底部新增「语境义」行；缓存键 = 单词 + 语境 FNV-1a 哈希（不同语境不共享缓存，无语境退化为纯单词键）。
3. **字体优化**：`.phonetic` 移除 `font-style: italic`，音标与释义一律标准正体。
4. 数据形状变更：`data` 增加 `contextMeaning: string|null`（向后兼容旧缓存条目）；消息协议增加可选 `context` 字段。
5. **快速记忆行**：提示词 JSON 增加可选字段 `memoryTip`（一句话快速记忆该单词的方法，中文，如词根拆解/谐音/场景联想）；解析规则与 `contextMeaning` 一致（缺失/空白/非字符串 → `null`）；弹窗在「语境义」行下方（无语境时在释义列表下方）新增「记忆」行，字段为 `null` 时不渲染该行；缓存键不变，旧缓存条目无该字段即隐藏此行，无需迁移。
