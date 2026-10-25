/**
 * dsh-unlimited-retry — host half.
 *
 * Why this exists
 * ---------------
 * `@deepseek-ai/dsh-llm-retry` is only the *executor* of model-request retries:
 * the budget lives on each provider adapter's `retryPolicy`. Its default
 * `mode: "normal"` stops after `maxRetries` (5 in the shipped composition) and
 * then delegates, so the step fails, the turn closes with an error, and a long
 * unattended run dies on a transient network blip. `mode: "always"` exists, but
 * it is all-or-nothing per provider and cannot be bounded by a delay ceiling.
 *
 * This plugin registers the INNERMOST listener on `agent/request-error`. That
 * event is a waterfall and Cordis runs listeners outermost-first, so the
 * last-registered listener is the deepest one: every other recovery (the
 * provider policy executor, context-overflow compaction, image offload, any
 * other retry plugin) gets the first word, and only a failure that nobody
 * recovered reaches this plugin. With the stock 5-retry provider policy the
 * effective ladder is:
 *
 *   attempts 1..5  -> provider retryPolicy (unchanged)
 *   attempt  6..∞  -> this plugin, bounded exponential backoff with a ceiling
 *
 * Deliberate defaults
 * -------------------
 * No failure code is terminal by default, including auth, quota, billing and
 * context-overflow codes. That is the whole point of an *unlimited* retry
 * plugin, and it is announced once at mount so an unintended infinite loop on a
 * permanent failure is a visible decision rather than a silent spend. Bound it
 * by adding codes to `excludeCodes`, or by setting `maxAttempts`.
 *
 * Durable-event ordering
 * ----------------------
 * Each scheduled retry appends `llm/retry` BEFORE its cancellable wait and
 * `llm/retry-started` after it, matching `dsh-llm-retry`. The log therefore
 * always shows a wait that actually happened, and a retry abandoned by an abort
 * leaves a `llm/retry` record with no matching `llm/retry-started`.
 */

/** Cordis function-plugin name; also the Loader row id used by the patch. */
export const name = "unlimited-retry";

const PLUGIN_VERSION = "2.1.0";
const STATS_PATH = "/unlimited-retry/stats";
const CONFIG_PATH = "/unlimited-retry/config";
const RESET_PATH = "/unlimited-retry/reset";

/** Distinct policyKey namespace: never collides with a provider budget. */
const POLICY_KEY = "unlimited-retry";

/** Bounded request bodies: these endpoints carry a handful of scalars. */
const MAX_BODY_BYTES = 8 * 1024;

/** Newest-first ring size for the panel's activity table. */
const RECENT_LIMIT = 50;

/** Named ladder rows the panel renders; later attempts clamp at maxDelayMs. */
const LADDER_ROWS = 8;

/**
 * Codes that are terminal no matter how the plugin is configured.
 *
 * `ABORTED` is not a failure to recover from: it means the request was
 * deliberately cancelled — the turn was stopped, the process is shutting down,
 * or the adapter gave up on a cancelled signal. `dsh-llm` produces this finish
 * whenever `signal.aborted || failure.code === "ABORTED"`, and the second half
 * of that test means an `ABORTED` failure can reach this listener with the loop
 * signal still live. Retrying it would resurrect work the user just cancelled
 * (and, with an unbounded budget, resurrect it forever), so the check is applied
 * before the configured `excludeCodes`: clearing that list must not re-enable
 * retrying a cancel.
 */
const ALWAYS_TERMINAL_CODES = Object.freeze(["ABORTED"]);

/** Fast membership test for {@link ALWAYS_TERMINAL_CODES}. */
const ALWAYS_TERMINAL = new Set(ALWAYS_TERMINAL_CODES);

/**
 * Every failure code the Harness itself can produce, for the panel's picker.
 *
 * These come from the shipped `dsh-llm` layer rather than from guesswork, so the
 * UI can offer the real vocabulary instead of asking the operator to spell a
 * constant from memory. Providers still surface their own codes, which is why
 * the picker also accepts free text.
 */
const KNOWN_FAILURE_CODES = Object.freeze([
  "ABORTED",
  "ACCOUNT_QUOTA",
  "CONTEXT_WINDOW_EXCEEDED",
  "EMPTY_RESPONSE",
  "IMAGE_OFFLOAD_REQUIRED",
  "INVALID_CREDENTIAL",
  "INVALID_REQUEST",
  "NO_ADAPTER",
  "QUOTA",
  "RATE_LIMIT",
  "REGISTRATION_DISPOSED",
  "SERVER",
  "TIMEOUT",
  "TRANSPORT",
  "UNKNOWN",
]);

/**
 * Codes where a retry re-sends a request that fails identically, so an
 * unbounded budget is pure spend. NOT terminal by default — this is the
 * recommended one-click preset for `excludeCodes`, and mirrors the permanent
 * sets other recovery layers already judge terminal.
 *
 * `IMAGE_OFFLOAD_REQUIRED` is deliberately absent: `dsh-compaction-image-offload`
 * recovers it by shrinking the request, and it registers ahead of this plugin.
 * If it declines, retrying is the correct next move because the retry path
 * re-prepares the request.
 */
const RECOMMENDED_EXCLUDE = Object.freeze([
  "AUTH",
  "UNAUTHORIZED",
  "FORBIDDEN",
  "BILLING",
  "QUOTA",
  "ACCOUNT_QUOTA",
  "MISSING_CREDENTIAL",
  "INVALID_CREDENTIAL",
  "MODEL_NOT_FOUND",
  "NO_ADAPTER",
  "CONTEXT_WINDOW_EXCEEDED",
  "CONTEXT_OVERFLOW",
  "CONTEXT_LENGTH",
  "INVALID_REQUEST",
]);

