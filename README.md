# dsh-unlimited-retry

Unbounded model-request retry for the DeepSeek Harness agent loop, with a live
Settings panel.

[中文说明](README.zh.md)

A long unattended run should not die because one request hit a transient
network error. This plugin keeps such a request retrying, with exponential
backoff and a delay ceiling, until it succeeds or you tell it to stop.

## Why a separate plugin

`@deepseek-ai/dsh-llm-retry` ships with the Harness and it only *executes*
retries — the budget itself lives on each provider adapter's `retryPolicy`. Its
default `mode: "normal"` stops after `maxRetries` (5 in the stock composition)
and then delegates, so the step fails, the turn closes with an error, and the
run ends. `mode: "always"` exists but it is all-or-nothing per provider and has
no delay ceiling.

This plugin adds a layer *behind* all of them. `agent/request-error` is a
waterfall event and Cordis runs listeners outermost-first, so the
last-registered listener is the deepest: every other recovery gets the first
word, and only a failure that nobody recovered reaches this plugin.

## The retry ladder

With the stock 5-retry provider policy the effective order is:

| Attempt | Handled by | Behaviour |
| --- | --- | --- |
| 1 – 5 | the provider's `retryPolicy` | Its own budget, codes, and delays |
| 6 – ∞ | **this plugin** | Exponential backoff with jitter, capped at `maxDelayMs` |

Other layers that register on the same event — context-overflow compaction,
image offload, any other retry plugin — sit ahead of this one too. That ordering
is the entire reason this plugin registers itself last, and it is what keeps the
provider's own policy authoritative.

## Install

Install the directory as a bundle in the active profile:

```
plugin_manager install_bundle  target: /absolute/path/to/dsh-unlimited-retry
```

Do not copy files into the profile or hand-edit `cordis.patch.yml`: the bundle
installer performs package installation and bundle selection, and it is the only
path that keeps the profile's own package manifest consistent.

After installation, open **Settings → Retry** to see the live panel.

## The panel

The Settings page is a real view of the running policy, not a static form:

- **Live status** — a pill shows whether the host half answers, and the page
  keeps the last known numbers on screen through a transient poll failure
  instead of blanking.
- **Counters** — total retries, waits in flight, sessions currently retrying,
  the last retry, and uptime. Counters are process-wide, so a config write
  (which reloads the host half) does not reset the numbers you are reading.
- **Effective ladder** — what happens on each attempt, including an honest
  `No limit` instead of a fabricated cap.
- **Breakdown** — retries per failure code and per provider, plus the failures
  this plugin declined because their code is terminal.
- **Recent retries** — attempt number, code, provider, delay, and when, with
  relative times.
- **Policy editor** — switches and numbers that write straight back to the
  profile patch layer through the Harness `configEditor`, so changes survive a
  restart and hot-reload the host half.
- **Terminal codes** — add codes one at a time, or apply the recommended set in
  one click (see below).
- **Reset counters** — behind an explicit confirmation.

The panel uses only `--dsw-alias-*` theme tokens, so light/dark and future
rethemes follow automatically. Switches are real `role="switch"` controls with
`aria-checked`, and the page uses no DOM outside its own component tree.

## Defaults, and what they cost

```yaml
autoRetry: true
maxAttempts: null        # no attempt limit
initialDelayMs: 1000
maxDelayMs: 60000
jitterRatio: 0.2
retryWithoutProviderPolicy: true
excludeCodes: []         # no configured code is terminal (ABORTED always is)
recordSessionEvents: true
log: true
```

**No configured failure code is terminal by default — including auth, quota,
billing, and context-overflow codes.** That is what *unlimited* means here, and
it is announced once at mount so it is a visible decision rather than a silent
spend. The only bound is `maxDelayMs`, so a permanently failing request costs
roughly one request per minute, forever.

One code is terminal regardless of configuration: **`ABORTED`**. A cancellation
is not a fault — the turn was stopped, or the process is shutting down. `dsh-llm`
reports an `aborted` finish when `signal.aborted || code === "ABORTED"`, which
means an `ABORTED` failure can arrive while the loop's own signal is still live.
Retrying it would re-run work you just cancelled, so the guard is applied before
`excludeCodes` and clearing that list does not re-enable it. Code matching is
case-insensitive and whitespace-trimmed on both sides, so `Aborted`, `ABORTED`
and ` aborted ` are the same code.

Two ways to bound it:

1. **Set `maxAttempts`** to a positive integer — this plugin then stops after
   that many tries per step and delegates, exactly as if it were not installed.
