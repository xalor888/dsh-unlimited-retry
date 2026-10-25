# dsh-unlimited-retry

**English** · [简体中文](README.zh.md)

[![CI](https://github.com/xalor888/dsh-unlimited-retry/actions/workflows/ci.yml/badge.svg)](https://github.com/xalor888/dsh-unlimited-retry/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/dsh-unlimited-retry.svg)](https://www.npmjs.com/package/dsh-unlimited-retry)
[![license](https://img.shields.io/npm/l/dsh-unlimited-retry.svg)](LICENSE)
[![node](https://img.shields.io/npm/dependency-version/dsh-unlimited-retry/engines/node.svg)](package.json)

Unbounded model-request retry for the DeepSeek Harness agent loop, with a live
Settings panel.

A long unattended run should not die because one request hit a transient network
error. This plugin keeps such a request retrying — exponential backoff, with a
delay ceiling — until it succeeds or you stop it.

Standard DSH bundle plugin, one-command install. **The same package supports both
the DSH Web UI and the official desktop client (Electron).**

## Where to install it

This repository maintains one product line (`main`). The same package supports
both surfaces.

| Surface | Install | Note |
|---|---|---|
| **DSH Web UI** | `dsh plugin --profile web add dsh-unlimited-retry` | Recommended; installs the published npm version |
| **Official desktop client (Electron)** | Open the desktop client once, **fully quit it**, then run `dsh plugin --profile desktop add dsh-unlimited-retry` | Reopen the desktop client afterwards. The order matters: an uninitialized desktop profile is refused rather than being replaced by a fresh CLI profile |

> Why the desktop works: the desktop profile *is* the Web template (`base` +
> `web-app`), and Electron loads the local Web UI URL. The `dsh.client` panel is
> therefore loaded by `client-modules` there too — no separate client build.

## Why a separate plugin

DSH ships `@deepseek-ai/dsh-llm-retry`, but it only *executes* retries — the
budget lives on each provider adapter's `retryPolicy`. Its default
`mode: "normal"` gives up after `maxRetries` (5 in this build) and then
delegates, so the step fails, the turn closes with an error, and the run ends.
`mode: "always"` exists but is all-or-nothing per provider and has no delay
ceiling.

This plugin adds a layer *behind* all of them. `agent/request-error` is a
waterfall event and Cordis runs listeners outermost-first, so the
**last-registered listener is the deepest**: every other recovery gets the first
word, and only a failure that nobody recovered reaches this plugin.

## The retry ladder

With the stock 5-retry provider policy the effective order is:

| Attempt | Handled by | Behaviour |
| --- | --- | --- |
| 1 – 5 | the provider's `retryPolicy` | Its own budget, codes, and delays |
| 6 – ∞ | **this plugin** | Exponential backoff with jitter, capped at `maxDelayMs` |

Other layers registering on the same event — context-overflow compaction, image
offload (`dsh-compaction-image-offload`), any other retry plugin — sit ahead of
this one too. That ordering is the entire reason this plugin registers itself
last, and it is what keeps the provider's own policy authoritative.

## Does it work everywhere?

**It is a Host plugin, not a preset plugin**, so it applies to every session the
profile starts, under every preset. All of the following was verified against
the shipped contracts, not assumed:

| Situation | Applies | Basis |
|---|---|---|
| Any agent preset (standard / ptc / minimal / cordis) | ✅ | Host plugin, preset-independent |
| Sibling agents in one composition | ✅ | Each keeps its own ladder |
| An agent mounted inside a preset scope | ✅ | Real Cordis scope-dispatch test |
| headless / ACP / SDK composition (no Web server) | ✅ retries, no panel | One event listener; no Web service needed |
| DSH Web UI | ✅ | `dsh.client` panel |
| Official desktop client (Electron) | ✅ | Desktop profile = Web template, same Web UI |
| **`ABORTED` (you cancelled)** | ❌ never retried, by design | A cancellation is not a fault |
| A request the adapter never admitted | ❌ never reaches the event | No `agent/request-error` is produced |
| A failure before the loop has a turn | ❌ never reaches the event | Same |

## Features

### Retry behaviour

- 🔁 **Genuinely unbounded**: no attempt limit by default; it retries until success or until you stop it
- ⏱️ **Exponential backoff with jitter**: starts at `initialDelayMs`, doubles, capped at `maxDelayMs`, with per-delay randomization so synchronized storms cannot form
- 🚧 **The ceiling is a hard constraint**: `maxDelayMs` wins any conflict. Ask for 10 ms and you get 10 ms — it is never silently raised because `initialDelayMs` was larger
- 🛑 **A cancellation is never retried**: `ABORTED` is terminal at any configuration (see below)
- 🎯 **Provider delays are honoured but clamped**: `providerRetryAfterMs` is respected and capped by `maxDelayMs`, so one provider cannot park the run indefinitely
- 🧭 **Per-step ladders**: a ladder belongs to one step, so a new step restarts at the initial delay instead of resuming at the previous ceiling
- 🔌 **Works without a provider policy**: also retries when the adapter published no `retryPolicy` (toggleable)

### Durable events

Each scheduled retry appends two events, in the same order as `dsh-llm-retry`:

1. `llm/retry` — **before** the wait, so the log shows a wait that really happened;
2. `llm/retry-started` — **after** the wait, when the request is actually re-sent.

A retry cancelled by an abort or a plugin unload therefore leaves a `llm/retry`
record with no matching `llm/retry-started`, which is exactly what happened.
`mode` is recorded as `always`, and `policyKey` is the fixed namespace
`unlimited-retry`, which cannot collide with a provider budget.

### Settings panel

- 📊 **Live status**: a pill shows whether the host half answers
- 🔢 **Counters**: total retries, waits in flight, sessions retrying, last retry, uptime
- 🪜 **Effective ladder**: what happens on each attempt, with an honest `No limit` instead of a fabricated cap
- 📈 **Breakdown**: retries per failure code and per provider, plus the failures declined because their code is terminal
- 🕒 **Recent retries**: attempt, code, provider, delay, and when, with relative times
- ⚙️ **Policy editor**: switches and numbers write straight back to the profile patch layer through the Harness `configEditor`, surviving a restart and hot-reloading the host half
- 🏷️ **Terminal codes**: add one at a time (with suggestions from the real Harness vocabulary), or apply the recommended set in one click
- 🧹 **Reset counters**: behind an explicit confirmation
- 🎨 **Theme-driven**: only `--dsw-alias-*` tokens, so light/dark and future rethemes follow automatically
- ♿ **Accessible**: switches are real `role="switch"` controls with `aria-checked`; no DOM outside the component tree
- 🌏 **Bilingual**: panel and display metadata, English and Chinese

## `ABORTED`: the one unconditional terminal code

A cancellation is not a fault — the turn was stopped, or the process is shutting
down. `dsh-llm` produces an `aborted` finish when
`signal.aborted || code === "ABORTED"`, which means an `ABORTED` failure can
arrive while the loop's own signal is still live.

Retrying it would re-run work you just cancelled, so the guard runs **before**
`excludeCodes` and clearing that list does not re-enable it. Code matching is
case-insensitive and whitespace-trimmed on both sides, so `Aborted`, `ABORTED`
and ` aborted ` are the same code.

The panel states this rule explicitly, so it never looks like a setting was
silently ignored.

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
markerFile: null
```

**No configured failure code is terminal by default — including auth, quota,
billing, and context-overflow codes.** That is what *unlimited* means here, and
it is announced once at mount so it is a visible decision rather than a silent
spend. The only bound is `maxDelayMs`, so a permanently failing request costs
roughly one request per minute, forever.

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

   > `IMAGE_OFFLOAD_REQUIRED` is **deliberately absent**: `dsh-compaction-image-offload`
   > recovers it by shrinking the request and registers ahead of this plugin. If
   > it declines, retrying is the correct next move.

A cleared numeric field **falls back to its default** rather than being read as
zero — `Number(null)` is `0`, which for a delay is a busy loop and for jitter is
no jitter at all.

## Install

### From npm (recommended)

```bash
# Web UI
dsh plugin --profile web add dsh-unlimited-retry

# Official desktop client (open it once first, then fully quit it)
dsh plugin --profile desktop add dsh-unlimited-retry
```

### From this repository

```bash
dsh plugin --profile web add github:xalor888/dsh-unlimited-retry
```

> ⚠️ The npm name and the `github:` spec are the same package name — **don't mix
> them**; installing both leaves conflicting entries. If you installed via
> `github:`, run `dsh plugin --profile web remove dsh-unlimited-retry` first.

### Local development

```bash
dsh plugin --profile web add link:/absolute/path/to/dsh-unlimited-retry
```

Then open **Settings → Retry**.

## Layout

```text
dsh-unlimited-retry/
├── package.json          # bundle metadata (dsh.bundle.patch / dsh.client / icon / exports)
├── cordis.patch.yml      # mount declaration, with every default
├── icon.svg              # plugin-list icon (the host reads it as a data URL)
├── index.js              # host half: listener, backoff, session events, counters, routes, Config schema
├── client.js             # browser half: the Settings panel (browser bundle format)
├── locale/
│   ├── en.json           # display title/description (English)
│   └── zh.json           # display title/description (Chinese)
├── test/
│   ├── host.test.mjs     # retry decision path + every endpoint
│   ├── client.test.mjs   # panel registration, i18n parity, rendering, states
│   ├── bundle.test.mjs   # package shape, patch completeness, icon, license
│   └── projection.test.mjs # integration against the real projection service + dispatcher
├── README.md / README.zh.md
└── LICENSE
```

## Configuration

Edit the `config` block on the `unlimited-retry` row, or use the panel. An
override anywhere above the bundle patch replaces the **whole** `config`, so a
layer that overrides this row must restate every field it wants to keep.

The plugin also exports a `Config` schema, so its fields appear in
`Config.listConfigs` and are validated by the Loader.

| Field | Type | Default | Purpose |
|---|---|---|---|
| `autoRetry` | boolean | `true` | Turn off to leave every failure to the loop |
| `maxAttempts` | number \| null | `null` | Cap per step; `null`/empty means no limit |
| `initialDelayMs` | number | `1000` | First backoff delay; clamped by the ceiling |
| `maxDelayMs` | number | `60000` | **Single-delay ceiling; wins any conflict** |
| `jitterRatio` | number | `0.2` | Randomization per delay (0–1) |
| `retryWithoutProviderPolicy` | boolean | `true` | Also retry when the adapter published no policy |
| `excludeCodes` | string[] | `[]` | Terminal codes (case/whitespace-insensitive) |
| `recordSessionEvents` | boolean | `true` | Append `llm/retry` / `llm/retry-started` |
| `log` | boolean | `true` | Write retry decisions to the DSH log |
| `markerFile` | string \| null | `null` | Optional mount-probe path (diagnostics) |

## HTTP endpoints

The host half adds three routes. They register through the DSH Web server and
therefore apply the same browser admission check the rest of the composition
uses: an unauthenticated browser request gets `401`, an untrusted origin gets
`403`. Unlike a plain route handler, these do **not** silently bypass the cookie
gate.

| Route | Method | Purpose |
|---|---|---|
| `/unlimited-retry/stats` | `GET`, `HEAD` | The read model the panel renders |
| `/unlimited-retry/config` | `POST` | Validate and persist a policy change |
| `/unlimited-retry/reset` | `POST` | Clear the counters (`{"confirm": true}` required) |

Writes return `403` when the composition exposes no admission service, and `409`
when the row is not addressable or there is no `configEditor`. Bodies are capped
at 8 KiB and must be `application/json`.

These routes are a convenience for the panel. **The retry behaviour never
depends on them**, so a headless / ACP / SDK composition mounts the policy with
no routes at all.

## Verify

```bash
npm test        # or node --test test/
```

Covers the retry decision path (delegation, exclusion, attempt limits, provider
delays, abort, dispose, per-step reset, legacy 1.x config keys), every endpoint
(status codes, `HEAD`, admission, body validation, unknown keys, the preset,
reset confirmation, a failing editor), the client bundle (registration, i18n
parity and placeholder parity, rendering, error/empty/read-only states,
token-only styling), the package shape (manifest, patch completeness, icon,
license), and **integration tests against the real projection service and the
real Cordis dispatcher**.

To verify a live mount (an unauthenticated `401` there is correct — open the
authenticated GUI URL and read the panel):

```bash
curl -s http://127.0.0.1:3080/unlimited-retry/stats | head -c 400
```

## Compatibility

- Node.js 20 or newer.
- DSH 0.2.x (any version shipping `dsh-agent-loop` and `dsh-llm-retry`).
- `AbortSignal.any` is used when present; a controller-based fallback covers runtimes without it.
- A 1.x `config` still mounts: `retryAllCodes` is ignored and `terminalCodes` is read as `excludeCodes`, each with a one-line warning naming the replacement.
- The Web panel additionally needs `configEditor` and the `settings.section` slot. Without them the policy still applies; the page is simply absent or read-only.

## Releasing

Publishing is tag-driven; nothing publishes from a branch.

```bash
# 1. bump the version in package.json (and PLUGIN_VERSION in index.js)
npm version patch --no-git-tag-version   # or minor / major
# 2. land it, then tag the merged commit
git tag v2.1.3 && git push origin v2.1.3
```

The `Release` workflow then refuses a tag that disagrees with `package.json`
tests the tree, packs, publishes with npm provenance, creates the GitHub release
with the tarball attached, and finally re-installs the published version from the
registry to prove that copy mounts. It needs an `NPM_TOKEN` repository secret and
an `npm` environment.

`CI` runs the suite on Node 20, 22 and 24, then packs the tarball, asserts the
published file set has not drifted, installs it into a clean project, and mounts
the installed host half — including the rule that a cancellation never retries.

> The integration suite (`test/projection.test.mjs`) mounts a real Harness, which
> CI has none of, so it skips there. Run it locally with
> `DSH_INSTALL_DIR=~/.local/lib/node_modules/@deepseek-ai/dsh/node_modules npm test`.

## License

MIT — see [LICENSE](LICENSE).
