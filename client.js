/**
 * dsh-unlimited-retry — browser half.
 *
 * The Settings page for the unbounded model-request retry policy. The host half
 * (`index.js`) serves three read/write endpoints; this page renders them and
 * writes policy changes back through the Harness `configEditor`, so a change
 * made here lands in the profile patch, survives a restart, and hot-reloads the
 * host half through the normal Loader path.
 *
 * Bundle format: the client-modules loader evaluates this file through
 * `window.__ModuleLoader__.load({ id, factory })`. Only platform seed words
 * (`react`, `react/jsx-runtime`, `@deepseek-ai/dsh-client-store`) are
 * requireable without declaring them in `dsh.client.external`, so the panel
 * uses `createSnapshotStore` for its poll state and its own controls, classes,
 * and `--dsw-alias-*` tokens for everything else.
 */

window.__ModuleLoader__.load({
  id: "dsh-unlimited-retry",
  factory: (require) => {
    const module = { exports: {} };
    const exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    const React = require("react");
    const { createSnapshotStore } = require("@deepseek-ai/dsh-client-store");

    const NS = "unlimitedRetry";
    const STATS_ENDPOINT = "/unlimited-retry/stats";
    const CONFIG_ENDPOINT = "/unlimited-retry/config";
    const RESET_ENDPOINT = "/unlimited-retry/reset";
    const POLL_MS = 1200;

    // ---------------------------------------------------------------------
    // Copy
    // ---------------------------------------------------------------------
    const en = {
      nav: "Retry",
      title: "Model request retry",
      subtitle: "Unbounded retry for requests that no other recovery layer handled.",
      statusLive: "Live",
      statusError: "Unreachable",
      statusLoading: "Connecting",
      refresh: "Refresh",
      saving: "Saving…",
      save: "Apply",
      discard: "Discard",
      saved: "Policy saved. The host half reloaded with the new settings.",
      saveFailed: "The host rejected the change",
      unsaved: "Unsaved changes",
      total: "Retries performed",
      active: "Waits in flight",
      sessions: "Sessions retrying",
      lastAt: "Last retry",
      never: "never",
      uptime: "Uptime",
      mounts: "Mounts",
      ladderTitle: "Effective retry ladder",
      ladderHint: "Earlier layers get the first word. This plugin only handles what nobody recovered.",
      ladderProvider: "Provider retry policy",
      ladderPlugin: "This plugin",
      ladderBeyond: "and beyond, every delay capped at {max}",
      ladderCap: "up to attempt {n}",
      ladderTerminal: "Terminal",
      ladderTerminalHint: "Excluded codes stop here and fail the turn immediately.",
      policyTitle: "Retry policy",
      policyHint: "Writes to this profile's patch layer. Values survive a restart.",
      enabled: "Retry enabled",
      enabledHint: "Turn off to leave every failure to the agent loop.",
      maxAttempts: "Attempt limit",
      maxAttemptsHint: "Empty means no limit — retries continue until one succeeds.",
      unlimited: "No limit",
      initialDelay: "First delay",
      maxDelay: "Delay ceiling",
      jitter: "Jitter",
      jitterHint: "Randomization per delay, as a share of the nominal value.",
      withoutPolicy: "Retry without a provider policy",
      withoutPolicyHint: "Also retry when the serving adapter published no retryPolicy.",
      recordEvents: "Record session events",
      recordEventsHint: "Append llm/retry and llm/retry-started so the chat surface shows the chain.",
      excludeTitle: "Terminal codes",
      excludeHint: "Failures with these codes are left to the loop instead of retried.",
      excludeEmpty: "No code is terminal: every failure retries.",
      excludeAdd: "Add a code",
      excludePlaceholder: "e.g. INVALID_REQUEST",
      excludeRemove: "Remove {code}",
      excludeAddAction: "Add",
      excludePreset: "Use recommended set",
      excludeClear: "Clear all",
      excludeUnknown: "Enter a failure code first.",
      alwaysTerminal: "{codes} always stay terminal: a cancellation is not a fault, so it is never retried.",
      excludeDuplicate: "{code} is already listed.",
      byCode: "By failure code",
      byProvider: "By provider",
      terminalSeen: "Left to the loop",
      terminalSeenHint: "Failures this plugin declined because their code is terminal.",
      recentTitle: "Recent retries",
      recentEmpty: "No retry has been performed since this process started.",
      colAttempt: "Attempt",
      colCode: "Code",
      colProvider: "Provider",
      colDelay: "Delay",
      colWhen: "When",
      countersTitle: "Counters",
      countersHint: "Counters are kept across plugin reloads and reset with the process.",
      reset: "Reset counters",
      resetConfirm: "Reset all retry counters?",
      resetYes: "Reset",
      resetNo: "Cancel",
      resetDone: "Counters cleared.",
      footer: "v{version} · pid {pid}",
      ms: "{n} ms",
      seconds: "{n} s",
      minutes: "{n} min",
      hours: "{n} h",
      ago: "{n} ago",
      justNow: "just now",
      unreachable: "The host half did not answer. It may be disabled, or this page may be served by a different process.",
      loadingBody: "Reading retry state…",
      readOnly: "This composition has no config editor, so the policy is read-only here.",
      noRow: "The plugin row is not addressable, so the policy cannot be written from here.",
    };

    const zh = {
      nav: "重试",
      title: "模型请求重试",
      subtitle: "对所有未被其他恢复层处理的请求做无限重试。",
      statusLive: "实时",
      statusError: "不可达",
      statusLoading: "连接中",
      refresh: "刷新",
      saving: "保存中…",
      save: "应用",
      discard: "放弃修改",
      saved: "策略已保存，宿主端已按新配置重新加载。",
      saveFailed: "宿主端拒绝了这次修改",
      unsaved: "有未保存的修改",
      total: "累计重试",
      active: "等待中",
      sessions: "重试中的会话",
      lastAt: "最近一次",
      never: "从未",
      uptime: "运行时长",
      mounts: "加载次数",
      ladderTitle: "实际重试顺序",
      ladderHint: "越靠前的恢复层越先决定，本插件只处理没人接手的失败。",
      ladderProvider: "Provider 重试策略",
      ladderPlugin: "本插件",
      ladderBeyond: "此后每一次延迟都封顶 {max}",
      ladderCap: "至第 {n} 次",
      ladderTerminal: "终止",
      ladderTerminalHint: "被排除的错误码直接结束该轮，不再重试。",
      policyTitle: "重试策略",
      policyHint: "写入当前 profile 的补丁层，重启后仍然生效。",
      enabled: "启用重试",
      enabledHint: "关闭后所有失败都交回 agent 循环处理。",
      maxAttempts: "次数上限",
      maxAttemptsHint: "留空表示不设上限，一直重试到成功为止。",
      unlimited: "不设上限",
      initialDelay: "首次延迟",
      maxDelay: "延迟上限",
      jitter: "抖动",
      jitterHint: "每次延迟围绕基准值的随机浮动比例。",
      withoutPolicy: "无 provider 策略时也重试",
      withoutPolicyHint: "当 provider 适配器没有发布 retryPolicy 时同样重试。",
      recordEvents: "写入会话事件",
      recordEventsHint: "追加 llm/retry 与 llm/retry-started，聊天界面才会显示重试链路。",
      excludeTitle: "终止错误码",
      excludeHint: "命中这些错误码的失败交回上层，不再重试。",
      excludeEmpty: "没有终止错误码：所有失败都会重试。",
      excludeAdd: "添加错误码",
      excludePlaceholder: "例如 INVALID_REQUEST",
      excludeRemove: "移除 {code}",
      excludeAddAction: "添加",
      excludePreset: "使用推荐集合",
      excludeClear: "全部清除",
      excludeUnknown: "请先输入错误码。",
      alwaysTerminal: "{codes} 始终终止：取消不是故障，因此永不重试。",
      excludeDuplicate: "已经包含 {code}。",
      byCode: "按错误码",
      byProvider: "按 provider",
      terminalSeen: "交回上层",
      terminalSeenHint: "因错误码被判定为终止、本插件主动放弃重试的次数。",
      recentTitle: "最近重试",
      recentEmpty: "本进程启动以来还没有发生重试。",
      colAttempt: "第几次",
      colCode: "错误码",
      colProvider: "Provider",
      colDelay: "延迟",
      colWhen: "时间",
      countersTitle: "计数器",
      countersHint: "计数跨插件重载保留，随进程结束归零。",
      reset: "清零计数",
      resetConfirm: "确定清零所有重试计数？",
      resetYes: "清零",
      resetNo: "取消",
      resetDone: "计数已清零。",
      footer: "v{version} · pid {pid}",
      ms: "{n} 毫秒",
      seconds: "{n} 秒",
      minutes: "{n} 分钟",
      hours: "{n} 小时",
      ago: "{n}前",
      justNow: "刚刚",
      unreachable: "宿主端没有响应：插件可能已停用，或当前页面由另一个进程提供。",
      loadingBody: "正在读取重试状态…",
      readOnly: "当前组合没有 configEditor，因此这里只能查看策略。",
      noRow: "插件行不可寻址，无法从这里写入策略。",
    };

    // ---------------------------------------------------------------------
    // Formatting helpers
    // ---------------------------------------------------------------------
    function makeFormat(t) {
      const fill = (template, values) => template.replace(/\{(\w+)\}/g, (match, key) =>
        Object.hasOwn(values, key) ? String(values[key]) : match,
      );

      const duration = (ms) => {
        if (!Number.isFinite(ms) || ms < 0) return "—";
        if (ms < 1000) return fill(t("ms"), { n: Math.round(ms) });
        if (ms < 60_000) return fill(t("seconds"), { n: (ms / 1000).toFixed(ms < 10_000 ? 1 : 0) });
        if (ms < 3_600_000) return fill(t("minutes"), { n: (ms / 60_000).toFixed(ms < 600_000 ? 1 : 0) });
        return fill(t("hours"), { n: (ms / 3_600_000).toFixed(1) });
      };

      const relative = (iso, now) => {
        if (typeof iso !== "string") return "—";
        const at = Date.parse(iso);
        if (!Number.isFinite(at)) return "—";
        const delta = Math.max(0, now - at);
        if (delta < 5_000) return t("justNow");
        return fill(t("ago"), { n: duration(delta) });
      };

      const clock = (iso) => {
        if (typeof iso !== "string") return "—";
        const at = Date.parse(iso);
        if (!Number.isFinite(at)) return "—";
        return new Date(at).toLocaleTimeString();
      };

      const count = (value) => new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }).format(Number.isFinite(value) ? value : 0);

      return { fill, duration, relative, clock, count };
    }

    // ---------------------------------------------------------------------
    // Styles — tokens only, so light/dark and future rethemes both follow.
    // ---------------------------------------------------------------------
    const CSS = `
.duRoot { display: flex; flex-direction: column; gap: 18px; padding: 2px 2px 28px; font: inherit; color: var(--dsw-alias-label-primary); }
.duRoot *, .duRoot *::before, .duRoot *::after { box-sizing: border-box; }

.duHead { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; flex-wrap: wrap; }
.duHeadText { min-width: 0; }
.duTitleRow { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.duTitle { font-size: 16px; line-height: 24px; font-weight: 600; letter-spacing: .01em; }
.duSub { margin-top: 2px; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary); }
.duHeadActions { display: flex; align-items: center; gap: 8px; flex-shrink: 0; }

.duPill { display: inline-flex; align-items: center; gap: 6px; height: 20px; padding: 0 8px; border-radius: 999px;
  border: 1px solid var(--dsw-alias-border-l2); font-size: 11px; line-height: 1; color: var(--dsw-alias-label-secondary); white-space: nowrap; }
.duPill::before { content: ""; width: 6px; height: 6px; border-radius: 50%; background: currentColor; flex: none; }
.duPill[data-tone="live"] { color: var(--dsw-alias-state-success-primary); border-color: color-mix(in srgb, var(--dsw-alias-state-success-primary) 40%, var(--dsw-alias-border-l2)); }
.duPill[data-tone="error"] { color: var(--dsw-alias-state-error-primary); border-color: color-mix(in srgb, var(--dsw-alias-state-error-primary) 40%, var(--dsw-alias-border-l2)); }
.duPill[data-tone="dirty"] { color: var(--dsw-alias-state-warn-primary); border-color: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 40%, var(--dsw-alias-border-l2)); }

.duBtn { appearance: none; display: inline-flex; align-items: center; justify-content: center; gap: 6px;
  min-height: 30px; padding: 0 12px; border-radius: 7px; border: 1px solid var(--dsw-alias-border-l2);
  background: transparent; color: inherit; font: inherit; font-size: 12px; line-height: 1; cursor: pointer;
  transition: background .14s ease, border-color .14s ease, opacity .14s ease; }
.duBtn:hover:not(:disabled) { background: var(--dsw-specific-sidebar-fill, var(--dsw-alias-bg-layer-2)); }
.duBtn:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 2px; }
.duBtn:disabled { opacity: .45; cursor: not-allowed; }
.duBtn[data-variant="primary"] { border-color: var(--dsw-alias-brand-primary); background: var(--dsw-alias-brand-primary);
  color: var(--dsw-alias-bg-base); font-weight: 600; }
.duBtn[data-variant="primary"]:hover:not(:disabled) { opacity: .88; background: var(--dsw-alias-brand-primary); }
.duBtn[data-variant="quiet"] { border-color: transparent; color: var(--dsw-alias-label-secondary); }
.duBtn[data-variant="quiet"]:hover:not(:disabled) { color: var(--dsw-alias-label-primary); }
.duBtn[data-size="tiny"] { min-height: 24px; padding: 0 8px; font-size: 11px; }

.duNotice { display: flex; align-items: flex-start; gap: 8px; padding: 9px 12px; border-radius: 8px;
  font-size: 12px; line-height: 18px; border: 1px solid var(--dsw-alias-border-l2); }
.duNotice[data-tone="error"] { color: var(--dsw-alias-state-error-primary);
  border-color: color-mix(in srgb, var(--dsw-alias-state-error-primary) 42%, transparent);
  background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 8%, transparent); }
.duNotice[data-tone="ok"] { color: var(--dsw-alias-state-success-primary);
  border-color: color-mix(in srgb, var(--dsw-alias-state-success-primary) 42%, transparent);
  background: color-mix(in srgb, var(--dsw-alias-state-success-primary) 8%, transparent); }
.duNotice[data-tone="muted"] { color: var(--dsw-alias-label-secondary); background: var(--dsw-alias-bg-layer-2); }
.duNoticeBody { flex: 1; min-width: 0; overflow-wrap: anywhere; }
.duNoticeDetail { margin-top: 2px; font-family: var(--dsw-font-family-mono, ui-monospace, monospace);
  font-size: 11px; opacity: .8; overflow-wrap: anywhere; }

.duStats { display: grid; grid-template-columns: repeat(auto-fit, minmax(132px, 1fr)); gap: 10px; }
.duStat { padding: 10px 12px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 9px;
  background: var(--dsw-alias-bg-layer-2); min-width: 0; }
.duStatKey { font-size: 11px; line-height: 16px; color: var(--dsw-alias-label-secondary); }
.duStatVal { margin-top: 2px; font-size: 19px; line-height: 26px; font-weight: 500;
  font-variant-numeric: tabular-nums; overflow-wrap: anywhere; }
.duStatVal[data-size="small"] { font-size: 13px; line-height: 20px; }

.duCard { border: 1px solid var(--dsw-alias-border-l2); border-radius: 10px; background: var(--dsw-alias-bg-layer-1); }
.duCardHead { display: flex; align-items: center; gap: 10px; padding: 12px 14px 0; flex-wrap: wrap; }
.duCardTitle { font-size: 13px; line-height: 20px; font-weight: 600; }
.duCardHint { padding: 4px 14px 0; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary); }
.duCardBody { padding: 12px 14px 14px; }

.duLadder { display: flex; flex-direction: column; gap: 6px; }
.duRung { display: grid; grid-template-columns: 26px minmax(0, 1fr) auto; align-items: center; gap: 10px;
  padding: 7px 10px; border-radius: 7px; border: 1px solid transparent;
  background: var(--dsw-alias-bg-layer-2); font-size: 12px; line-height: 18px; }
.duRung[data-current="true"] { border-color: color-mix(in srgb, var(--dsw-alias-brand-primary) 45%, transparent); }
.duRungIndex { font-family: var(--dsw-font-family-mono, ui-monospace, monospace); font-size: 11px;
  color: var(--dsw-alias-label-secondary); }
.duRungName { min-width: 0; overflow-wrap: anywhere; }
.duRungNote { font-size: 11px; color: var(--dsw-alias-label-secondary); font-variant-numeric: tabular-nums; }
.duRung[data-layer="plugin"] .duRungName { font-weight: 600; }

.duFields { display: flex; flex-direction: column; }
.duField { display: grid; grid-template-columns: minmax(150px, 240px) minmax(0, 1fr); gap: 4px 16px;
  align-items: start; padding: 11px 0; }
.duField + .duField { border-top: 1px solid var(--dsw-alias-border-l2); }
.duFieldLabel { font-size: 12px; line-height: 20px; font-weight: 500; }
.duFieldHint { font-size: 11px; line-height: 17px; color: var(--dsw-alias-label-secondary); }
.duFieldBody { min-width: 0; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
@media (max-width: 680px) { .duField { grid-template-columns: 1fr; } }

.duInput { font: inherit; font-size: 12px; line-height: 1; min-height: 30px; padding: 0 9px;
  border-radius: 7px; border: 1px solid var(--dsw-alias-border-l2);
  background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary); width: 120px; }
.duInput:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 1px; }
.duInput:disabled { opacity: .5; }
.duInput[data-invalid="true"] { border-color: var(--dsw-alias-state-error-primary); }
.duUnit { font-size: 11px; color: var(--dsw-alias-label-secondary); }

.duSwitch { appearance: none; position: relative; width: 40px; height: 22px; flex: none; padding: 0;
  border-radius: 999px; border: 1px solid var(--dsw-alias-border-l2);
  background: var(--dsw-alias-bg-layer-2); cursor: pointer;
  transition: background .16s ease, border-color .16s ease; }
.duSwitch[aria-checked="true"] { background: var(--dsw-alias-brand-primary); border-color: var(--dsw-alias-brand-primary); }
.duSwitch:disabled { opacity: .5; cursor: not-allowed; }
.duSwitch:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 2px; }
.duSwitch::after { content: ""; position: absolute; top: 50%; left: 3px; width: 14px; height: 14px;
  border-radius: 50%; background: var(--dsw-alias-bg-base); transform: translateY(-50%);
  transition: left .16s ease; box-shadow: 0 1px 2px rgb(0 0 0 / .25); }
.duSwitch[aria-checked="true"]::after { left: 21px; }

.duChips { display: flex; flex-wrap: wrap; gap: 6px; }
.duChip { display: inline-flex; align-items: center; gap: 6px; height: 22px; padding: 0 4px 0 8px;
  border-radius: 999px; border: 1px solid var(--dsw-alias-border-l2);
  background: var(--dsw-alias-bg-layer-2); font-size: 11px; line-height: 1;
  font-family: var(--dsw-font-family-mono, ui-monospace, monospace); }
.duChipX { appearance: none; display: inline-flex; align-items: center; justify-content: center;
  width: 15px; height: 15px; padding: 0; border: 0; border-radius: 50%; cursor: pointer;
  background: transparent; color: var(--dsw-alias-label-secondary); font-size: 13px; line-height: 1; }
.duChipX:hover:not(:disabled) { background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 16%, transparent);
  color: var(--dsw-alias-state-error-primary); }
.duChipX:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 1px; }
.duChipX:disabled { opacity: .4; cursor: not-allowed; }
.duEmptyLine { font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary); }

.duBars { display: flex; flex-direction: column; gap: 7px; }
.duBar { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 10px; align-items: center; font-size: 12px; }
.duBarLabel { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.duBarKey { font-family: var(--dsw-font-family-mono, ui-monospace, monospace); font-size: 11px;
  overflow-wrap: anywhere; }
.duBarTrack { height: 4px; border-radius: 999px; background: var(--dsw-alias-border-l2); overflow: hidden; }
.duBarFill { height: 100%; border-radius: 999px; background: var(--dsw-alias-brand-primary); }
.duBarVal { font-variant-numeric: tabular-nums; color: var(--dsw-alias-label-secondary); font-size: 11px; }

.duGrid2 { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 12px; }

.duTableWrap { overflow-x: auto; }
.duTable { width: 100%; border-collapse: collapse; font-size: 12px; }
.duTable th { text-align: left; font-weight: 500; font-size: 11px; color: var(--dsw-alias-label-secondary);
  padding: 0 12px 6px 0; white-space: nowrap; }
.duTable td { padding: 6px 12px 6px 0; border-top: 1px solid var(--dsw-alias-border-l2);
  font-variant-numeric: tabular-nums; vertical-align: top; }
.duTable th:last-child, .duTable td:last-child { padding-right: 0; }
.duTable td[data-mono="true"] { font-family: var(--dsw-font-family-mono, ui-monospace, monospace); font-size: 11px;
  overflow-wrap: anywhere; }
.duTable td[data-muted="true"] { color: var(--dsw-alias-label-secondary); }

.duFoot { display: flex; align-items: center; justify-content: space-between; gap: 12px;
  padding-top: 14px; border-top: 1px solid var(--dsw-alias-border-l2); flex-wrap: wrap; }
.duFootMeta { font-family: var(--dsw-font-family-mono, ui-monospace, monospace); font-size: 11px;
  color: var(--dsw-alias-label-secondary); }

.duSkeleton { height: 12px; border-radius: 6px;
  background: linear-gradient(90deg, var(--dsw-alias-bg-layer-2), var(--dsw-alias-border-l2), var(--dsw-alias-bg-layer-2));
  background-size: 200% 100%; animation: duPulse 1.3s ease-in-out infinite; }
.duSkeleton + .duSkeleton { margin-top: 8px; }
@keyframes duPulse { 0% { background-position: 200% 0; } 100% { background-position: -200% 0; } }
@media (prefers-reduced-motion: reduce) {
  .duBtn, .duSwitch, .duSwitch::after { transition: none; }
  .duSkeleton { animation: none; }
}
.duSrOnly { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden;
  clip: rect(0 0 0 0); white-space: nowrap; border: 0; }
`;

    // ---------------------------------------------------------------------
    // Transport
    // ---------------------------------------------------------------------
    async function requestJson(url, init) {
      const response = await fetch(url, {
        cache: "no-store",
        credentials: "same-origin",
        headers: { accept: "application/json", ...init?.headers },
        ...init,
      });
      const text = await response.text();
      let payload;
      if (text.length > 0) {
        try {
          payload = JSON.parse(text);
        } catch {
          payload = undefined;
        }
      }
      if (!response.ok) {
        const message = typeof payload?.message === "string" ? payload.message : `HTTP ${response.status}`;
        const error = new Error(message);
        error.code = typeof payload?.code === "string" ? payload.code : `http-${response.status}`;
        error.status = response.status;
        throw error;
      }
      return payload;
    }

    /**
     * One poll loop for the whole page: a single store, many renders.
     *
     * `failedAt` distinguishes "never reached the host" from "reached it once and
     * then lost it", so a transient blip keeps the last known numbers on screen
     * instead of blanking the page.
     */
    class RetryFeed {
      store = createSnapshotStore({
        status: "loading",
        data: null,
        error: null,
        errorCode: null,
        fetchedAt: 0,
        consecutiveFailures: 0,
      });

      timer = null;
      inflight = false;
      disposed = false;

      async load() {
        if (this.inflight || this.disposed) return;
        this.inflight = true;
        try {
          const data = await requestJson(STATS_ENDPOINT, { headers: { accept: "application/json" } });
          if (this.disposed) return;
          this.store.update((state) => {
            state.status = "ready";
            state.data = data;
            state.error = null;
            state.errorCode = null;
            state.fetchedAt = Date.now();
            state.consecutiveFailures = 0;
          });
        } catch (error) {
          if (this.disposed) return;
          this.store.update((state) => {
            state.status = "error";
            state.error = String(error?.message ?? error);
            state.errorCode = typeof error?.code === "string" ? error.code : null;
            state.fetchedAt = Date.now();
            state.consecutiveFailures = (state.consecutiveFailures ?? 0) + 1;
          });
        } finally {
          this.inflight = false;
        }
      }

      start() {
        if (this.timer !== null || this.disposed) return;
        void this.load();
        this.timer = setInterval(() => {
          void this.load();
        }, POLL_MS);
      }

      stop() {
        this.disposed = true;
        if (this.timer !== null) clearInterval(this.timer);
        this.timer = null;
      }
    }

    // ---------------------------------------------------------------------
    // Controls
    // ---------------------------------------------------------------------
    function Switch({ id, checked, disabled, onChange, label, hint }) {
      const labelId = `${id}-label`;
      const hintId = `${id}-hint`;
      return React.createElement("div", {
        style: { display: "flex", alignItems: "flex-start", gap: 10 },
      }, [
        React.createElement("button", {
          key: "switch",
          type: "button",
          role: "switch",
          id,
          className: "duSwitch",
          "aria-checked": checked === true,
          "aria-labelledby": labelId,
          "aria-describedby": hint === undefined ? undefined : hintId,
          disabled: disabled === true,
          onClick: () => onChange(checked !== true),
        }),
        React.createElement("div", { key: "text", style: { minWidth: 0 } }, [
          React.createElement("div", { key: "l", className: "duFieldLabel", id: labelId }, label),
          hint === undefined
            ? null
            : React.createElement("div", { key: "h", className: "duFieldHint", id: hintId }, hint),
        ]),
      ]);
    }

    function Field({ id, label, hint, children }) {
      return React.createElement("div", { className: "duField" }, [
        React.createElement("div", { key: "label" }, [
          React.createElement("label", { key: "l", className: "duFieldLabel", htmlFor: id }, label),
          hint === undefined
            ? null
            : React.createElement("div", { key: "h", className: "duFieldHint" }, hint),
        ]),
        React.createElement("div", { key: "body", className: "duFieldBody" }, children),
      ]);
    }

    function Stat({ label, value, small }) {
      return React.createElement("div", { className: "duStat" }, [
        React.createElement("div", { key: "k", className: "duStatKey" }, label),
        React.createElement("div", {
          key: "v",
          className: "duStatVal",
          "data-size": small === true ? "small" : undefined,
        }, value),
      ]);
    }

    function Notice({ tone, children, detail, onDismiss, dismissLabel }) {
      return React.createElement("div", { className: "duNotice", "data-tone": tone, role: tone === "error" ? "alert" : "status" }, [
        React.createElement("div", { key: "b", className: "duNoticeBody" }, [
          React.createElement("div", { key: "t" }, children),
          detail === undefined || detail === null
            ? null
            : React.createElement("div", { key: "d", className: "duNoticeDetail" }, detail),
        ]),
        onDismiss === undefined
          ? null
          : React.createElement("button", {
              key: "x",
              type: "button",
              className: "duBtn",
              "data-variant": "quiet",
              "data-size": "tiny",
              onClick: onDismiss,
              children: dismissLabel,
            }),
      ]);
    }

    function Bars({ title, hint, rows, emptyText }) {
      const max = rows.reduce((peak, row) => Math.max(peak, row.count), 0);
      return React.createElement("div", { className: "duCard" }, [
        React.createElement("div", { key: "h", className: "duCardHead" }, [
          React.createElement("div", { key: "t", className: "duCardTitle" }, title),
        ]),
        hint === undefined ? null : React.createElement("div", { key: "hint", className: "duCardHint" }, hint),
        React.createElement("div", { key: "b", className: "duCardBody" },
          rows.length === 0
            ? React.createElement("div", { className: "duEmptyLine" }, emptyText)
            : React.createElement("div", { className: "duBars" }, rows.slice(0, 10).map((row) =>
                React.createElement("div", { key: row.key, className: "duBar" }, [
                  React.createElement("div", { key: "l", className: "duBarLabel" }, [
                    React.createElement("div", { key: "k", className: "duBarKey" }, row.label),
                    React.createElement("div", { key: "t", className: "duBarTrack" },
                      React.createElement("div", {
                        className: "duBarFill",
                        style: { width: `${max === 0 ? 0 : Math.max(2, (row.count / max) * 100)}%` },
                      }),
                    ),
                  ]),
                  React.createElement("div", { key: "v", className: "duBarVal" }, row.display),
                ]),
              )),
        ),
      ]);
    }

    // ---------------------------------------------------------------------
    // Page
    // ---------------------------------------------------------------------
    function RetryPanel({ t, feed, useFeed }) {
      const state = useFeed((value) => value);
      const fmt = React.useMemo(() => makeFormat(t), [t]);
      const [draft, setDraft] = React.useState(null);
      const [codeInput, setCodeInput] = React.useState("");
      const [codeError, setCodeError] = React.useState(null);
      const [pending, setPending] = React.useState(false);
      const [outcome, setOutcome] = React.useState(null);
      const [confirmReset, setConfirmReset] = React.useState(false);
      const [now, setNow] = React.useState(() => Date.now());
      const hostConfigRef = React.useRef(null);

      React.useEffect(() => {
        feed.start();
        return () => feed.stop();
      }, [feed]);

      // Relative timestamps need a clock, but re-rendering the whole page once a
      // second is wasteful; five seconds is well under the poll interval.
      React.useEffect(() => {
        const timer = setInterval(() => setNow(Date.now()), 5000);
        return () => clearInterval(timer);
      }, []);

      const data = state.data;
      const serverConfig = data?.config ?? null;

      // Adopt the host config as the draft baseline only when it actually
      // changed: a poll must never overwrite what the user is editing.
      React.useEffect(() => {
        if (serverConfig === null) return;
        const key = JSON.stringify(serverConfig);
        if (hostConfigRef.current === key) return;
        hostConfigRef.current = key;
        setDraft(serverConfig);
      }, [serverConfig === null ? null : JSON.stringify(serverConfig)]);

      const capabilities = data?.capabilities ?? {};
      const writable = capabilities.canWriteConfig === true;
      const dirty = draft !== null && serverConfig !== null && JSON.stringify(draft) !== JSON.stringify(serverConfig);

      const patch = React.useCallback((changes) => {
        setOutcome(null);
        setDraft((current) => (current === null ? current : { ...current, ...changes }));
      }, []);

      const submit = React.useCallback(async () => {
        if (draft === null) return;
        const body = {
          autoRetry: draft.autoRetry,
          maxAttempts: draft.maxAttempts,
          initialDelayMs: draft.initialDelayMs,
          maxDelayMs: draft.maxDelayMs,
          jitterRatio: draft.jitterRatio,
          retryWithoutProviderPolicy: draft.retryWithoutProviderPolicy,
          excludeCodes: draft.excludeCodes,
          recordSessionEvents: draft.recordSessionEvents,
        };
        setPending(true);
        setOutcome(null);
        try {
          await requestJson(CONFIG_ENDPOINT, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
          });
          // The write reloads the host half; the next poll carries the applied
          // values, so the banner is cleared by the user or by the next edit.
          setOutcome({ tone: "ok", text: t("saved") });
          hostConfigRef.current = null;
          void feed.load();
        } catch (error) {
          setOutcome({
            tone: "error",
            text: `${t("saveFailed")}: ${String(error?.message ?? error)}`,
          });
        } finally {
          setPending(false);
        }
      }, [draft, feed, t]);

      const reset = React.useCallback(async () => {
        setPending(true);
        try {
          await requestJson(RESET_ENDPOINT, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ confirm: true }),
          });
          setOutcome({ tone: "ok", text: t("resetDone") });
          setConfirmReset(false);
          void feed.load();
        } catch (error) {
          setOutcome({ tone: "error", text: String(error?.message ?? error) });
        } finally {
          setPending(false);
        }
      }, [feed, t]);

      const addCode = React.useCallback(() => {
        const code = codeInput.trim();
        if (code.length === 0) {
          setCodeError(t("excludeUnknown"));
          return;
        }
        if (draft !== null && Array.isArray(draft.excludeCodes) && draft.excludeCodes.includes(code)) {
          setCodeError(fmt.fill(t("excludeDuplicate"), { code }));
          return;
        }
        setCodeError(null);
        setCodeInput("");
        patch({ excludeCodes: [...(draft?.excludeCodes ?? []), code] });
      }, [codeInput, draft, fmt, patch, t]);

      const styleTag = React.createElement("style", { key: "css", children: CSS });

      const heading = React.createElement("div", { className: "duHead", key: "head" }, [
        React.createElement("div", { key: "text", className: "duHeadText" }, [
          React.createElement("div", { key: "row", className: "duTitleRow" }, [
            React.createElement("span", { key: "t", className: "duTitle" }, t("title")),
            state.status === "ready"
              ? React.createElement("span", { key: "p", className: "duPill", "data-tone": "live" }, t("statusLive"))
              : state.status === "error"
                ? React.createElement("span", { key: "p", className: "duPill", "data-tone": "error" }, t("statusError"))
                : React.createElement("span", { key: "p", className: "duPill" }, t("statusLoading")),
            dirty
              ? React.createElement("span", { key: "d", className: "duPill", "data-tone": "dirty" }, t("unsaved"))
              : null,
          ]),
          React.createElement("div", { key: "s", className: "duSub" }, t("subtitle")),
        ]),
        React.createElement("div", { key: "actions", className: "duHeadActions" }, [
          React.createElement("button", {
            key: "refresh",
            type: "button",
            className: "duBtn",
            onClick: () => {
              void feed.load();
            },
            children: t("refresh"),
          }),
          dirty
            ? React.createElement("button", {
                key: "discard",
                type: "button",
                className: "duBtn",
                "data-variant": "quiet",
                disabled: pending || !writable,
                onClick: () => {
                  setOutcome(null);
                  hostConfigRef.current = null;
                  setDraft(serverConfig);
                },
                children: t("discard"),
              })
            : null,
          dirty
            ? React.createElement("button", {
                key: "save",
                type: "button",
                className: "duBtn",
                "data-variant": "primary",
                disabled: pending || !writable,
                onClick: () => {
                  void submit();
                },
                children: pending ? t("saving") : t("save"),
              })
            : null,
        ]),
      ]);

      const notices = [];
      if (state.status === "error") {
        // A config write reloads the host half, so one failed poll right after a
        // successful save is the reload itself, not an outage. Only a failure
        // that outlives a few polls is reported as unreachable.
        const recovering = outcome?.tone === "ok" || state.consecutiveFailures < 3;
        if (!recovering) {
          notices.push(React.createElement(Notice, {
            key: "net",
            tone: "error",
            detail: state.error,
            children: t("unreachable"),
          }));
        }
      }
      if (outcome !== null) {
        notices.push(React.createElement(Notice, {
          key: "outcome",
          tone: outcome.tone,
          onDismiss: () => setOutcome(null),
          dismissLabel: "×",
          children: outcome.text,
        }));
      }
      if (data !== null && !writable) {
        notices.push(React.createElement(Notice, {
          key: "readonly",
          tone: "muted",
          children: capabilities.canWriteConfig === false ? t("readOnly") : t("noRow"),
        }));
      }

      // Loading and hard-failure states keep the page chrome and skip the data.
      if (data === null) {
        return React.createElement("div", { className: "duRoot" }, [
          styleTag,
          heading,
          ...notices,
          React.createElement("div", { key: "card", className: "duCard" },
            React.createElement("div", { className: "duCardBody" },
              React.createElement("div", { className: "duSkeleton", style: { width: "42%" } }),
              React.createElement("div", { className: "duSkeleton", style: { width: "68%" } }),
              React.createElement("div", { className: "duSkeleton", style: { width: "55%" } }),
              React.createElement("div", {
                style: { marginTop: 12, fontSize: 12, color: "var(--dsw-alias-label-secondary)" },
              }, state.status === "error" ? t("unreachable") : t("loadingBody")),
            ),
          ),
        ]);
      }

      const stats = data.stats ?? {};
      const config = draft ?? serverConfig ?? {};
      const excluded = Array.isArray(config.excludeCodes) ? config.excludeCodes : [];
      const providerRung = data.ladder?.[0] ?? null;
      const maxLabel = fmt.duration(config.maxDelayMs);
      const unlimited = config.maxAttempts === null || config.maxAttempts === undefined;

      const ladderRungs = [];
      // The provider's own budget is not knowable from here, so the first rung
      // states what is certain: the earlier layers answer first, this plugin
      // answers after them.
      ladderRungs.push(React.createElement("div", {
        key: "rung-provider",
        className: "duRung",
        "data-layer": "provider",
      }, [
        React.createElement("span", { key: "i", className: "duRungIndex" }, "1"),
        React.createElement("span", { key: "n", className: "duRungName" }, t("ladderProvider")),
        React.createElement("span", { key: "note", className: "duRungNote" }, t("ladderTerminal")),
      ]));
      ladderRungs.push(React.createElement("div", {
        key: "rung-plugin",
        className: "duRung",
        "data-layer": "plugin",
        "data-current": "true",
      }, [
        React.createElement("span", { key: "i", className: "duRungIndex" }, "2"),
        React.createElement("span", { key: "n", className: "duRungName" }, t("ladderPlugin")),
        React.createElement("span", { key: "note", className: "duRungNote" },
          unlimited ? t("unlimited") : fmt.fill(t("ladderCap"), { n: config.maxAttempts })),
      ]));
      ladderRungs.push(React.createElement("div", {
        key: "rung-beyond",
        className: "duRung",
        "data-layer": "plugin",
      }, [
        React.createElement("span", { key: "i", className: "duRungIndex" }, "…"),
        React.createElement("span", { key: "n", className: "duRungName" },
          fmt.fill(t("ladderBeyond"), { max: maxLabel })),
        React.createElement("span", { key: "note", className: "duRungNote" },
          providerRung === null ? "" : fmt.duration(providerRung.delayMs)),
      ]));

      const policyCard = React.createElement("div", { key: "policy", className: "duCard" }, [
        React.createElement("div", { key: "h", className: "duCardHead" }, [
          React.createElement("div", { key: "t", className: "duCardTitle" }, t("policyTitle")),
        ]),
        React.createElement("div", { key: "hint", className: "duCardHint" }, t("policyHint")),
        React.createElement("div", { key: "b", className: "duCardBody" },
          React.createElement("div", { className: "duFields" }, [
            React.createElement("div", { key: "enabled", className: "duField" }, [
              React.createElement("div", { key: "l", className: "duFieldLabel" }, t("enabled")),
              React.createElement("div", { key: "b", className: "duFieldBody" },
                React.createElement(Switch, {
                  id: "du-enabled",
                  checked: config.autoRetry === true,
                  disabled: !writable || pending,
                  onChange: (next) => patch({ autoRetry: next }),
                  label: t("enabled"),
                  hint: t("enabledHint"),
                }),
              ),
            ]),

            React.createElement(Field, {
              key: "attempts",
              id: "du-max-attempts",
              label: t("maxAttempts"),
              hint: t("maxAttemptsHint"),
            }, [
              React.createElement("input", {
                key: "i",
                id: "du-max-attempts",
                className: "duInput",
                type: "number",
                min: 1,
                step: 1,
                inputMode: "numeric",
                placeholder: t("unlimited"),
                disabled: !writable || pending || config.autoRetry !== true,
                value: config.maxAttempts === null || config.maxAttempts === undefined ? "" : String(config.maxAttempts),
                onChange: (event) => {
                  const raw = event.target.value.trim();
                  patch({ maxAttempts: raw.length === 0 ? null : Math.max(1, Math.trunc(Number(raw) || 1)) });
                },
              }),
              React.createElement("span", { key: "u", className: "duUnit" },
                unlimited ? t("unlimited") : ""),
            ]),

            React.createElement(Field, {
              key: "initial",
              id: "du-initial-delay",
              label: t("initialDelay"),
            }, [
              React.createElement("input", {
                key: "i",
                id: "du-initial-delay",
                className: "duInput",
                type: "number",
                min: 1,
                step: 100,
                inputMode: "numeric",
                disabled: !writable || pending || config.autoRetry !== true,
                value: String(config.initialDelayMs ?? ""),
                onChange: (event) => {
                  const parsed = Math.max(1, Math.trunc(Number(event.target.value) || 1));
                  patch({ initialDelayMs: parsed });
                },
              }),
              React.createElement("span", { key: "u", className: "duUnit" }, "ms"),
            ]),

            React.createElement(Field, {
              key: "ceiling",
              id: "du-max-delay",
              label: t("maxDelay"),
            }, [
              React.createElement("input", {
                key: "i",
                id: "du-max-delay",
                className: "duInput",
                type: "number",
                min: 1,
                step: 1000,
                inputMode: "numeric",
                disabled: !writable || pending || config.autoRetry !== true,
                value: String(config.maxDelayMs ?? ""),
                onChange: (event) => {
                  const parsed = Math.max(1, Math.trunc(Number(event.target.value) || 1));
                  patch({ maxDelayMs: parsed });
                },
              }),
              React.createElement("span", { key: "u", className: "duUnit" }, "ms"),
            ]),

            React.createElement(Field, {
              key: "jitter",
              id: "du-jitter",
              label: t("jitter"),
              hint: t("jitterHint"),
            }, [
              React.createElement("input", {
                key: "i",
                id: "du-jitter",
                className: "duInput",
                type: "number",
                min: 0,
                max: 100,
                step: 1,
                inputMode: "numeric",
                disabled: !writable || pending || config.autoRetry !== true,
                value: String(Math.round((config.jitterRatio ?? 0) * 100)),
                onChange: (event) => {
                  const parsed = Math.min(100, Math.max(0, Math.trunc(Number(event.target.value) || 0)));
                  patch({ jitterRatio: parsed / 100 });
                },
              }),
              React.createElement("span", { key: "u", className: "duUnit" }, "%"),
            ]),

            React.createElement("div", { key: "without", className: "duField" }, [
              React.createElement("div", { key: "l", className: "duFieldLabel" }, t("withoutPolicy")),
              React.createElement("div", { key: "b", className: "duFieldBody" },
                React.createElement(Switch, {
                  id: "du-without-policy",
                  checked: config.retryWithoutProviderPolicy === true,
                  disabled: !writable || pending,
                  onChange: (next) => patch({ retryWithoutProviderPolicy: next }),
                  label: t("withoutPolicy"),
                  hint: t("withoutPolicyHint"),
                }),
              ),
            ]),

            React.createElement("div", { key: "events", className: "duField" }, [
              React.createElement("div", { key: "l", className: "duFieldLabel" }, t("recordEvents")),
              React.createElement("div", { key: "b", className: "duFieldBody" },
                React.createElement(Switch, {
                  id: "du-record-events",
                  checked: config.recordSessionEvents === true,
                  disabled: !writable || pending,
                  onChange: (next) => patch({ recordSessionEvents: next }),
                  label: t("recordEvents"),
                  hint: t("recordEventsHint"),
                }),
              ),
            ]),

            React.createElement("div", { key: "codes", className: "duField" }, [
              React.createElement("div", { key: "l" }, [
                React.createElement("div", { key: "t", className: "duFieldLabel" }, t("excludeTitle")),
                React.createElement("div", { key: "h", className: "duFieldHint" }, t("excludeHint")),
              ]),
              React.createElement("div", { key: "b", className: "duFieldBody", style: { flexDirection: "column", alignItems: "stretch" } }, [
                React.createElement("div", { key: "locked", className: "duEmptyLine" },
                  fmt.fill(t("alwaysTerminal"), {
                    codes: (data.alwaysTerminalCodes ?? []).join(", "),
                  })),
                excluded.length === 0
                  ? React.createElement("div", { key: "empty", className: "duEmptyLine" }, t("excludeEmpty"))
                  : React.createElement("div", { key: "chips", className: "duChips" }, excluded.map((code) =>
                      React.createElement("span", { key: code, className: "duChip" }, [
                        code,
                        React.createElement("button", {
                          key: "x",
                          type: "button",
                          className: "duChipX",
                          "aria-label": fmt.fill(t("excludeRemove"), { code }),
                          title: fmt.fill(t("excludeRemove"), { code }),
                          disabled: !writable || pending,
                          onClick: () => patch({ excludeCodes: excluded.filter((entry) => entry !== code) }),
                          children: "×",
                        }),
                      ]),
                    )),
                React.createElement("div", {
                  key: "add",
                  style: { display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center", marginTop: 4 },
                }, [
                  React.createElement("input", {
                    key: "input",
                    className: "duInput",
                    type: "text",
                    list: "du-code-options",
                    "aria-label": t("excludeAdd"),
                    placeholder: t("excludePlaceholder"),
                    disabled: !writable || pending,
                    value: codeInput,
                    onChange: (event) => {
                      setCodeError(null);
                      setCodeInput(event.target.value);
                    },
                    onKeyDown: (event) => {
                      if (event.key !== "Enter") return;
                      event.preventDefault();
                      addCode();
                    },
                  }),
                  // Suggested from the codes the Harness itself can produce; the
                  // field stays free text because providers add their own.
                  React.createElement("datalist", { key: "codes", id: "du-code-options" },
                    (data.knownFailureCodes ?? []).map((code) =>
                      React.createElement("option", { key: code, value: code }))),
                  React.createElement("button", {
                    key: "add-btn",
                    type: "button",
                    className: "duBtn",
                    disabled: !writable || pending || codeInput.trim().length === 0,
                    onClick: addCode,
                    children: t("excludeAddAction"),
                  }),
                  React.createElement("button", {
                    key: "preset",
                    type: "button",
                    className: "duBtn",
                    "data-variant": "quiet",
                    disabled: !writable || pending,
                    onClick: () => patch({ excludeCodes: [...(data.recommendedExclude ?? [])] }),
                    children: t("excludePreset"),
                  }),
                  excluded.length === 0
                    ? null
                    : React.createElement("button", {
                        key: "clear",
                        type: "button",
                        className: "duBtn",
                        "data-variant": "quiet",
                        disabled: !writable || pending,
                        onClick: () => patch({ excludeCodes: [] }),
                        children: t("excludeClear"),
                      }),
                ]),
                codeError === null
                  ? null
                  : React.createElement("div", {
                      key: "err",
                      style: { fontSize: 11, lineHeight: "17px", color: "var(--dsw-alias-state-error-primary)" },
                      role: "alert",
                    }, codeError),
              ]),
            ]),
          ]),
        ),
      ]);

      const codeRows = (stats.byCode ?? []).map((row) => ({
        key: row.code,
        label: row.code,
        count: row.count,
        display: fmt.count(row.count),
      }));
      const providerRows = (stats.byProvider ?? []).map((row) => ({
        key: row.provider,
        label: row.provider,
        count: row.count,
        display: fmt.count(row.count),
      }));
      const terminalRows = (stats.terminalSeen ?? []).map((row) => ({
        key: row.code,
        label: row.code,
        count: row.count,
        display: fmt.count(row.count),
      }));

      const recent = Array.isArray(stats.recent) ? stats.recent : [];

      return React.createElement("div", { className: "duRoot" }, [
        styleTag,
        heading,
        ...notices,

        React.createElement("div", { key: "stats", className: "duStats" }, [
          React.createElement(Stat, {
            key: "total",
            label: t("total"),
            value: fmt.count(stats.totalRetries ?? 0),
          }),
          React.createElement(Stat, {
            key: "active",
            label: t("active"),
            value: fmt.count(stats.activeWaits ?? 0),
          }),
          React.createElement(Stat, {
            key: "sessions",
            label: t("sessions"),
            value: fmt.count(stats.sessionsRetrying ?? 0),
          }),
          React.createElement(Stat, {
            key: "last",
            label: t("lastAt"),
            small: true,
            value: stats.lastRetryAt === null || stats.lastRetryAt === undefined
              ? t("never")
              : `${stats.lastCode ?? "—"} · ${fmt.relative(stats.lastRetryAt, now)}`,
          }),          React.createElement(Stat, {
            key: "uptime",
            label: t("uptime"),
            small: true,
            value: fmt.duration(data.plugin?.uptimeMs ?? 0),
          }),
        ]),

        React.createElement("div", { key: "ladder", className: "duCard" }, [
          React.createElement("div", { key: "h", className: "duCardHead" }, [
            React.createElement("div", { key: "t", className: "duCardTitle" }, t("ladderTitle")),
          ]),
          React.createElement("div", { key: "hint", className: "duCardHint" }, t("ladderHint")),
          React.createElement("div", { key: "b", className: "duCardBody" }, [
            React.createElement("div", { key: "rungs", className: "duLadder" }, ladderRungs),
            excluded.length === 0
              ? null
              : React.createElement("div", {
                  key: "terminal",
                  className: "duFieldHint",
                  style: { marginTop: 10 },
                }, t("ladderTerminalHint")),
          ]),
        ]),

        policyCard,

        React.createElement("div", { key: "dist", className: "duGrid2" }, [
          React.createElement(Bars, {
            key: "bycode",
            title: t("byCode"),
            rows: codeRows,
            emptyText: t("recentEmpty"),
          }),
          React.createElement(Bars, {
            key: "byprovider",
            title: t("byProvider"),
            rows: providerRows,
            emptyText: t("recentEmpty"),
          }),
        ]),

        terminalRows.length === 0
          ? null
          : React.createElement(Bars, {
              key: "terminal-seen",
              title: t("terminalSeen"),
              hint: t("terminalSeenHint"),
              rows: terminalRows,
              emptyText: t("recentEmpty"),
            }),

        React.createElement("div", { key: "recent", className: "duCard" }, [
          React.createElement("div", { key: "h", className: "duCardHead" }, [
            React.createElement("div", { key: "t", className: "duCardTitle" }, t("recentTitle")),
          ]),
          React.createElement("div", { key: "b", className: "duCardBody" },
            recent.length === 0
              ? React.createElement("div", { className: "duEmptyLine" }, t("recentEmpty"))
              : React.createElement("div", { className: "duTableWrap" },
                  React.createElement("table", { className: "duTable" }, [
                    React.createElement("thead", { key: "head" },
                      React.createElement("tr", null, [
                        React.createElement("th", { key: "a", scope: "col" }, t("colAttempt")),
                        React.createElement("th", { key: "c", scope: "col" }, t("colCode")),
                        React.createElement("th", { key: "p", scope: "col" }, t("colProvider")),
                        React.createElement("th", { key: "d", scope: "col" }, t("colDelay")),
                        React.createElement("th", { key: "w", scope: "col" }, t("colWhen")),
                      ]),
                    ),
                    React.createElement("tbody", { key: "body" }, recent.map((row, index) =>
                      React.createElement("tr", { key: `${row.at}-${index}` }, [
                        React.createElement("td", { key: "a", "data-mono": "true" }, String(row.attempt)),
                        React.createElement("td", { key: "c", "data-mono": "true" }, row.code),
                        React.createElement("td", { key: "p", "data-mono": "true" }, row.provider),
                        React.createElement("td", { key: "d" }, fmt.duration(row.delayMs)),
                        React.createElement("td", {
                          key: "w",
                          "data-muted": "true",
                          title: fmt.clock(row.at),
                        }, fmt.relative(row.at, now)),
                      ]),
                    )),
                  ]),
                ),
          ),
        ]),

        React.createElement("div", { key: "counters", className: "duCard" }, [
          React.createElement("div", { key: "h", className: "duCardHead" }, [
            React.createElement("div", { key: "t", className: "duCardTitle" }, t("countersTitle")),
          ]),
          React.createElement("div", { key: "hint", className: "duCardHint" }, t("countersHint")),
          React.createElement("div", { key: "b", className: "duCardBody" }, [
            React.createElement("div", {
              key: "mounts",
              style: { fontSize: 12, lineHeight: "18px", color: "var(--dsw-alias-label-secondary)", marginBottom: 10 },
            }, `${t("mounts")}: ${fmt.count(data.plugin?.mounts ?? 0)}`),
            confirmReset
              ? React.createElement("div", {
                  key: "confirm",
                  style: { display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" },
                  role: "group",
                  "aria-label": t("resetConfirm"),
                }, [
                  React.createElement("span", { key: "q", style: { fontSize: 12 } }, t("resetConfirm")),
                  React.createElement("button", {
                    key: "yes",
                    type: "button",
                    className: "duBtn",
                    disabled: pending,
                    onClick: () => {
                      void reset();
                    },
                    children: pending ? t("saving") : t("resetYes"),
                  }),
                  React.createElement("button", {
                    key: "no",
                    type: "button",
                    className: "duBtn",
                    "data-variant": "quiet",
                    onClick: () => setConfirmReset(false),
                    children: t("resetNo"),
                  }),
                ])
              : React.createElement("button", {
                  key: "reset",
                  type: "button",
                  className: "duBtn",
                  disabled: !writable || pending,
                  onClick: () => setConfirmReset(true),
                  children: t("reset"),
                }),
          ]),
        ]),

        React.createElement("div", { key: "foot", className: "duFoot" }, [
          React.createElement("span", { key: "meta", className: "duFootMeta" },
            fmt.fill(t("footer"), {
              version: data.plugin?.version ?? "—",
              pid: data.plugin?.pid ?? "—",
            })),
        ]),
      ]);
    }

    // ---------------------------------------------------------------------
    // Registration
    // ---------------------------------------------------------------------
    const inject = ["slots", "locale"];

    function apply(ctx) {
      const t = ctx.locale.bind(NS);
      ctx.effect(() => ctx.locale.register(NS, { en, zh }), "unlimited-retry: dictionaries");

      const feed = new RetryFeed();
      ctx.effect(() => () => feed.stop(), "unlimited-retry: stop polling");

      ctx.effect(() => ctx.slots.inject("settings.section", () => ctx.slots.register({
        name: "settings.section",
        id: "unlimited-retry",
        order: 35,
        label: () => t("nav"),
        locale: NS,
        inject: () => ({ hooks: { feed: feed.store }, feed }),
      }, RetryPanel)), "unlimited-retry: settings page");
    }

    exports.NS = NS;
    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
