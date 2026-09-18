# dsh-codex-oauth

在 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 中使用你的 **OpenAI Codex 订阅**（ChatGPT Plus/Pro）——通过 OAuth 登录，与官方 Codex CLI 及其他 harness 的方式一致。

上游 harness 的多供应商适配器刻意不提供 `openai-codex`：Codex 走 ChatGPT OAuth 认证，而该适配器没有凭据存储、也没有登录流程（见其 README 的 Known Limitations）。本社区插件以可安装 bundle 的形式补上这两块：文件型 OAuth 凭据存储、`/codex login` 人类命令，以及注册在公开 LLM 缝上的 `codex` 供应商路由。

- 基于已发布的缝包（`@deepseek-ai/dsh-llm`、`@deepseek-ai/cordis`）构建——无 fork、无核心改动。
- Codex 的 OAuth 流程（浏览器登录 + 本地回调、无头设备的 device-code 登录、凭据锁下的自动刷新）全部由 pi-ai 的官方 provider 实现负责。
- 令牌保存在 `$DSH_HOME/codex-oauth.json`（`0600`、目录 `0700`），CLI 与 harness 插件读取同一份文件。

## 要求

- 一个 ChatGPT **Plus 或 Pro** 订阅。（OpenAI 平台 API key 不行——订阅额度绑定的是 ChatGPT 账号，不是 API key。）
- 已安装 DeepSeek Harness（`npx @deepseek-ai/dsh web` 或源码运行）。

## 安装

一条命令把 bundle 装进 `web` profile（自动写入一次性的 pnpm 构建授权，并替你执行 `dsh plugin add`）：

```sh
npx --yes https://github.com/birat-chapagain/dsh-codex-oauth/releases/download/v0.1.6/dsh-codex-oauth.tgz install
```

然后重启 `dsh web`，运行一次 `/codex login`。

等价的手动方式（都使用预构建产物，无需构建授权）：

```sh
dsh plugin --profile web add https://github.com/birat-chapagain/dsh-codex-oauth/releases/download/v0.1.6/dsh-codex-oauth.tgz
# 或从 git 安装（建议锁 commit：github:…/…#<sha>）：
dsh plugin --profile web add github:birat-chapagain/dsh-codex-oauth
```

pnpm 11.22+ 会因为任一传递依赖有未批准的构建脚本而报错——pi-ai 的依赖树里有 `@google/genai` 与 `protobufjs` 两个（Codex 路径均不使用）。一键安装器只批准这两个包，并修复它们的 `set this to true or false` 占位符；其他 `allowBuilds` 值会原样保留，包括显式拒绝。手动安装若以 `ERR_PNPM_IGNORED_BUILDS` 结束，把这段一次性写进 profile 的 `pnpm-workspace.yaml` 再重跑：

```yaml
allowBuilds:
  '@google/genai': true
  protobufjs: true
```

（若 pnpm 报错里打印的 key 与上面不同，以打印的为准。）

### 预期的 peer dependency 警告

pnpm 可能把 `@deepseek-ai/cordis`、`@deepseek-ai/dsh-llm` 或 `@deepseek-ai/dsh-invariants` 报为缺失的 peer。本 bundle 是 Harness 插件：这些包由 Harness 的 host 安装提供，而 profile 有意设置 `autoInstallPeers: false`。pnpm 只检查 profile 的包依赖图，无法看到 Harness 加载插件时提供的 host 包。

该警告本身不表示安装失败。不要为了消除警告而在 profile 中重复安装 Cordis、LLM 或 invariants 包；重复的 host 包可能产生彼此分离的插件上下文或服务实例。先用 `dsh --profile web --dump-config` 验证安装，再启动 `dsh web`；只有任一命令失败，或 pnpm 报告其他缺失包时，才需要调查该警告。

验证组合结果而不启动：

```sh
dsh --profile web --dump-config
```

## 登录

登录是**人类命令**，不是模型工具——不会进入 prompt。

### Web UI

