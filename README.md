# DeepSeek 单词翻译

一个 Chrome MV3 扩展：把鼠标停在网页上的英文单词上 500ms，词旁弹出卡片显示音标、释义、语境义和词根词缀拆分；也可以在插件面板里一键把整个网页意译为中文。所有释义与译文由 DeepSeek `deepseek-chat` 生成。

- 零依赖、无构建步骤，全部是原生 JS
- 除了 `api.deepseek.com` 没有任何网络权限，API Key 只存在浏览器本地
- 悬停取词与整页翻译都覆盖内嵌框架（含跨源 iframe）和 Web Components 开放影子根里的文字

## 功能

### 悬停查词

鼠标在英文单词上停留 500ms 触发；指针移开、滚动、按 Esc 或点击别处即自动关闭。卡片包含四个维度：

| 维度 | 内容 |
|---|---|
| 音标 | IPA 音标 |
| 释义 | 1~3 条最常用中文释义，标注词性 |
| 语境义 | 结合该词所在的句子，给出它在此处的准确中文含义 |
| 词根词缀 | 拆解构词并标注各部分含义，例如 `im-（否定前缀）+ mort（词根：死亡）+ -al（形容词后缀）`；无法拆分的基础词会说明来源 |

查询结果按「单词 + 语境哈希」缓存（LRU 容量 500，持久化在浏览器本地），同一个词重复悬停不会重复调用 API。

### 整页意译

点插件面板里的「翻译当前网页」，把当前页面可见的英文意译为自然中文并**原位替换**，保留原有 DOM 与样式，刷新页面即恢复原文。

- 右下角状态条显示进度，逐批完成后即时回填
- 覆盖页面内所有框架（含跨源 iframe）与开放影子根
- 自动跳过代码块、输入框、隐藏内容、可编辑区域和已含中文的节点
- 某一批失败时保留已完成的译文并显示原因，不回滚

## 安装

1. 下载或克隆本仓库
2. 打开 `chrome://extensions`，开启右上角「开发者模式」
3. 点「加载已解压的扩展程序」，选择仓库根目录
4. 点工具栏上的扩展图标，填入 DeepSeek API Key 并保存

API Key 在 [DeepSeek 开放平台](https://platform.deepseek.com/api_keys) 申请，按量计费。

在开放影子根内取词依赖 `caretPositionFromPoint`，该 API 自 Chrome 128 起提供；更低版本的 Chrome 在普通网页上仍可正常使用。

## 隐私

- API Key 由插件面板写入 `chrome.storage.local`，只被 Service Worker 读取，不写进代码、不打日志
- 除 `https://api.deepseek.com/*` 外没有任何网络权限
- 查词会把单词和最多 400 字符的上下文发给 DeepSeek；整页翻译会把采集到的可见英文文本发给 DeepSeek。除此之外不发送任何内容
- 显示在页面上的内容一律通过 `textContent` 写入，不使用 `innerHTML`，避免页面文本被当作 HTML 执行

## 项目结构

| 路径 | 说明 |
|---|---|
| `manifest.json` | MV3 清单：仅申请 `storage` 权限，content script 注入所有框架 |
| `content.js` | 内容脚本：悬停取词、Shadow DOM 弹窗、整页文本采集与回填 |
| `background.js` | Service Worker：缓存、DeepSeek 请求代理、整页翻译批次 |
| `popup.html` / `popup.js` | 插件面板：API Key 管理、翻译当前网页 |
| `lib/` | 与浏览器环境解耦的纯逻辑，可在 Node 下测试：取词校验、LRU 缓存、查词提示词与解析、整页翻译分批、影子根穿透 |
| `tests/` | `node:test` 单元测试，一个模块一个文件 |
| `e2e/` | 手动端到端测试：静态服务器、夹具页、证据截图 |
| `docs/superpowers/` | 中文设计文档与实施计划，是决策的权威记录 |

## 开发与测试

没有构建步骤，改完代码在 `chrome://extensions` 点一下「重新加载」即可生效。

运行单元测试：

```bash
node --test
```

语法检查：

```bash
node --check content.js
```

端到端手动测试：

```bash
node e2e/serve.js
```

然后加载扩展并打开 `http://127.0.0.1:8123/test-page.html`。夹具页包含同源与跨源 iframe、开放与关闭的影子根组件、代码块和输入框，用来验证应该翻译的内容确实被翻译了、不该动的部分保持原样。

更多架构约定和代码风格见 [AGENTS.md](AGENTS.md)；改动行为之前请先读 [docs/superpowers/specs/](docs/superpowers/specs/) 里的设计文档与修订记录。

## 明确不做

- 关闭影子根（`mode: "closed"`）里的文字——需要注入页面主世界包装 `attachShadow` 才能拿到根引用，代价高于收益
- 图片、Canvas 里的文字（需要 OCR）
- CSS 伪元素生成的内容、Chrome 内置 PDF 阅读器里的文字
- 中译英、多语言、双语对照、发音朗读、生词本

## 许可

本项目以 [MIT 许可证](LICENSE) 发布：可以自由使用、修改、再分发，包括商用，只需保留版权声明与许可证文本。