const DEFAULTS = Object.freeze({
  autoRetry: true,
  /** `null` means no attempt limit. A positive integer caps this plugin only. */
  maxAttempts: null,
  initialDelayMs: 1000,
  maxDelayMs: 60000,
  jitterRatio: 0.2,
  /** Retry even when the serving adapter published no retryPolicy at all. */
  retryWithoutProviderPolicy: true,
  /** Codes that stay terminal even though the budget is unbounded. */
  excludeCodes: Object.freeze([]),
  /** Append `llm/retry` + `llm/retry-started` so the chat surface shows the chain. */
  recordSessionEvents: true,
  log: true,
  /** Optional absolute path: one-line JSON mount probe, for diagnostics only. */
  markerFile: null,
});

/** Keys this version accepts in a `config` block. */
const KNOWN_KEYS = Object.freeze([
  "autoRetry",
  "maxAttempts",
  "initialDelayMs",
  "maxDelayMs",
  "jitterRatio",
  "retryWithoutProviderPolicy",
  "excludeCodes",
  "recordSessionEvents",
  "log",
  "markerFile",
]);

/** Keys retired by 2.0.0, accepted and reported so a stale patch still mounts. */
const RETIRED_KEYS = Object.freeze({
  retryAllCodes: "retryAllCodes was removed in 2.0.0: every code is retried unless it is listed in excludeCodes",
  terminalCodes: "terminalCodes was renamed to excludeCodes in 2.0.0",
});

/**
 * Build the panel-editable schema.
 *
 * `@deepseek-ai/schemastery` always ships with the Harness, but whether a bare
 * specifier resolves depends on where this bundle actually lives: a package
 * installed into the profile resolves it through the profile's `node_modules`,
 * while a `link:`-installed checkout resolves from its real workspace path and
 * does not. Both are supported, and neither is required — without the module the
 * plugin still mounts with its own `normalize()` clamps and simply has no
 * schema to advertise.
 * @returns the Config constructor, or undefined when the module is unavailable.
 */
async function loadConfigSchema() {
  const schemastery = await importSchemastery();
  if (typeof schemastery?.object !== "function") return undefined;
  const ms = (value) => schemastery.number().min(value);
  const nullableString = schemastery.union([schemastery.string(), schemastery.const(null)]);
  const nullableCount = schemastery.union([ms(1), schemastery.const(null)]);
  return schemastery.object({
    autoRetry: schemastery.boolean().default(true).description("Retry a model request that no earlier recovery layer handled."),
    maxAttempts: nullableCount.description("Cap the retries this plugin performs per step. Empty or null means no limit."),
    initialDelayMs: ms(1).default(1000).description("First backoff delay in milliseconds."),
    maxDelayMs: ms(1).default(60000).description("Ceiling for any single backoff delay, in milliseconds."),
    // No `.step()` anywhere: a fractional or offset step cannot be expressed in
    // portable JSON Schema, and the projection would have to report the whole
    // field as native-validation-only. Whole-number enforcement is applied by
    // `normalize()` instead, which is stricter than a hint either way.
    jitterRatio: schemastery.number().min(0).max(1).default(0.2).description("Randomization applied to each delay, as a fraction of the nominal value."),
    retryWithoutProviderPolicy: schemastery.boolean().default(true).description("Retry even when the serving adapter published no retryPolicy."),
    excludeCodes: schemastery.array(schemastery.string()).default([]).description("Failure codes that stay terminal."),
    recordSessionEvents: schemastery.boolean().default(true).description("Append llm/retry and llm/retry-started session events."),
    log: schemastery.boolean().default(true).description("Write retry decisions to the Harness log."),
    markerFile: nullableString.description("Optional absolute path for a one-line JSON mount probe."),
  });
}

/**
 * Resolve one package from the profile first, then from the plain specifier.
 *
 * A `link:`-installed bundle resolves modules from its real workspace path,
 * which has a different ancestor chain than the profile, so the bare specifier
 * can fail for a package the Harness definitely ships. Anchoring on
 * `DSH_PROFILE_DIR` makes both installation shapes work.
 * @param specifier - the package to resolve.
 * @returns the imported namespace, or undefined when it cannot be resolved.
 */
async function importFromProfile(specifier) {
  const anchors = [
    process.env.DSH_PROFILE_DIR,
    process.env.DSH_HOME === undefined ? undefined : `${process.env.DSH_HOME}/profiles/${process.env.DSH_PROFILE ?? "web"}`,
  ].filter((anchor) => typeof anchor === "string" && anchor.length > 0);
  for (const anchor of anchors) {
    try {
      const { createRequire } = await import("node:module");
      const { join } = await import("node:path");
      const resolved = createRequire(join(anchor, "noop.js")).resolve(specifier);
      return await import(pathToSpecifier(resolved));
    } catch {
      /* try the next anchor */
    }
  }
  try {
    return await import(specifier);
  } catch {
    return undefined;
  }
}

/**
 * Resolve schemastery, used for the panel-editable Config schema.
 * @returns the schemastery default export, or undefined.
 */
async function importSchemastery() {
  const module = await importFromProfile("@deepseek-ai/schemastery");
  return typeof module?.default?.object === "function" ? module.default : undefined;
}

/**
 * Resolve `zod`, used for the projection state schema.
 *
 * This must be the real zod: the projection registry validates a replayed cell
 * with `stateSchema.parse`, which schemastery does not implement.
 * @returns the zod namespace, or undefined.
 */
async function importZod() {
  const module = await importFromProfile("zod");
  const z = module?.z ?? module?.default?.z ?? module?.default;
  return typeof z?.object === "function" ? { z } : undefined;
}

/** Convert an absolute filesystem path into an importable URL specifier. */
function pathToSpecifier(path) {
  return `file://${path.split("\\").join("/").replace(/^([^/])/, "/$1")}`;
}


/**
 * Projection state schema for one retry series.
 *
 * The registry validates a replayed cell with `stateSchema.parse`, so this must
 * be a real zod schema: a hand-rolled `{ parse }` object registers fine and then
 * throws on the first resumed session. Building it once at module scope keeps
 * `apply()` synchronous and avoids per-mount construction.
 */
