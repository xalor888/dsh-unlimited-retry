# dsh-unlimited-retry

[English](README.md) · **简体中文**

[![CI](https://github.com/xalor888/dsh-unlimited-retry/actions/workflows/ci.yml/badge.svg)](https://github.com/xalor888/dsh-unlimited-retry/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/dsh-unlimited-retry.svg)](https://www.npmjs.com/package/dsh-unlimited-retry)
[![license](https://img.shields.io/github/license/xalor888/dsh-unlimited-retry.svg)](LICENSE)
[![node](https://img.shields.io/node/v/dsh-unlimited-retry.svg)](package.json)
[![dsh](https://img.shields.io/badge/dsh-%3E%3D0.2.0--0%20%3C0.3.0--0-8a2be2.svg)](#兼容性)

DeepSeek Harness（DSH）的**无限模型请求重试**插件，附带一个实时设置面板。

一次长时间无人值守的运行，不该因为某个请求撞上网络抖动而整个中断。这个插件让这类请求持续重试——指数退避、有延迟上限——直到成功，或直到你叫停。

标准 DSH bundle 插件，`dsh plugin` 一键安装。**同一个包同时支持 DSH Web 与官方桌面客户端**（Electron）。

## 装在哪里

本仓库只维护一条产品线（`main`），同一个包同时支持两种界面。

| 你要装在哪 | 安装方式 |
|---|---|
| **DSH Web 界面** | 终端：`dsh plugin --profile web add dsh-unlimited-retry` |
| **官方桌面客户端（Electron）** | **不用终端** —— 在桌面端会话里让 DSH 用内置的 `plugin_manager` 安装（见下） |

### 官方桌面端：不要用终端命令

桌面端读的是 **`desktop` profile**，而命令行**按设计拒绝**碰它：

```
error: profile "desktop" is managed exclusively by the Electron application
```

所以 `--profile web` 的命令装完，插件落在 `web` profile 里，桌面窗口一个字也读不到 —— 表现就是「设置里根本没有这一页，控制台也不报错」。

**正确做法**：在桌面客户端的会话里直接说：

> 请使用当前宿主内置的 `plugin_manager` 安装 `dsh-unlimited-retry`。先核对当前 profile 和是否已有同名插件；已有安装时先报告来源与版本。完成后告诉我安装结果及是否需要重启。

`plugin_manager` 的作用域就是**当前 profile**（桌面端为 `desktop`），由宿主用它自带的包管理器完成安装与挂载登记 —— 不需要终端、不需要构造 cookie、不需要改写宿主管理的 profile 文件。要固定版本就写 `dsh-unlimited-retry@<版本>`。

首次安装后如果设置里没出现，**完全退出客户端（含系统托盘）再重开**，而不是去堆叠另一份安装。

> 为什么桌面端也能用：桌面端的 profile 就是 Web 模板（`base` + `web-app`），Electron 加载的是本地 Web UI 的 URL，因此 `dsh.client` 声明的面板在桌面端同样被 `client-modules` 装载。不需要另做一套客户端代码。
>
> 命令行 `dsh web` 用的是自己的 `web` profile；更新后重启宿主，并在浏览器 `Ctrl+F5`（Mac 为 `Cmd+Shift+R`）绕过缓存。

## 为什么要单独做一个插件

DSH 自带的 `@deepseek-ai/dsh-llm-retry` 只负责**执行**重试，真正的预算在每家 provider 适配器的 `retryPolicy` 上。它默认的 `mode: "normal"` 在 `maxRetries`（本构建是 5）之后就把决定权交出去，于是 step 失败、turn 以错误结束、整轮运行终止。`mode: "always"` 确实存在，但它是按 provider 全有全无的，而且没有延迟上限。

本插件在所有恢复层**之后**再加一层。`agent/request-error` 是 waterfall 事件，Cordis 从最外层开始依次调用，所以**最后注册的监听器在最内层**：其他所有恢复先决定，只有没人接手的失败才会落到这里。

## 实际重试顺序

按当前默认的「provider 重试 5 次」策略，实际顺序是：

| 第几次尝试 | 由谁处理 | 行为 |
|---|---|---|
| 1 – 5 | provider 的 `retryPolicy` | 它自己的预算、错误码与延迟 |
| 6 – ∞ | **本插件** | 带抖动的指数退避，封顶 `maxDelayMs` |

其他注册在同一事件上的层——上下文溢出压缩、图片卸载（`dsh-compaction-image-offload`）、别的重试插件——同样排在本插件前面。这个顺序正是本插件「最后一个注册」的全部原因，也是 provider 自身策略始终保持权威的原因。

## 是否所有情况都可用

**这是宿主插件，不是 preset 插件**，所以它对同一个 profile 启动的每个会话、每种 preset 都生效。以下都按真实契约验证过：

| 场景 | 是否生效 | 依据 |
|---|---|---|
| 任意 agent preset（standard / ptc / minimal / cordis） | ✅ | 宿主插件，不依赖 preset |
| 同一组合下的多个兄弟 agent | ✅ | 各自持有独立阶梯，互不干扰 |
| 挂载在 preset 作用域内的 agent | ✅ | 真实 Cordis 作用域分发测试通过 |
| headless / ACP / SDK 组合（无 Web 服务器） | ✅ 重试生效，无面板 | 只注册一个事件监听器，不依赖 Web 服务 |
| DSH Web 界面 | ✅ | `dsh.client` 面板 |
| 官方桌面客户端（Electron） | ✅ | 桌面 profile = Web 模板，加载同一 Web UI |
| **`ABORTED`（你主动取消）** | ❌ 设计上永不重试 | 取消不是故障 |
| provider 适配器没接纳的请求 | ❌ 到不了这里 | 不产生 `agent/request-error` |
| agent 循环拿到 turn 之前的失败 | ❌ 到不了这里 | 同上 |

## 特性

### 重试行为

- 🔁 **真正无限**：默认不设次数上限，一直重试到成功或你叫停
- ⏱️ **指数退避 + 抖动**：`initialDelayMs` 起算，每次翻倍，封顶 `maxDelayMs`，每轮叠加随机抖动避免同步风暴
- 🚧 **上限是硬约束**：`maxDelayMs` 是天花板，**任何配置冲突都以它为准**。设了 10ms 就是 10ms，不会因为 `initialDelayMs` 更大而被悄悄抬高
- 🛑 **取消永不重试**：`ABORTED` 在任何配置下都终止（见下）
- 🎯 **provider 延迟照办但封顶**：`providerRetryAfterMs` 会被尊重，同时被 `maxDelayMs` 夹住，单家 provider 无法把整轮运行无限期按住
- 🧭 **按 step 重置**：一个阶梯属于一个 step，新 step 从首次延迟重新起算，不会从上一步的天花板接着跑
- 🔌 **无 provider 策略也重试**：适配器没发布 `retryPolicy` 时同样工作（可关）

### 会话事件

每次排定的重试写入两条事件，顺序与 `dsh-llm-retry` 一致：

1. `llm/retry` —— 在等待**之前**，所以日志里记录的等待是真实发生过的；
2. `llm/retry-started` —— 在等待**之后**，请求真正重新发出的时刻。

因此被中止或插件卸载取消的重试，会留下一条 `llm/retry` 而没有对应的 `llm/retry-started` —— 这恰好就是事实。`mode` 记为 `always`，`policyKey` 固定为 `unlimited-retry`，不会与 provider 的预算冲突。

### 设置面板

- 📊 **实时状态**：小标签显示宿主端是否有响应
- 🔢 **计数器**：累计重试、等待中的请求、正在重试的会话、最近一次重试、运行时长
- 🪜 **实际重试顺序**：每次尝试会发生什么；不设上限时如实显示 `No limit`
- 📈 **分布**：按错误码、按 provider；另有一栏因错误码被判终止而主动放弃的次数
- 🕒 **最近重试**：第几次、错误码、provider、延迟、时间（相对显示）
- ⚙️ **策略编辑**：开关与数字直接经 `configEditor` 写回 profile 补丁层，重启仍生效，并热重载宿主端
- 🏷️ **终止错误码**：逐个添加（带真实错误码下拉建议），或一键套用推荐集合
- 🧹 **清零计数**：需要一次显式确认
- 🎨 **主题跟随**：只用 `--dsw-alias-*` 变量，明暗主题与后续换肤自动生效
- ♿ **可访问性**：开关是真正的 `role="switch"` + `aria-checked`，页面不在自己组件树之外写 DOM
- 🌏 **中英双语**：面板与元数据均双语

## `ABORTED`：唯一无条件终止的码

取消不是故障——要么这一轮被叫停，要么进程正在退出。`dsh-llm` 在 `signal.aborted || code === "ABORTED"` 这两种情况下都会给出 `aborted` 结束态，也就是说 **`ABORTED` 可能在循环自身的 signal 还没翻转时就到达本插件**。

重试它等于把你刚刚取消的工作重新跑一遍，所以这条判断放在 `excludeCodes` 之前，**清空该列表也不会让它恢复**。两侧匹配都忽略大小写并去除空白，因此 `Aborted`、`ABORTED`、` aborted ` 是同一个码。

面板里会显式写出这条规则，不会让它看起来像某个设置被忽略了。

## 默认值，以及它的代价

```yaml
autoRetry: true
maxAttempts: null        # 不设次数上限
initialDelayMs: 1000
maxDelayMs: 60000
jitterRatio: 0.2
retryWithoutProviderPolicy: true
excludeCodes: []         # 没有配置层面的终止码（ABORTED 始终终止）
recordSessionEvents: true
log: true
markerFile: null
```

**默认没有任何「配置层面」的终止错误码——包括认证、配额、计费、上下文溢出。** 这就是这里「无限」的含义，并且挂载时会明确提示一次，让它是一个可见的决定，而不是一次无声的花费。唯一的约束是 `maxDelayMs`：一个永久失败的请求大约每分钟重试一次，一直持续下去。

两种收口方式：

1. **设置 `maxAttempts`** 为正整数 —— 本插件在每个 step 重试这么多次后交回上层，效果等同于没装。
2. **把终止错误码写进 `excludeCodes`。** 面板里有一键*使用推荐集合*，这些码的共同点是「重发一次仍然同样失败」：

   `AUTH`、`UNAUTHORIZED`、`FORBIDDEN`、`BILLING`、`QUOTA`、`ACCOUNT_QUOTA`、
   `MISSING_CREDENTIAL`、`INVALID_CREDENTIAL`、`MODEL_NOT_FOUND`、`NO_ADAPTER`、
   `CONTEXT_WINDOW_EXCEEDED`、`CONTEXT_OVERFLOW`、`CONTEXT_LENGTH`、`INVALID_REQUEST`

   > `IMAGE_OFFLOAD_REQUIRED` **故意不在**推荐集合里：`dsh-compaction-image-offload` 会靠压缩请求来恢复它，而且注册在本插件之前；它若放弃，重试才是下一步正确动作。

清空的数字字段会**回落到默认值**，而不是被当成 0（`Number(null)` 恰恰是 0，那会让延迟变忙循环、抖动变零）。

## 安装

### 从 npm（推荐）

```bash
# Web 界面
dsh plugin --profile web add dsh-unlimited-retry
```

官方桌面客户端请在桌面端会话里用内置的 `plugin_manager` 安装 ——
见 [装在哪里](#装在哪里)。命令行按设计拒绝 `--profile desktop`。

### 从本仓库

```bash
dsh plugin --profile web add github:xalor888/dsh-unlimited-retry
```

> ⚠️ npm 名与 `github:` 是同一个包名，**别混装**，先后安装会并存冲突。已是 `github:` 装的，要换 npm 名请先 `dsh plugin --profile web remove dsh-unlimited-retry`。

### 本地开发

```bash
dsh plugin --profile web add link:/绝对路径/dsh-unlimited-retry
```

装好后打开 **设置 → 重试**。

### 装完怎么自检

装完看不到面板时，按下面两条分别确认宿主半区和客户端半区是否真的挂上了：

1. **宿主半区**：`~/.dsh/adapters/unlimited-retry/mounted.json` 存在，且 `version` 就是你想装的那个版本；
2. **客户端半区**：浏览器（或桌面端开发者工具）里能取到 `/plugins/??dsh-unlimited-retry/client.js&rev=…` 并返回 `200`。

如果第 1 条通过、第 2 条失败，是客户端缓存问题——强制刷新（`Ctrl+F5` / Mac `Cmd+Shift+R`）。
如果第 1 条就不存在，插件根本没挂上，回到安装那一步，先确认装的是哪个 profile。

## 目录结构

```text
dsh-unlimited-retry/
├── package.json          # bundle 元数据（dsh.bundle.patch / dsh.client / icon / exports）
├── cordis.patch.yml      # 挂载声明，含全部默认值
├── icon.svg              # 插件列表图标（宿主读成 data URL）
├── index.js              # 宿主端：监听器 + 退避 + 会话事件 + 计数器 + 三个路由 + Config schema
├── client.js             # 浏览器端：设置面板（浏览器 bundle 格式）
├── locale/
│   ├── en.json           # 元数据标题/描述（英文）
│   └── zh.json           # 元数据标题/描述（中文）
├── test/
│   ├── host.test.mjs     # 重试判定路径 + 全部接口
│   ├── client.test.mjs   # 面板注册、双语文案、渲染、状态
│   ├── bundle.test.mjs   # 包结构、patch 完整性、图标、许可
│   └── projection.test.mjs # 真实 projection 服务 + 真实 Cordis 分发器集成测试
├── README.md / README.zh.md
└── LICENSE
```

## 配置

改 `unlimited-retry` 那一行的 `config`，或用面板。任何上层 override 都会替换**整个** `config`，所以覆盖这一行的层必须把它想保留的字段全部重述一遍。

插件同时导出 `Config` schema，因此字段会出现在 `Config.listConfigs` 里，并由 Loader 校验。

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `autoRetry` | boolean | `true` | 关掉即完全让出，等同没装 |
| `maxAttempts` | number \| null | `null` | 每个 step 的重试上限；`null`/空 = 无限 |
| `initialDelayMs` | number | `1000` | 首次退避延迟；大于上限时被上限夹住 |
| `maxDelayMs` | number | `60000` | **单次延迟天花板，冲突时以它为准** |
| `jitterRatio` | number | `0.2` | 每轮延迟的随机浮动比例（0–1） |
| `retryWithoutProviderPolicy` | boolean | `true` | 适配器没发布 `retryPolicy` 时也重试 |
| `excludeCodes` | string[] | `[]` | 终止错误码（大小写/空白不敏感） |
| `recordSessionEvents` | boolean | `true` | 是否写入 `llm/retry` / `llm/retry-started` |
| `log` | boolean | `true` | 是否把重试决定写进 DSH 日志 |
| `markerFile` | string \| null | `null` | 可选：挂载探针文件路径（诊断用） |

## HTTP 接口

宿主端新增三个路由，注册在 DSH Web 服务器上，沿用整个组合一致的浏览器准入检查：未认证的浏览器请求 `401`，来源不可信的请求 `403`。与普通路由处理函数不同，**不会悄悄绕过 cookie 校验**。

| 路由 | 方法 | 用途 |
|---|---|---|
| `/unlimited-retry/stats` | `GET`、`HEAD` | 面板渲染的只读模型 |
| `/unlimited-retry/config` | `POST` | 校验并持久化一次策略修改 |
| `/unlimited-retry/reset` | `POST` | 清零计数（必须 `{"confirm": true}`） |

组合里没有准入服务时写操作返回 `403`；行不可寻址或没有 `configEditor` 时返回 `409`。请求体上限 8 KiB，且必须是 `application/json`。

这些路由只是给面板用的便利通道。**重试行为本身从不依赖它们**，所以 headless / ACP / SDK 组合只挂策略、完全没有路由。

## 验证

```bash
npm test        # 或 node --test test/
```

覆盖重试判定路径（委托、排除、次数上限、provider 延迟、中止、销毁、按 step 重置、1.x 旧配置键）、每个接口（状态码、`HEAD`、准入、请求体校验、未知键、推荐集合、清零确认、失败编辑器）、客户端 bundle（注册、中英键齐平与占位符校验、渲染、错误/空/只读状态、纯变量样式）、包结构（manifest、patch 字段完整性、图标、许可），以及**真实 projection 服务 + 真实 Cordis 分发器的集成测试**。

验证线上挂载（未认证返回 `401` 是正确的——请打开带认证参数的 GUI 看面板）：

```bash
curl -s http://127.0.0.1:3080/unlimited-retry/stats | head -c 400
```

## 兼容性

| 依赖 | 要求 |
|---|---|
| Node.js | **>= 20** |
| DSH | **>= 0.2.0-0 < 0.3.0-0**（`package.json` 的 `engines.dsh`，由宿主的兼容性预检强制执行） |
| 带 `dsh-agent-loop` 与 `dsh-llm-retry` | 是（重试监听器挂在那条事件上） |

`engines.dsh` 的 `-0` 下界是刻意的：宿主的预检用 `includePrerelease: true` 匹配，而只有带预发布标签的边界才能放行 `0.2.1-rc.3` 这样的预发布运行时。写成 `>=0.2.0` 会把所有 `-rc` 版本静默排除。
- 有 `AbortSignal.any` 就用它，没有则用 controller 方案等价实现。
- 1.x 的 `config` 仍可挂载：`retryAllCodes` 被忽略（除非显式排除，否则每个码都会重试），`terminalCodes` 按 `excludeCodes` 读取，两者各打一条替代提示。
- Web 面板另需 `configEditor` 与 `settings.section` 槽位；缺这些时策略照常生效，页面只是不存在或只读。

## 发布流程

发布由 tag 驱动，任何分支都不会触发发布。

```bash
# 1. 改 package.json 的版本号（以及 index.js 里的 PLUGIN_VERSION）
npm version patch --no-git-tag-version   # 或 minor / major
# 2. 提交并合入，然后在合入后的 commit 上打 tag
git tag v2.1.3 && git push origin v2.1.3
```

`Release` 工作流会：拒绝与 `package.json` 不一致的 tag → 跑测试 → 打包 →
带 npm provenance 发布 → 创建 GitHub Release 并附上 tarball → 最后从 registry
重新安装已发布版本，证明那一份也能正常挂载。它需要仓库 secret `NPM_TOKEN`
和一个名为 `npm` 的 environment。

`CI` 在 Node 20 / 22 / 24 上跑测试套件，然后打包、断言发布文件清单没有漂移、
装进一个干净工程，并挂载安装后的宿主端——包括「取消永不重试」这条规则。

> 集成测试（`test/projection.test.mjs`）需要真实 Harness，CI 上没有，因此在
> CI 里跳过。本地运行：
> `DSH_INSTALL_DIR=~/.local/lib/node_modules/@deepseek-ai/dsh/node_modules npm test`。

## 许可

MIT —— 见 [LICENSE](LICENSE)。
