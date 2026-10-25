# dsh-unlimited-retry

为 DeepSeek Harness 的 agent 循环提供无限模型请求重试，并附带一个实时设置面板。

[English](README.md)

一次长时间无人值守的运行，不该因为某个请求撞上网络抖动而整个中断。这个插件会让这类请求持续重试——指数退避、有延迟上限——直到成功，或直到你叫停。

## 为什么要单独做一个插件

`@deepseek-ai/dsh-llm-retry` 是 Harness 自带的，但它只负责*执行*重试，真正的预算在每家 provider 适配器的 `retryPolicy` 上。它默认的 `mode: "normal"` 在 `maxRetries`（本构建是 5）之后就把决定权交出去，于是 step 失败、turn 以错误结束、整轮运行终止。`mode: "always"` 确实存在，但它是按 provider 全有全无的，而且没有延迟上限。

本插件在所有恢复层*之后*再加一层。`agent/request-error` 是 waterfall 事件，Cordis 从最外层开始依次调用，所以最后注册的监听器在最内层：其他所有恢复先决定，只有没人接手的失败才会落到这里。

## 实际重试顺序

按当前默认的「provider 重试 5 次」策略，实际顺序是：

| 第几次尝试 | 由谁处理 | 行为 |
| --- | --- | --- |
| 1 – 5 | provider 的 `retryPolicy` | 它自己的预算、错误码与延迟 |
| 6 – ∞ | **本插件** | 带抖动的指数退避，封顶 `maxDelayMs` |

其他注册在同一事件上的层——上下文溢出压缩、图片卸载、别的重试插件——同样排在本插件前面。这个顺序正是本插件「最后一个注册」的全部原因，也是 provider 自身策略始终保持权威的原因。

## 安装

把整个目录作为 bundle 装进当前 profile：

```
plugin_manager install_bundle  target: /绝对路径/dsh-unlimited-retry
```

不要手工把文件拷进 profile，也不要手改 `cordis.patch.yml`：bundle 安装器才会完成包安装与 bundle 选择，也只有这条路能让 profile 自己的包清单保持一致。

装好之后打开 **设置 → 重试** 就能看到实时面板。

## 面板

这个设置页反映的是正在运行的策略，而不是一张静态表单：

- **实时状态** —— 小标签显示宿主端是否有响应；轮询偶发失败时，页面保留上一次的数字，而不是整页变空。
- **计数器** —— 累计重试、等待中的请求、正在重试的会话、最近一次重试、运行时长。计数是进程级的，所以改配置（会导致宿主端重载）不会把正在看的数字清零。
- **实际重试顺序** —— 每次尝试会发生什么；不设上限时如实显示 `No limit`，而不是编一个数字。
- **分布** —— 按错误码、按 provider 统计；另有一栏是本插件因错误码被判定为终止而主动放弃的次数。
- **最近重试** —— 第几次、错误码、provider、延迟、时间，时间用相对显示。
- **策略编辑** —— 开关与数字直接经 Harness `configEditor` 写回 profile 补丁层，重启后仍生效，并会热重载宿主端。
- **终止错误码** —— 逐个添加，或一键套用推荐集合（见下）。
- **清零计数** —— 需要一次显式确认。