在聊天输入框输入 `/codex login`。浏览器会打开 ChatGPT 授权页；完成后命令会报告令牌已保存。用 `/codex logout` 与 `/codex status` 管理。Device 登录必须在认证等待期间显示验证码，但人类命令只能返回一次最终结果，因此 `/codex login device` 会立即提示使用下面的 CLI 命令，而不会启动一个 UI 无法显示验证码的流程。

### 无头 / CLI

bundle 同时提供一个在 harness 之外运行的 `dsh-codex-oauth` 命令（headless profile 没有命令面板）：

```sh
npx dsh-codex-oauth login                 # 浏览器流程（桌面）
npx dsh-codex-oauth login --method device # device-code 流程（无头）
npx dsh-codex-oauth status
npx dsh-codex-oauth logout
```

Device 流程会打印一次性验证码与验证网址；在任意设备上完成授权后，CLI 会把令牌写入 harness 读取的同一文件。

## 使用 Codex

插件注册的路由名为 **`codex`**，模型来自 pi-ai 安装的 Codex 目录（`gpt-5.x-codex` 系列）。在 Web 模型选择器里选 `codex` / Codex 模型即可；headless profile 则在 profile 的 `cordis.patch.yml` 里改默认模型：

```yaml
- id: agent-default-model
  config:
    provider: codex
    model: gpt-5.4
```

## 配置

| 字段 | 默认值 | 含义 |
|---|---|---|
| `provider` | `codex` | 适配器注册的供应商路由 id。 |
| `storePath` | `$DSH_HOME/codex-oauth.json` | OAuth 凭据存储位置。 |
| `transport` | `sse` | Codex Responses 传输方式：`sse`、`websocket`、`websocket-cached` 或 `auto`。`sse` 在一次性 headless 运行后可正常退出；`websocket`/`websocket-cached` 适合长期交互会话的连接复用，但会让一次性进程保持存活。 |
| `cacheRetention` | `long` | pi-ai 提示缓存保留策略：`none`、`short`、`long`。 |
| `streamIdleTimeoutMs` | `300000` | 等待读取时，供应商流没有事件的最长毫秒数。超时会中止 SDK 流并返回 `TIMEOUT` LLM 失败。 |

## 安全说明

- 存储文件以 `0600` 权限原子写入、目录 `0700`；POSIX 上拒绝读取组/他人可读的文件。它保存的是你的 ChatGPT OAuth 令牌，请像 API key 一样对待。
- harness 进程及其工具子进程以你的用户身份运行；与上游凭据文档一样，该文件对模型可驱动的工具并非隐藏。不要把模型的工作区指向你的 Harness home。
- 只有登录流程发出的 `https` 链接才会交给浏览器打开。系统浏览器打开器缺失或失败时会报告错误，不会终止 harness；CLI 仍会打印网址供手动打开。
- 登录流程是 pi-ai 的官方实现（针对 `chatgpt.com` 的授权码 + device-code）；本插件只负责回答它的交互提示并保存结果。

## 已知限制

- **图片输入遵循 pi-ai 模型目录。** 仅当所选模型声明支持图片时，才通过 Harness 附件服务发送用户图片，并采用 `dsh-llm-pi-ai` 使用的请求图片转换。支持 PNG、JPEG、WebP 和 GIF。历史 assistant 图片输出仍不支持。
- **没有浏览器端 Models 页卡片。** 配置走 patch 层；登录用 CLI 或 `/codex` 命令。
- **无 provider 原生 replay 状态。** 历史 assistant 消息按 provider 中立内容重放（正确，但没有签名/缓存复用）。
- **浏览器登录假定有桌面浏览器。** 无浏览器的机器在终端运行 `dsh-codex-oauth login --method device`。
- **同一时间只运行一次浏览器登录。** OAuth 回调使用一个本地端口；开始下一次浏览器流程前先完成当前流程。存储锁另行串行化凭据写入。

## 开发

```sh
npm install
npm test        # 构建 lib/ 后运行单元测试
```

单元测试覆盖模型目录的输入能力、Harness 到 pi-ai 的图片转换，以及文本请求保持原有内容。

## License

MIT。`src/convert.ts` 的转换模块改编自 `@deepseek-ai/dsh-llm-pi-ai`（MIT，© DeepSeek AI）。