2. **List terminal codes in `excludeCodes`.** The panel has a one-click
   *Use recommended set* action for the codes where a retry re-sends a request
   that fails identically:

   `AUTH`, `UNAUTHORIZED`, `FORBIDDEN`, `BILLING`, `QUOTA`, `ACCOUNT_QUOTA`,
   `MISSING_CREDENTIAL`, `INVALID_CREDENTIAL`, `MODEL_NOT_FOUND`, `NO_ADAPTER`,
   `CONTEXT_WINDOW_EXCEEDED`, `CONTEXT_OVERFLOW`, `CONTEXT_LENGTH`,
   `INVALID_REQUEST`

A provider-requested delay (`providerRetryAfterMs`) is honoured, but it is
clamped by `maxDelayMs` so one provider cannot park the run indefinitely.

## Durable events

Each scheduled retry appends:

1. `llm/retry` — **before** the wait, so the log shows a wait that really
   happened;
2. `llm/retry-started` — **after** the wait, when the request is actually
   re-sent.

A retry cancelled by an abort or a plugin unload therefore leaves a
`llm/retry` record with no matching `llm/retry-started`, which is exactly what
happened. Setting `recordSessionEvents: false` suppresses both.

`mode` is recorded as `always` so the chat surface renders the budget as
unbounded. `policyKey` is the fixed namespace `unlimited-retry`, which cannot
collide with a provider budget.

## Configuration

Edit the `config` block on the `unlimited-retry` row, or use the panel. An
override anywhere above the bundle patch replaces the **whole** `config`, so a
layer that overrides this row must restate every field it wants to keep.

The plugin also exports a `Config` schema, so its fields appear in
`Config.listConfigs` and can be validated by the Loader.

## HTTP endpoints

The host half adds three routes. They are registered through the Harness Web
server and therefore apply the same browser admission check the rest of the
composition uses: an unauthenticated browser request gets `401`, a request from
an untrusted origin gets `403`. Unlike a plain route handler, these do not
silently bypass the cookie gate.

| Route | Method | Purpose |
| --- | --- | --- |
| `/unlimited-retry/stats` | `GET`, `HEAD` | The read model the panel renders |
| `/unlimited-retry/config` | `POST` | Validate and persist a policy change |
| `/unlimited-retry/reset` | `POST` | Clear the counters (`{"confirm": true}` required) |

Writes are refused with `403` when the composition exposes no admission
service, and with `409` when the row is not addressable or there is no
`configEditor`. Bodies are capped at 8 KiB and must be `application/json`.

These routes are a convenience for the panel. The retry behaviour itself never
depends on them, so a headless or ACP composition mounts the policy with no
routes at all.

### Any mode, any composition

The retry policy is a Host plugin, so it applies to every session the profile
starts, under every preset, and in a headless or ACP composition with no Web
server at all. The plugin registers one `agent/request-error` listener and
nothing else is required; the panel is a separate, optional surface.

Verified against the shipped contracts, not just a stub:

- the real Cordis dispatcher, with sibling agents under one composition, each
  keeping its own ladder;
- the real session-projection service, including a resumed cell replayed from
  the session log;
- an agent mounted inside a preset scope, where the listener is scope-tagged;
- a composition with no `webServer`, no `connection` and no `configEditor`,
  which still retries and simply has no panel.

What it does **not** do: retry a request the provider adapter never admitted, or
one that fails before the agent loop has a turn — those never reach
`agent/request-error`. `ABORTED` is declined by design.

## Verify

```bash
cd dsh-unlimited-retry
node --test test/
```

The suite covers the retry decision path against a fake context (delegation,
exclusion, attempt limits, provider delays, abort, dispose, per-step reset,
legacy config keys), every endpoint (status codes, `HEAD`, admission, body
validation, unknown keys, preset writes, reset confirmation), the client bundle
(registration, i18n parity, rendering, error/empty/read-only states, token-only
styling), and the package shape (manifest, patch, locales, icon, license).

To verify a live mount:

```bash
curl -s http://127.0.0.1:3080/unlimited-retry/stats | head -c 400
```

An unauthenticated `401` there is correct — open the authenticated GUI URL and
read the panel, which sends the browser's cookie.

## Requirements

- DeepSeek Harness with the `agent/request-error` waterfall event (any version
  shipping `dsh-agent-loop` and `dsh-llm-retry`).
- The Web panel additionally needs a Web composition, `configEditor`, and the
  `settings.section` slot. Without them the policy still applies; the page is
  simply absent or read-only.

## Compatibility

- Node.js 20 or newer.
- `AbortSignal.any` is used when present; a controller-based fallback covers
  runtimes without it.
- A 1.x `config` still mounts: `retryAllCodes` is ignored (every code is
  retried unless excluded) and `terminalCodes` is read as `excludeCodes`. Both
  produce a one-line warning naming the replacement.

## License

MIT — see [LICENSE](LICENSE).