const CHAIN_SCHEMA = await (async () => {
  const zod = await importZod();
  if (zod === undefined) return undefined;
  return zod.z.object({
    attempt: zod.z.number().int().nonnegative().default(0),
    retryId: zod.z.string().optional(),
  });
})();

/** The schema export is optional; absence only removes the advertised form. */
export const Config = await loadConfigSchema();

function finite(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function nonEmptyString(value) {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Canonical form of a failure code, used for every membership test.
 *
 * Failure codes are compared, not displayed, here — the raw code is what gets
 * recorded in the session events and shown in the panel. Case and surrounding
 * whitespace are normalised because a provider adapter is free to surface
 * `Aborted` or ` transaction ` and the guard must still recognise it; a guard
 * that only matches one spelling is a bug waiting for a second vendor.
 * @param value - the raw `failure.code`.
 * @returns the canonical uppercase, trimmed code, or undefined when absent.
 */
function canonicalCode(value) {
  const raw = nonEmptyString(value);
  return raw === undefined ? undefined : raw.trim().toUpperCase();
}

/** Build the canonical exclusion set from configured codes. */
function canonicalCodeSet(codes) {
  const set = new Set();
  for (const code of codes) {
    const canonical = canonicalCode(code);
    if (canonical !== undefined && canonical.length > 0) set.add(canonical);
  }
  return set;
}

/**
 * Clamp raw config into the values the retry path uses.
 * @param raw - the Loader row's `config`, possibly incomplete or stale.
 * @returns normalized settings plus the legacy keys that were ignored.
 */
function normalize(raw) {
  const source = raw !== null && typeof raw === "object" ? raw : {};
  const initialDelayMs = Math.max(1, Math.round(finite(source.initialDelayMs, DEFAULTS.initialDelayMs)));
  const maxDelayMs = Math.max(initialDelayMs, Math.round(finite(source.maxDelayMs, DEFAULTS.maxDelayMs)));
  const jitterRatio = Math.min(1, Math.max(0, finite(source.jitterRatio, DEFAULTS.jitterRatio)));

  const rawAttempts = source.maxAttempts;
  const parsedAttempts = rawAttempts === null || rawAttempts === undefined
    ? null
    : Math.trunc(finite(rawAttempts, 0));
  // 0 and negatives mean "no cap", matching how an empty panel field is read.
  const maxAttempts = parsedAttempts === null || parsedAttempts < 1 ? null : parsedAttempts;

  // Canonical on both sides, so `Auth`, `auth` and ` AUTH ` are one exclusion.
  const legacyExcludes = Array.isArray(source.terminalCodes) ? source.terminalCodes : [];
  const excludeCodes = canonicalCodeSet([
    ...legacyExcludes,
    ...(Array.isArray(source.excludeCodes) ? source.excludeCodes : []),
  ]);

  const retired = Object.keys(RETIRED_KEYS).filter((key) => Object.hasOwn(source, key));

  return {
    autoRetry: source.autoRetry !== false,
    maxAttempts,
    initialDelayMs,
    maxDelayMs,
    jitterRatio,
    retryWithoutProviderPolicy: source.retryWithoutProviderPolicy !== false,
    excludeCodes,
    recordSessionEvents: source.recordSessionEvents !== false,
    log: source.log !== false,
    markerFile: nonEmptyString(source.markerFile) ?? null,
    retired,
  };
}

/**
 * Serialize the subset of settings that a config write persists.
 * @param cfg - a normalized config.
 * @returns plain JSON config fields, without the derived set.
 */
function configPayload(cfg) {
  return {
    autoRetry: cfg.autoRetry,
    maxAttempts: cfg.maxAttempts,
    initialDelayMs: cfg.initialDelayMs,
    maxDelayMs: cfg.maxDelayMs,
    jitterRatio: cfg.jitterRatio,
    retryWithoutProviderPolicy: cfg.retryWithoutProviderPolicy,
    excludeCodes: [...cfg.excludeCodes],
    recordSessionEvents: cfg.recordSessionEvents,
    log: cfg.log,
    ...cfg.markerFile === null ? {} : { markerFile: cfg.markerFile },
  };
}

/**
 * Exponential backoff with jitter, clamped to `maxDelayMs`.
 * @param cfg - normalized settings.
 * @param attempt - 1-based retry number inside the current step.
 * @param random - uniform [0, 1) source.
 * @returns the delay in whole milliseconds.
 */
function localDelay(cfg, attempt, random) {
  const exponent = Math.min(Math.max(0, attempt - 1), 30);
  const exponential = Math.min(cfg.initialDelayMs * 2 ** exponent, cfg.maxDelayMs);
  const jitter = 1 - cfg.jitterRatio + 2 * cfg.jitterRatio * random();
  return Math.min(Math.max(1, Math.round(exponential * jitter)), cfg.maxDelayMs);
}

/** One opaque retry-chain identity per step. */
function newRetryId() {
  const uuid = globalThis.crypto?.randomUUID?.();
  if (typeof uuid === "string" && uuid.length > 0) return uuid;
  return `retry-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Resolve when the delay elapses, or as soon as any signal aborts.
 * @param delayMs - wait duration.
 * @param signals - signals whose abort cancels the wait.
 * @returns true when the delay completed, false when it was cancelled.
 */
function cancellableDelay(delayMs, signals) {
  if (signals.some((signal) => signal.aborted)) return Promise.resolve(false);
  return new Promise((resolve) => {
    const cleanups = [];
    let settled = false;
    const finish = (completed) => {
      if (settled) return;
      settled = true;
      for (const cleanup of cleanups) cleanup();
      resolve(completed);
    };
    const timer = setTimeout(() => {
      finish(true);
    }, delayMs);
    cleanups.push(() => clearTimeout(timer));
    for (const signal of signals) {
      const onAbort = () => {
        finish(false);
      };
      signal.addEventListener("abort", onAbort, { once: true });
      cleanups.push(() => signal.removeEventListener("abort", onAbort));
    }
  });
}

/**
 * Fuse the turn signal with the plugin's lifetime signal.
 * `AbortSignal.any` is not available on every supported Node runtime, so the
 * fallback builds an equivalent controller and releases it with the wait.
 * @param signals - candidate signals; nullish entries are skipped.
 * @returns the fused signal and a release callback.
 */
function fuseSignals(signals) {
  const present = signals.filter((signal) => signal instanceof AbortSignal);
  if (present.length === 0) return { signal: new AbortController().signal, release: () => {} };
  if (present.length === 1) return { signal: present[0], release: () => {} };
  if (typeof AbortSignal.any === "function") return { signal: AbortSignal.any(present), release: () => {} };
  const controller = new AbortController();
  const onAbort = () => {
    controller.abort(present.find((signal) => signal.aborted)?.reason);
  };
  for (const signal of present) signal.addEventListener("abort", onAbort, { once: true });
  return {
    signal: controller.signal,
    release: () => {
      for (const signal of present) signal.removeEventListener("abort", onAbort);
    },
  };
}

/** Plain JSON failure facts: the session log rejects branded or exotic values. */
function normalizeFailure(failure) {
  const data = {
    message: typeof failure?.message === "string" ? failure.message : String(failure ?? "model request failed"),
    code: nonEmptyString(failure?.code) ?? "UNKNOWN",
  };
  if (Number.isFinite(failure?.status)) data.status = Number(failure.status);
  if (Number.isFinite(failure?.providerRetryAfterMs)) data.providerRetryAfterMs = Number(failure.providerRetryAfterMs);
  return data;
}

/**
 * Counters survive a plugin reload, so a config write from the panel does not
 * silently reset the numbers the user is looking at.
 */
function sharedStats() {
  const key = Symbol.for("dsh-unlimited-retry/stats");
  const existing = globalThis[key];
  if (existing !== undefined) return existing;
  const created = {
    mountedAt: new Date().toISOString(),
    mounts: 0,
    totalRetries: 0,
    lastRetryAt: null,
    lastCode: null,
    lastProvider: null,
    lastDelayMs: null,
    lastAttempt: 0,
    byCode: Object.create(null),
    byProvider: Object.create(null),
    terminalSeen: Object.create(null),
    recent: [],
  };
  Object.defineProperty(globalThis, key, { value: created, enumerable: false, configurable: true });
  return created;
}

function bump(bucket, key) {
  bucket[key] = (bucket[key] ?? 0) + 1;
}

function pairs(map) {
  return Object.entries(map).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

/**
 * Write one JSON response.
 * @param res - the HTTP response.
 * @param status - status code.
 * @param value - the JSON payload.
 * @param options - `head` suppresses the body while keeping the length header,
 *   `headers` merges extra response headers.
 */
function sendJson(res, status, value, options = {}) {
  let body;
  try {
    body = JSON.stringify(value);
  } catch (error) {
    res.writeHead(500, {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    });
    res.end(JSON.stringify({ code: "snapshot-failed", message: String(error) }));
    return;
  }
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "content-length": String(Buffer.byteLength(body)),
    ...options.headers,
  });
  // A HEAD response advertises the length of the body it would have sent.
  if (options.head === true) res.end();
  else res.end(body);
}

function sendMethodNotAllowed(res, allow) {
  res.writeHead(405, { allow, "cache-control": "no-store" });
  res.end();
}

/**
 * Read a small JSON body.
 * @param req - the HTTP request.
 * @returns an outcome discriminated by `ok`.
 */
async function readJsonBody(req) {
  const type = String(req.headers["content-type"] ?? "").split(";", 1)[0]?.trim().toLowerCase();
  if (type !== "application/json") {
    return { ok: false, status: 415, code: "unsupported-media-type", message: "content-type must be application/json" };
  }
  const chunks = [];
  let size = 0;
  try {
    for await (const chunk of req) {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        return { ok: false, status: 413, code: "payload-too-large", message: `request body exceeds ${MAX_BODY_BYTES} bytes` };
      }
      chunks.push(chunk);
    }
  } catch {
    return { ok: false, status: 400, code: "bad-request", message: "request body unreadable" };
  }
  const text = Buffer.concat(chunks).toString("utf8").trim();
  if (text.length === 0) return { ok: false, status: 400, code: "bad-request", message: "request body is empty" };
  try {
    const parsed = JSON.parse(text);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { ok: false, status: 400, code: "bad-request", message: "request body must be a JSON object" };
    }
    return { ok: true, value: parsed };
  } catch {
    return { ok: false, status: 400, code: "bad-request", message: "request body is not valid JSON" };
  }
}

/**
 * Validate one config patch coming from the panel.
 * @param patch - the parsed request body.
 * @returns either `{ ok: true, value }` or an error outcome.
 */
function validateConfigPatch(patch) {
  const value = {};
  for (const key of Object.keys(patch)) {
    if (key === "resetToRecommendedExcludes") continue;
    if (!KNOWN_KEYS.includes(key)) {
      return { ok: false, status: 400, code: "unknown-key", message: `unknown config key: ${key}` };
    }
  }
  for (const key of ["autoRetry", "retryWithoutProviderPolicy", "recordSessionEvents", "log"]) {
    if (Object.hasOwn(patch, key)) {
      if (typeof patch[key] !== "boolean") return { ok: false, status: 400, code: "invalid-value", message: `${key} must be a boolean` };
      value[key] = patch[key];
    }
  }
  for (const key of ["initialDelayMs", "maxDelayMs"]) {
    if (Object.hasOwn(patch, key)) {
      const parsed = Number(patch[key]);
      if (!Number.isFinite(parsed) || parsed < 1 || parsed > 86_400_000) {
        return { ok: false, status: 400, code: "invalid-value", message: `${key} must be a number of milliseconds between 1 and 86400000` };
      }
      value[key] = Math.round(parsed);
    }
  }
  if (Object.hasOwn(patch, "jitterRatio")) {
    const parsed = Number(patch.jitterRatio);
    if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
      return { ok: false, status: 400, code: "invalid-value", message: "jitterRatio must be between 0 and 1" };
    }
    value.jitterRatio = parsed;
  }
  if (Object.hasOwn(patch, "maxAttempts")) {
    if (patch.maxAttempts === null || patch.maxAttempts === 0) value.maxAttempts = null;
    else {
      const parsed = Number(patch.maxAttempts);
      if (!Number.isFinite(parsed) || parsed < 1 || parsed > 10_000) {
        return { ok: false, status: 400, code: "invalid-value", message: "maxAttempts must be null or an integer between 1 and 10000" };
      }
      value.maxAttempts = Math.trunc(parsed);
    }
  }
  if (patch.resetToRecommendedExcludes === true) {
    value.excludeCodes = [...RECOMMENDED_EXCLUDE];
  } else if (Object.hasOwn(patch, "excludeCodes")) {
    if (!Array.isArray(patch.excludeCodes)) {
      return { ok: false, status: 400, code: "invalid-value", message: "excludeCodes must be an array of strings" };
    }
    const codes = [];
    for (const code of patch.excludeCodes) {
      if (typeof code !== "string") return { ok: false, status: 400, code: "invalid-value", message: "excludeCodes must contain only strings" };
      const trimmed = code.trim();
      if (trimmed.length === 0 || trimmed.length > 120) {
        return { ok: false, status: 400, code: "invalid-value", message: "each excluded code must be 1..120 characters" };
      }
      if (!codes.includes(trimmed)) codes.push(trimmed);
    }
    value.excludeCodes = codes;
  }
  if (value.initialDelayMs !== undefined && value.maxDelayMs !== undefined && value.maxDelayMs < value.initialDelayMs) {
    return { ok: false, status: 400, code: "invalid-value", message: "maxDelayMs must be greater than or equal to initialDelayMs" };
  }
  if (Object.keys(value).length === 0) {
    return { ok: false, status: 400, code: "bad-request", message: "no recognized config field in the request body" };
  }
  return { ok: true, value };
}

/**
 * Mount the retry policy, its counters, and the optional Web panel endpoints.
 * @param ctx - the plugin context.
 * @param config - the Loader row's `config`, validated by `Config` when present.
 */
export function apply(ctx, config) {
  const cfg = normalize(config);
  const stats = sharedStats();
  stats.mounts += 1;

  const lifetime = new AbortController();
  const active = new Set();

  /** Sessions with a wait in flight right now, for the panel's live count. */
  const activeSessions = new Set();
  const mountedAt = Date.now();

  function log(level, text) {
    if (!cfg.log) return;
    try {
      const sink = ctx.logger?.[level] ?? ctx.logger?.info;
      sink?.call(ctx.logger, `[unlimited-retry] ${text}`);
    } catch {
      /* logging is advisory */
    }
  }

  function track(operation) {
    const tracked = operation.finally(() => active.delete(tracked));
    active.add(tracked);
    return tracked;
  }

  // ---------------------------------------------------------------------
  // Mount-time reporting: an unbounded budget must never be a surprise.
  // ---------------------------------------------------------------------
  for (const key of cfg.retired) log("warn", RETIRED_KEYS[key]);
  if (cfg.autoRetry) {
    if (cfg.maxAttempts === null && cfg.excludeCodes.size === 0) {
      log(
        "warn",
        `no failure code is terminal and maxAttempts is unset: every failed request retries forever, `
          + `capped only by maxDelayMs=${cfg.maxDelayMs}ms. Add codes to excludeCodes, or set maxAttempts, to bound the spend`,
      );
    } else if (cfg.maxAttempts === null) {
      log("info", `unlimited attempts, ${cfg.excludeCodes.size} terminal code(s), maxDelayMs=${cfg.maxDelayMs}ms`);
    } else {
      log("info", `at most ${cfg.maxAttempts} retries per step, maxDelayMs=${cfg.maxDelayMs}ms`);
    }
  } else {
    log("info", "autoRetry is off: failures are left to the loop");
  }

  // ---------------------------------------------------------------------
  // Mount probe (diagnostic only, opt-in).
  // ---------------------------------------------------------------------
  if (cfg.markerFile !== null) {
    const markerFile = cfg.markerFile;
    const payload = {
      plugin: name,
      version: PLUGIN_VERSION,
      mountedAt: new Date().toISOString(),
      pid: process.pid,
      config: configPayload(cfg),
    };
    void (async () => {
      try {
        const { writeFile } = await import("node:fs/promises");
        await writeFile(markerFile, `${JSON.stringify(payload)}\n`, "utf8");
      } catch {
        /* the probe never affects retry behaviour */
      }
    })();
  }

  // ---------------------------------------------------------------------
  // Durable records
  // ---------------------------------------------------------------------
  function record(agent, type, data) {
    if (!cfg.recordSessionEvents) return;
    try {
      agent?.session?.append?.(type, data);
    } catch {
      /* a rejected append must never block the retry itself */
    }
  }

  // ---------------------------------------------------------------------
  // Per-step retry ladders
  //
  // A ladder belongs to exactly one step: a new step is a new request context,
  // so its first transient failure starts again at the initial delay instead of
  // resuming at the previous step's ceiling.
  //
  // The ladder is folded from the `llm/retry` events this plugin already
  // appends, exactly as `dsh-llm-retry` does for its own budget. Two things
  // follow, and both matter:
  //   1. The registry holds per-session cells in a WeakMap, so a ladder dies
  //      with its session. A plugin-owned Map keyed by session id would pin one
  //      entry per session this process ever retried, for the life of the
  //      process.
  //   2. The session log is the source of truth, so a resumed or replayed
  //      session reconstructs the same ladder instead of restarting at attempt 1.
  //
  // When `recordSessionEvents` is off there is nothing to fold, so a bounded
  // local Map carries the ladder instead. It is capped, so an unbounded
  // process still cannot grow without limit.
  // ---------------------------------------------------------------------
  const CHAIN_KEY = "unlimitedRetryChain";

  /** One retry series; see `CHAIN_SCHEMA` for why it is a real zod schema. */

  /** Boundaries that end the request series owning a ladder. */
  const CHAIN_RESETS = new Set(["step/start", "turn/start", "turn/end", "assistant/message"]);
  const EMPTY_CHAIN = Object.freeze({ attempt: 0, retryId: undefined });

  let chainsRegistered = false;
  if (cfg.recordSessionEvents && CHAIN_SCHEMA !== undefined) {
    try {
      ctx.sessionProjections.register({
        key: CHAIN_KEY,
        stateVersion: 1,
        stateSchema: CHAIN_SCHEMA,
        init: () => EMPTY_CHAIN,
        apply: (state, event) => {
          const type = event?.type;
          if (typeof type !== "string") return state;
          if (CHAIN_RESETS.has(type)) return state.attempt === 0 ? state : EMPTY_CHAIN;
          if (type !== "llm/retry") return state;
          // Only this plugin's own retries own this ladder.
          if (event.data?.policyKey !== POLICY_KEY) return state;
          const attempt = Number.isSafeInteger(event.data?.retry) && event.data.retry > 0 ? event.data.retry : 0;
          if (attempt === 0) return state;
          const retryId = typeof event.data?.retryId === "string" ? event.data.retryId : state.retryId;
          if (attempt === state.attempt && retryId === state.retryId) return state;
          return { attempt, retryId };
        },
      });
      chainsRegistered = true;
    } catch (error) {
      log("warn", `session projections unavailable (${String(error)}); retry ladders are bounded and process-local instead`);
    }
  }

  /** Fallback ladder store: bounded, used when there is no projection to fold. */
  const fallbackChains = new Map();
  const FALLBACK_LIMIT = 512;
  /** Set once, so a degraded ladder reports itself without flooding the log. */
  let projectionReadFailed = false;

  // The projection folds recorded boundaries on its own, but the fallback store
  // has no such driver. Observe boundaries directly whenever the fallback is in
  // use — otherwise `maxAttempts` would silently degrade from a per-step cap into
  // a per-session lifetime cap, and just one earlier capped step would leave the
  // session unable to retry at all.
  if (!chainsRegistered) {
    ctx.on("session/event", (session, event) => {
      if (fallbackChains.size === 0) return;
      const type = event?.type;
      if (typeof type !== "string" || !CHAIN_RESETS.has(type)) return;
      const id = session?.id ?? "unidentified-session";
      fallbackChains.delete(id);
    });
  }

  /**
   * Read the ladder for one session.
   * @param session - the session that owns the ladder.
   * @returns the attempts already made in this series, and its identity.
   */
  function chainFor(session) {
    if (chainsRegistered) {
      try {
        return ctx.sessionProjections.stateOf(session, CHAIN_KEY) ?? EMPTY_CHAIN;
      } catch (error) {
        // Reading a projection needs a real session (the registry folds its log
        // to materialize the cell). A submission that reached this listener with
        // something session-shaped but not a session must still get a retry, so
        // fall through to the bounded store and say why, once.
        if (!projectionReadFailed) {
          projectionReadFailed = true;
          log("warn", `cannot read the retry ladder from this session (${String(error)}); using the bounded local ladder`);
        }
      }
    }
    const id = session?.id ?? "unidentified-session";
    return fallbackChains.get(id) ?? EMPTY_CHAIN;
  }

  /**
   * Record that one attempt is being scheduled.
   * @param session - the owning session.
   * @param attempt - the attempt number being scheduled.
   * @param retryId - the series identity.
   */
  function rememberChain(session, attempt, retryId) {
    if (chainsRegistered) {
      // The projection folds the `llm/retry` event appended by `backoff()`;
      // nothing else may write here.
      return;
    }
    const id = session?.id ?? "unidentified-session";
    if (fallbackChains.size >= FALLBACK_LIMIT && !fallbackChains.has(id)) {
      const oldest = fallbackChains.keys().next().value;
      if (oldest !== undefined) fallbackChains.delete(oldest);
    }
    fallbackChains.set(id, { attempt, retryId });
  }

  // ---------------------------------------------------------------------
  // Counters and the read model served to the panel
  // ---------------------------------------------------------------------
  function ladder() {
    // Nominal delays (jitter midpoint) so the panel can show what to expect
    // without duplicating the jitter draw.
    return Array.from({ length: LADDER_ROWS }, (_, index) => {
      const attempt = index + 1;
      const nominal = localDelay(cfg, attempt, () => 0.5);
      const unclamped = cfg.initialDelayMs * 2 ** Math.min(attempt - 1, 30);
      return { attempt, delayMs: nominal, clamped: unclamped >= cfg.maxDelayMs };
    });
  }

  function snapshot() {
    return {
      schemaVersion: 1,
      plugin: {
        name,
        version: PLUGIN_VERSION,
        pid: process.pid,
        mountedAt: new Date(mountedAt).toISOString(),
        uptimeMs: Date.now() - mountedAt,
        mounts: stats.mounts,
      },
      config: configPayload(cfg),
      capabilities: {
        unlimited: cfg.maxAttempts === null,
        retriesEveryCode: cfg.excludeCodes.size === 0,
        canWriteConfig: typeof ctx.get?.("configEditor")?.edit === "function",
        canReset: true,
      },
      ladder: ladder(),
      recommendedExclude: [...RECOMMENDED_EXCLUDE],
      // The real Harness vocabulary, so the panel can offer a picker instead of
      // asking an operator to spell a constant from memory. Providers still
      // surface their own codes, which is why the input stays free text too.
      knownFailureCodes: [...KNOWN_FAILURE_CODES],
      // Rules that apply regardless of configuration, published so the panel can
      // explain them rather than looking like it silently ignored a setting.
      alwaysTerminalCodes: [...ALWAYS_TERMINAL_CODES],
      stats: {
        totalRetries: stats.totalRetries,
        activeWaits: active.size,
        // Distinct sessions with a live wait right now. The old count came from a
        // plugin-owned Map that grew per session forever; this counts the waits
        // actually in flight, which is the number the panel means.
        sessionsRetrying: activeSessions.size,
        lastRetryAt: stats.lastRetryAt,
        lastCode: stats.lastCode,
        lastProvider: stats.lastProvider,
        lastDelayMs: stats.lastDelayMs,
        lastAttempt: stats.lastAttempt,
        byCode: pairs(stats.byCode).map(([code, count]) => ({ code, count })),
        byProvider: pairs(stats.byProvider).map(([provider, count]) => ({ provider, count })),
        terminalSeen: pairs(stats.terminalSeen).map(([code, count]) => ({ code, count })),
        recent: stats.recent.slice(0, RECENT_LIMIT),
      },
    };
  }

  /** One attempted schedule: record durably, count, wait, then confirm. */
  async function backoff(agent, turn, step, provider, failure, attempt, retryId, delayMs, session, signal) {
    const fused = fuseSignals([signal, lifetime.signal]);
    if (fused.signal.aborted) {
      fused.release();
      return false;
    }
    const code = nonEmptyString(failure?.code) ?? "UNKNOWN";
    const route = nonEmptyString(provider) ?? "unknown";

    // Durable BEFORE the wait, so the log shows a wait that really happened.
    record(agent, "llm/retry", {
      retryId,
      turn: turn ?? 0,
      step: step ?? 0,
      provider: route,
      // mode "always" carries no maxRetries, so the chat surface renders the
      // budget as unbounded even when this plugin caps attempts per step.
      mode: "always",
      policyKey: POLICY_KEY,
      retry: attempt,
      delayMs,
      failure: normalizeFailure(failure),
    });

    const sessionKey = session?.id ?? "unidentified-session";
    activeSessions.add(sessionKey);
    const at = new Date().toISOString();
    stats.totalRetries += 1;
    stats.lastRetryAt = at;
    stats.lastCode = code;
    stats.lastProvider = route;
    stats.lastDelayMs = delayMs;
    stats.lastAttempt = attempt;
    bump(stats.byCode, code);
    bump(stats.byProvider, route);
    stats.recent.unshift({ at, attempt, code, provider: route, delayMs });
    if (stats.recent.length > RECENT_LIMIT) stats.recent.length = RECENT_LIMIT;

    log(
      "warn",
      `retry #${attempt} provider="${route}" code="${code}" in ${delayMs}ms`
        + (cfg.maxAttempts === null ? " (no attempt limit)" : ` (limit ${cfg.maxAttempts})`),
    );

    const completed = await cancellableDelay(delayMs, [fused.signal]);
    activeSessions.delete(sessionKey);
    fused.release();
    if (!completed || fused.signal.aborted) return false;

    record(agent, "llm/retry-started", {
      retryId,
      turn: turn ?? 0,
      step: step ?? 0,
      retry: attempt,
    });
    return true;
  }

  /** Decide whether this layer owns recovery for one failed request. */
  async function recover(payload, next) {
    // Every deeper-in-composition layer gets the first word.
    const downstream = typeof next === "function" ? await next() : undefined;
    if (!cfg.autoRetry) return downstream;
    if (downstream?.kind === "retry") return downstream;

    const { agent, turn, step, provider, failure, signal, retryPolicy } = payload ?? {};
    if (agent === undefined || failure === undefined) return downstream;
    if (!cfg.retryWithoutProviderPolicy && retryPolicy === undefined) return downstream;
    if (signal?.aborted || lifetime.signal.aborted) return downstream;

    // Recorded verbatim; compared canonically.
    const rawCode = nonEmptyString(failure.code) ?? "UNKNOWN";
    const code = canonicalCode(rawCode) ?? "UNKNOWN";

    // A cancelled request is never a candidate, at any configuration. This runs
    // before the configured exclusions because it is a correctness rule, not a
    // policy: `dsh-llm` reports `ABORTED` for a cancelled signal even when the
    // loop's own signal has not flipped yet, so an unguarded retry here would
    // re-run work the user stopped.
    if (ALWAYS_TERMINAL.has(code)) {
      bump(stats.terminalSeen, code);
      log("info", `failure "${code}" is a cancellation, not a fault; left to the loop`);
      return downstream;
    }

    if (cfg.excludeCodes.has(code)) {
      bump(stats.terminalSeen, code);
      log("info", `failure "${code}" is terminal here; left to the loop`);
      return downstream;
    }

    // The ladder is keyed by the session, never by the agent object: the session
    // is created before the agent that owns it, and the agent itself carries no
    // `id`. `chainFor` falls back to a single shared key when a session is
    // missing, so a malformed submission cannot mint a fresh ladder per call and
    // thereby escape `maxAttempts`.
    const session = agent?.session;
    const chain = chainFor(session);
    const attempt = chain.attempt + 1;
    if (cfg.maxAttempts !== null && attempt > cfg.maxAttempts) {
      log("warn", `attempt limit ${cfg.maxAttempts} reached for "${code}"; left to the loop`);
      return downstream;
    }

    // One identity per retry series, so the two durable events pair up.
    const retryId = chain.retryId ?? newRetryId();

    let delayMs = localDelay(cfg, attempt, Math.random);
    const retryAfter = failure?.providerRetryAfterMs;
    if (Number.isFinite(retryAfter) && retryAfter > 0) {
      delayMs = Math.min(Math.max(1, Math.round(retryAfter)), cfg.maxDelayMs);
    }

    // Record before waiting: a wait that is cancelled must still be visible, and
    // when the ladder is projection-folded this append IS the state update.
    rememberChain(session, attempt, retryId);
    if (!(await backoff(agent, turn, step, provider, failure, attempt, retryId, delayMs, session, signal))) {
      return downstream;
    }
    return { kind: "retry" };
  }

  const offError = ctx.on("agent/request-error", (payload, next) => {
    if (lifetime.signal.aborted) return Promise.resolve(undefined);
    return track(recover(payload, next));
  });

  // ---------------------------------------------------------------------
  // Web endpoints (optional: absent webServer leaves retry behaviour intact)
  // ---------------------------------------------------------------------

  /**
   * Reject a browser request that the Harness would not admit on its own.
   * Route handlers bypass the cookie gate, so a route that reads or writes
   * plugin state has to apply the same admission the composition uses.
   * @param webCtx - the context carrying the Web server.
   * @param req - the incoming request.
   * @param res - the response, used only when rejecting.
   * @returns whether the request was already answered.
   */
  function rejected(webCtx, req, res, requireAdmission) {
    let connection;
    try {
      connection = webCtx.get("connection");
    } catch {
      connection = undefined;
    }
    if (typeof connection?.requestRejection !== "function") {
      if (requireAdmission) {
        sendJson(res, 403, {
          code: "not-admitted",
          message: "this composition exposes no browser admission service, so panel writes are disabled",
        });
        return true;
      }
      return false;
    }
    const rejection = connection.requestRejection(req);
    if (rejection === undefined) return false;
    sendJson(res, rejection, {
      code: rejection === 403 ? "forbidden" : "unauthenticated",
      message: rejection === 403
        ? "the request did not come from a trusted origin"
        : "dsh web authentication required",
    });
    return true;
  }

  /** Resolve the addressed Loader row, or undefined when it is not addressable. */
  function configEntry(editor) {
    try {
      return editor.entries().find((entry) => entry.options.id === name);
    } catch {
      return undefined;
    }
  }

  /** Persist a validated patch through the Loader's own config path. */
  async function writeConfig(editor, patch) {
    const entry = configEntry(editor);
    if (entry === undefined) {
      return {
        ok: false,
        status: 409,
        code: "not-addressable",
        message: `no unique Loader row with id "${name}"; configure this plugin through cordis.patch.yml instead`,
      };
    }
    try {
      await editor.edit(entry, (current) => ({ ...current, ...patch }));
      return { ok: true };
    } catch (error) {
      return {
        ok: false,
        status: 500,
        code: "write-failed",
        message: String(error?.message ?? error),
      };
    }
  }

  /**
   * Register the panel endpoints on a context that actually carries a Web
   * server, so compositions without one keep the retry behaviour only.
   * @param webCtx - a context with the `webServer` service.
   */
  function mountRoutes(webCtx) {
    webCtx.effect(() => webCtx.webServer.register({
      kind: "exact",
      path: STATS_PATH,
      handler: (req, res) => {
        if (req.method !== "GET" && req.method !== "HEAD") {
          sendMethodNotAllowed(res, "GET, HEAD");
          return;
        }
        if (rejected(webCtx, req, res, false)) return;
        let value;
        try {
          value = snapshot();
        } catch (error) {
          sendJson(res, 500, { code: "snapshot-failed", message: String(error) });
          return;
        }
        sendJson(res, 200, value, { head: req.method === "HEAD" });
      },
    }), "unlimited-retry: stats route");

    webCtx.effect(() => webCtx.webServer.register({
      kind: "exact",
      path: RESET_PATH,
      handler: async (req, res) => {
        if (req.method !== "POST") {
          sendMethodNotAllowed(res, "POST");
          return;
        }
        if (rejected(webCtx, req, res, true)) return;
        const body = await readJsonBody(req);
        if (!body.ok) {
          sendJson(res, body.status, { code: body.code, message: body.message });
          return;
        }
        if (body.value.confirm !== true) {
          sendJson(res, 400, { code: "confirmation-required", message: "send {\"confirm\": true} to clear the counters" });
          return;
        }
        stats.totalRetries = 0;
        stats.lastRetryAt = null;
        stats.lastCode = null;
        stats.lastProvider = null;
        stats.lastDelayMs = null;
        stats.lastAttempt = 0;
        stats.byCode = Object.create(null);
        stats.byProvider = Object.create(null);
        stats.terminalSeen = Object.create(null);
        stats.recent = [];
        sendJson(res, 200, { ok: true, stats: snapshot().stats });
      },
    }), "unlimited-retry: reset route");

    webCtx.effect(() => webCtx.webServer.register({
      kind: "exact",
      path: CONFIG_PATH,
      handler: async (req, res) => {
        if (req.method !== "POST") {
          sendMethodNotAllowed(res, "POST");
          return;
        }
        if (rejected(webCtx, req, res, true)) return;
        const body = await readJsonBody(req);
        if (!body.ok) {
          sendJson(res, body.status, { code: body.code, message: body.message });
          return;
        }
        const patch = validateConfigPatch(body.value);
        if (!patch.ok) {
          sendJson(res, patch.status, { code: patch.code, message: patch.message });
          return;
        }
        let editor;
        try {
          editor = webCtx.get("configEditor");
        } catch {
          editor = undefined;
        }
        if (typeof editor?.edit !== "function") {
          sendJson(res, 409, {
            code: "no-config-editor",
            message: "this composition has no configEditor service; edit the plugin config in cordis.patch.yml",
          });
          return;
        }
        const written = await writeConfig(editor, patch.value);
        if (!written.ok) {
          sendJson(res, written.status, { code: written.code, message: written.message });
          return;
        }
        sendJson(res, 200, { ok: true, applied: patch.value });
      },
    }), "unlimited-retry: config route");
  }

  if (typeof ctx.inject === "function") {
    // `inject` keeps this branch inactive where the service is absent: a
    // composition with no Web server simply has no panel endpoints.
    try {
      ctx.inject(["webServer"], mountRoutes);
    } catch {
      /* no Web server in this composition */
    }
  }

  // ---------------------------------------------------------------------
  // Teardown
  // ---------------------------------------------------------------------
  ctx.effect(() => async () => {
    try {
      offError?.();
    } catch {
      /* already disposed */
    }
    lifetime.abort(new Error("unlimited-retry plugin disposed"));
    await Promise.allSettled([...active]);
  }, "unlimited-retry: abort and drain active recovery");
}