面板只使用 `--dsw-alias-*` 主题变量，因此明暗主题和后续换肤都会自动跟随。开关是真正的 `role="switch"` + `aria-checked`，页面不会在自己组件树之外写任何 DOM。

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
```

**默认没有任何「配置层面」的终止错误码——包括认证、配额、计费、上下文溢出。** 这就是这里「无限」的含义，并且挂载时会明确提示一次，让它是一个可见的决定，而不是一次无声的花费。唯一的约束是 `maxDelayMs`：一个永久失败的请求大约每分钟重试一次，一直持续下去。

有一个错误码无论如何都终止：**`ABORTED`**。取消不是故障——要么这一轮被叫停，要么进程正在退出。`dsh-llm` 在 `signal.aborted || code === "ABORTED"` 这两种情况下都会给出 `aborted` 结束态，也就是说 `ABORTED` 可能在循环自身的 signal 还没翻转时就到达这里。重试它等于把你刚刚取消的工作重新跑一遍，所以这条判断放在 `excludeCodes` 之前，且清空该列表也不会让它恢复。两侧匹配都忽略大小写并去除空白，因此 `Aborted`、`ABORTED`、` aborted ` 是同一个码。

两种收口方式：

1. **设置 `maxAttempts`** 为正整数——本插件在每个 step 重试这么多次后交回上层，效果等同于没装。
2. **把终止错误码写进 `excludeCodes`。** 面板里有一键*使用推荐集合*，这些码的共同点是「重发一次仍然同样失败」：

   `AUTH`、`UNAUTHORIZED`、`FORBIDDEN`、`BILLING`、`QUOTA`、`ACCOUNT_QUOTA`、
   `MISSING_CREDENTIAL`、`INVALID_CREDENTIAL`、`MODEL_NOT_FOUND`、`NO_ADAPTER`、
   `CONTEXT_WINDOW_EXCEEDED`、`CONTEXT_OVERFLOW`、`CONTEXT_LENGTH`、
   `INVALID_REQUEST`

provider 要求的延迟（`providerRetryAfterMs`）会被尊重，但同样被 `maxDelayMs` 封顶，免得某一家 provider 把整轮运行无限期按住。

## 会话事件

每次排定的重试会写入两条事件：

1. `llm/retry` —— 在等待**之前**，所以日志里记录的等待是真实发生过的；
2. `llm/retry-started` —— 在等待**之后**，请求真正重新发出的时刻。

因此被中止或插件卸载取消的重试，会留下一条 `llm/retry` 而没有对应的 `llm/retry-started`，这恰好就是事实。设 `recordSessionEvents: false` 可以两条都不写。

`mode` 记为 `always`，聊天界面因此把预算渲染成无限；`policyKey` 固定为 `unlimited-retry`，不会与 provider 的预算冲突。

## 配置

改 `unlimited-retry` 那一行的 `config`，或者用面板。任何上层 override 都会替换**整个** `config`，所以覆盖这一行的层必须把它想保留的字段全部重述一遍。

插件同时导出 `Config` schema，所以它的字段会出现在 `Config.listConfigs` 里，并由 Loader 校验。

## HTTP 接口

宿主端新增三个路由。它们注册在 Harness Web 服务器上，因此沿用整个组合一致的浏览器准入检查：未认证的浏览器请求得到 `401`，来源不可信的请求得到 `403`。与普通路由处理函数不同，这里不会悄悄绕过 cookie 校验。

| 路由 | 方法 | 用途 |
| --- | --- | --- |
| `/unlimited-retry/stats` | `GET`、`HEAD` | 面板渲染的只读模型 |
| `/unlimited-retry/config` | `POST` | 校验并持久化一次策略修改 |
| `/unlimited-retry/reset` | `POST` | 清零计数（必须 `{"confirm": true}`） |

组合里没有准入服务时，写操作返回 `403`；行不可寻址或没有 `configEditor` 时返回 `409`。请求体上限 8 KiB，且必须是 `application/json`。

这些路由只是给面板用的便利通道。重试行为本身从不依赖它们，所以 headless 或 ACP 组合只挂策略、完全没有路由。

### 任何模式、任何组合

重试策略是宿主插件，因此对同一个 profile 启动的每个会话、每种 preset 都生效，
在没有 Web 服务器的 headless 或 ACP 组合里同样生效。插件只注册一个
`agent/request-error` 监听器，别的不需要；面板是一个独立、可选的界面。

以下都是按真实契约验证过的，而不是只靠桩：

- 真实 Cordis 分发器，同一组合下的兄弟 agent 各自持有自己的阶梯；
- 真实 session-projection 服务，包括从会话日志回放的重建 cell；
- 挂载在 preset 作用域内的 agent（监听器带作用域标记）；
- 没有 `webServer`、没有 `connection`、没有 `configEditor` 的组合，仍然正常重试，只是没有面板。

它**不会**做的事：重试 provider 适配器根本没接纳的请求，或失败发生在 agent 循环拿到
turn 之前的请求——那些根本不会到达 `agent/request-error`。`ABORTED` 是设计上明确终止的。

## 验证

```bash
cd dsh-unlimited-retry
node --test test/
```

测试覆盖：重试判定路径（委托、排除、次数上限、provider 延迟、中止、销毁、按 step 重置、1.x 配置键）、每个接口（状态码、`HEAD`、准入、请求体校验、未知键、推荐集合写入、清零确认）、客户端 bundle（注册、中英文案对齐、渲染、错误/空/只读状态、纯变量样式）、以及包结构（manifest、patch、语言包、图标、许可证）。

验证线上挂载：

```bash
curl -s http://127.0.0.1:3080/unlimited-retry/stats | head -c 400
```

这里未认证返回 `401` 是正确的——请打开带认证参数的 GUI 地址看面板，它走浏览器自己的 cookie。

## 环境要求

- 具备 `agent/request-error` waterfall 事件的 DeepSeek Harness（凡是带 `dsh-agent-loop` 与 `dsh-llm-retry` 的版本都满足）。
- Web 面板另外需要 Web 组合、`configEditor` 和 `settings.section` 槽位。缺这些时策略照常生效，页面只是不存在或只读。

## 兼容性

- Node.js 20 及以上。
- 有 `AbortSignal.any` 就用它，没有则用 controller 方案等价实现。
- 1.x 的 `config` 仍可挂载：`retryAllCodes` 被忽略（除非显式排除，否则每个码都会重试），`terminalCodes` 按 `excludeCodes` 读取。两者都会各打一条警告，指出新的替代字段。

## 许可证

MIT —— 见 [LICENSE](LICENSE)。
