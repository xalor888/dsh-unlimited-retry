/**
 * dsh-unlimited-retry — host half.
 *
 * Why this exists
 * ---------------
 * `@deepseek-ai/dsh-llm-retry` is only the *executor* of model-request retries:
 * the budget lives on each provider adapter's `retryPolicy`. Its default
 * `mode: "normal"` stops after `maxRetries` (5 in the shipped composition) and
 * then delegates, so the step fails, the turn closes with an error, and a long
 * unattended run dies on a transient network blip. `mode: "always"` exists and
 * has its own delay ceiling, but it is per provider: it retries every failure of
 * that route, cannot judge an unfamiliar code across providers, and holds no
 * turn-wide budget.
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
 * Only the failure codes the Harness itself declares retryable are retried by
 * default (`EMPTY_RESPONSE`, `RATE_LIMIT`, `SERVER`, `TIMEOUT`, `TRANSPORT`).
 * An unfamiliar code is judged by its message, every refusal is listed in the
 * panel, `retryAllCodes` widens the scope, and `maxRetriesPerTurn` bounds a
 * fault that survives every step.
 *
 * Durable-event ordering
 * ----------------------
 * Each scheduled retry appends `llm/retry` BEFORE its cancellable wait and
 * `llm/retry-started` after it, matching `dsh-llm-retry`. The log therefore
 * always shows a wait that actually happened, and a retry abandoned by an abort
 * leaves a `llm/retry` record with no matching `llm/retry-started`.
 *
 * The chain belongs to one `(turn, step, provider)`: every new chain mints a
 * fresh `retryId` and starts at attempt 1, and only the chain that owns the
 * coordinates may continue it. No event is written unless the registered session
 * projection proves the chain: a guessed attempt number can make the stored
 * Session permanently unreadable (issue #1).
 */

/** Cordis function-plugin name; also the Loader row id used by the patch. */
export const name = "unlimited-retry";

const PLUGIN_VERSION = "4.0.1";
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
 * The failure codes a retry can plausibly recover from.
 *
 * Copied from the shipped `dsh-llm` layer's own `DEFAULT_RETRYABLE_CODES`. That
 * list is the Harness's explicit judgement about which failures are worth
 * re-sending, and a plugin that retries *outside* it is overriding a decision
 * that upstream made deliberately.
 *
 * This is the whole reason 2.x over-retried: it defaulted to "nothing is
 * terminal", so an adapter code such as `PI_AI_ERROR` — which pi-ai emits for
 * both unclassified stream errors *and* explicitly non-retryable `pending` /
 * `deferred` states — was retried with no ceiling until the turn was killed.
 */
const HARNESS_RETRYABLE_CODES = Object.freeze([
  "EMPTY_RESPONSE",
  "RATE_LIMIT",
  "SERVER",
  "TIMEOUT",
  "TRANSPORT",
]);

/** Default allow-list; see {@link HARNESS_RETRYABLE_CODES}. */
const DEFAULT_RETRY_CODES = HARNESS_RETRYABLE_CODES;

/**
 * Conditions a retry can actually clear, recognised from the failure text.
 *
 * This exists because an allow-list of literal codes cannot survive contact with
 * real providers. A gateway that namespaces its errors — the observed example is
 * `InferHub.ModelArts.81001.400` — never matches a Harness literal, so a policy
 * built only from literals degenerates into "retry nothing" for exactly the
 * providers most likely to be flaky.
 *
 * Transient markers are checked before permanent ones. That ordering is
 * deliberate: a gateway may wrap a recoverable condition in a 4xx (the
 * `tier_limit_exceeded ... concurrency limit exceeded` failure seen locally
 * arrived as a generic upstream error), and wrongly declining such a failure is
 * worse than wrongly retrying it, because the turn ceiling bounds the latter.
 */
const TRANSIENT_SIGNAL = new RegExp([
  String.raw`rate.?limit`,
  String.raw`too many requests`,
  String.raw`concurren\w* (?:limit|exceeded)`,
  String.raw`\bbusy\b`,
  String.raw`overloaded`,
  String.raw`try again`,
  String.raw`retry later`,
  String.raw`please retry`,
  String.raw`temporarily`,
  String.raw`unavailable`,
  String.raw`capacity`,
  String.raw`queue is full`,
  String.raw`\btimed? ?out\b`,
  String.raw`timeout`,
  String.raw`deadline exceeded`,
  String.raw`connection (?:reset|refused|closed|error)`,
  String.raw`\bECONN[A-Z]+\b|\bEAI_AGAIN\b|\bEPIPE\b|\bENOTFOUND\b|\bETIMEDOUT\b`,
  String.raw`socket hang up`,
  String.raw`other side closed`,
  String.raw`premature close`,
  String.raw`stream ended (?:before|without)`,
  String.raw`\b5(?:0[0-9]|2[0-9]|29)\b`,
  String.raw`internal server error`,
  String.raw`bad gateway`,
  String.raw`gateway time-?out`,
  String.raw`service unavailable`,
].join("|"), "i");

/**
 * Conditions a retry cannot clear: the same bytes produce the same rejection.
 *
 * `invalid argument` is here because that is what a malformed request reports,
 * and re-sending an identical malformed request is the definition of a pointless
 * retry. The observed `CodeArts: Invalid Argument (...)` failure is one of these.
 */
const PERMANENT_SIGNAL = new RegExp([
  String.raw`invalid argument`,
  String.raw`invalid.?request`,
  String.raw`invalid.?param`,
  String.raw`invalid.?api.?key`,
  String.raw`malformed`,
  String.raw`unsupported`,
  String.raw`not supported`,
  String.raw`unrecognized`,
  String.raw`param\w*.?(?:error|invalid)`,
  String.raw`\bno_?adapter\b`,
  String.raw`context.?(?:window|length|overflow)`,
  String.raw`maximum context`,
  String.raw`too long`,
  String.raw`payload too large`,
  String.raw`length limit exceeded`,
  String.raw`billing`,
  String.raw`insufficient (?:balance|quota|funds)`,
  String.raw`quota`,
  String.raw`unauthorized`,
  String.raw`unauthenticated`,
  String.raw`forbidden`,
  String.raw`authentication`,
  String.raw`invalid.?credential`,
  String.raw`model.?not.?found`,
  String.raw`^\s*40[0-9]\b`,
].join("|"), "i");

/** Status tokens the failure text may carry, in the shapes providers use. */
const STATUS_TOKEN = /(?:^|[^0-9])([1-5][0-9]{2})(?:[^0-9]|$)/g;

/**
 * The status a failure reported, if its text carries one.
 *
 * Only four- and five-hundred values count: a message that happens to contain
 * `81001` or a token count must not be read as a status, which is why the search
 * skips the middle of a longer number run.
 * @param texts - texts to scan, most specific first.
 * @returns the status, or undefined when none is present.
 */
function statusOf(...texts) {
  for (const text of texts) {
    if (typeof text !== "string" || text.length === 0) continue;
    for (const match of text.matchAll(STATUS_TOKEN)) {
      const status = Number(match[1]);
      if (status >= 400 && status <= 599) return status;
    }
  }
  return undefined;
}

/**
 * Decide whether a failure looks recoverable, from what it says rather than how
 * its code is spelled.
 * @param failure - the failure the loop reported.
 * @returns `"retry"` (retry it), `"stop"` (terminal), or `"unknown"`.
 */
function classifyFailure(failure) {
  const message = typeof failure?.message === "string" ? failure.message : "";
  const code = typeof failure?.code === "string" ? failure.code : "";
  const status = statusOf(message, code);

  // Evidence that the condition clears beats evidence that it will not, because
  // a mis-declined transient failure strands a working turn while a mis-retried
  // permanent one is bounded by the turn ceiling.
  if (TRANSIENT_SIGNAL.test(message) || TRANSIENT_SIGNAL.test(code)) return "retry";
  if (PERMANENT_SIGNAL.test(message) || PERMANENT_SIGNAL.test(code)) return "stop";

  if (status !== undefined) {
    // 408 (request timeout), 409 (conflict), 425 (too early) and 429 (throttled)
    // are the four-hundreds that a retry can clear; every other 4xx is the
    // request's own fault.
    if ([408, 409, 425, 429].includes(status)) return "retry";
    if (status >= 400 && status < 500) return "stop";
    return "retry";
  }
  return "unknown";
}

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
  /** Read the failure text for transient/permanent evidence, not just the code. */
  classifyTransientFailures: true,
  /** Codes this layer will retry; everything else is left to the loop. */
  retryCodes: DEFAULT_RETRY_CODES,
  /** Retry any code that is not always-terminal and not excluded. */
  retryAllCodes: false,
  /** Hard ceiling on retries inside one turn, whatever the codes say. */
  maxRetriesPerTurn: 40,
  /** Codes that stay terminal even when they are in `retryCodes`. */
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
  "classifyTransientFailures",
  "retryCodes",
  "retryAllCodes",
  "maxRetriesPerTurn",
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
    classifyTransientFailures: schemastery.boolean().default(true).description("Judge an unfamiliar code by what its message says (rate limit, timeout, invalid argument) instead of declining it outright."),
    retryCodes: schemastery.array(schemastery.string()).default([...DEFAULT_RETRY_CODES]).description("Failure codes this plugin retries. Any other code is left to the loop unless its message is evidence of a transient condition."),
    retryAllCodes: schemastery.boolean().default(false).description("Retry every code that is not always-terminal and not excluded, including unclassified adapter codes."),
    maxRetriesPerTurn: nullableCount.default(DEFAULTS.maxRetriesPerTurn).description("Hard ceiling on retries inside one turn. Empty or null means no turn ceiling."),
    excludeCodes: schemastery.array(schemastery.string()).default([]).description("Failure codes that stay terminal even when listed in retryCodes."),
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
  // The plugin's own dependency is the first choice: a package installed with
  // its dependencies resolves the exact version it declares, without depending
  // on the profile's flattened module tree.
  try {
    return await import(specifier);
  } catch {
    /* fall through to the Host's copies */
  }
  const anchors = [
    // DSH sets this in the shell environment, and its install tree carries both
    // `zod` and `schemastery`. A profile often carries neither: it depends on the
    // CLI, not on every Harness package.
    process.env.DSH_INSTALL_DIR,
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
  return undefined;
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
 * Projection state schema for the one retry chain this plugin may own.
 *
 * The registry validates a replayed cell with `stateSchema.parse`, so this must
 * be a real zod schema: a hand-rolled `{ parse }` object registers fine and then
 * throws on the first resumed session. Building it once at module scope avoids
 * per-mount construction.
 *
 * The Session format validates one chain per `(turn, step, provider, policyKey)`
 * and requires one stable retryId inside it. The state therefore carries the
 * exact coordinates that own the current identity, not only its attempt count:
 * a different step or provider is a new chain and must start at attempt 1 with
 * a fresh retryId.
 */
const CHAIN_SCHEMA = await (async () => {
  const zod = await importZod();
  if (zod === undefined) return undefined;
  return zod.z.object({
    attempt: zod.z.number().int().nonnegative().default(0),
    retryId: zod.z.string().optional(),
    turn: zod.z.number().int().nonnegative().optional(),
    step: zod.z.number().int().nonnegative().optional(),
    provider: zod.z.string().optional(),
    // Retries already spent inside the current turn, across all its steps.
    turnAttempts: zod.z.number().int().nonnegative().default(0),
  });
})();

/** The schema export is optional; absence only removes the advertised form. */
export const Config = await loadConfigSchema();

/**
 * Read a number, falling back for anything that is not one.
 *
 * `Number(null)` is `0` and `Number("")` is `0`, so a plain `Number()` coercion
 * turns an absent or cleared field into zero — a clearing edit would silently
 * mean "set to zero", which for a delay is a busy loop and for a ratio is no
 * jitter at all. Absent means absent, so it takes the fallback.
 * @param value - the raw configured value.
 * @param fallback - value to use when `value` is not a usable number.
 * @returns a finite number.
 */
function finite(value, fallback) {
  if (value === null || value === undefined || value === "" || typeof value === "boolean") return fallback;
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
  const requestedInitial = Math.max(1, Math.round(finite(source.initialDelayMs, DEFAULTS.initialDelayMs)));
  const maxDelayMs = Math.max(1, Math.round(finite(source.maxDelayMs, DEFAULTS.maxDelayMs)));
  // `maxDelayMs` is a CEILING, so it wins a conflict. Raising it to fit an
  // oversized `initialDelayMs` would silently override the one setting an
  // operator uses to bound the whole plugin: asking for a 10 ms ceiling and
  // getting a 90 s first wait is the opposite of what that setting says.
  const initialDelayMs = Math.min(requestedInitial, maxDelayMs);
  const jitterRatio = Math.min(1, Math.max(0, finite(source.jitterRatio, DEFAULTS.jitterRatio)));

  const rawAttempts = source.maxAttempts;
  const parsedAttempts = rawAttempts === null || rawAttempts === undefined
    ? null
    : Math.trunc(finite(rawAttempts, 0));
  // 0 and negatives mean "no cap", matching how an empty panel field is read.
  const maxAttempts = parsedAttempts === null || parsedAttempts < 1 ? null : parsedAttempts;

  // 0 and negatives mean "no ceiling", matching how an empty panel field is read.
  const rawTurnLimit = source.maxRetriesPerTurn;
  const parsedTurnLimit = rawTurnLimit === null || rawTurnLimit === undefined
    ? DEFAULTS.maxRetriesPerTurn
    : Math.trunc(finite(rawTurnLimit, 0));
  const maxRetriesPerTurn = parsedTurnLimit < 1 ? null : parsedTurnLimit;

  // Canonical on both sides, so `Auth`, `auth` and ` AUTH ` are one exclusion.
  const legacyExcludes = Array.isArray(source.terminalCodes) ? source.terminalCodes : [];
  const excludeCodes = canonicalCodeSet([
    ...legacyExcludes,
    ...(Array.isArray(source.excludeCodes) ? source.excludeCodes : []),
  ]);
  const retryCodes = canonicalCodeSet(
    Array.isArray(source.retryCodes) && source.retryCodes.length > 0
      ? source.retryCodes
      : DEFAULT_RETRY_CODES,
  );

  const retired = Object.keys(RETIRED_KEYS).filter((key) => Object.hasOwn(source, key));

  return {
    autoRetry: source.autoRetry !== false,
    maxAttempts,
    initialDelayMs,
    maxDelayMs,
    jitterRatio,
    retryWithoutProviderPolicy: source.retryWithoutProviderPolicy !== false,
    classifyTransientFailures: source.classifyTransientFailures !== false,
    retryAllCodes: source.retryAllCodes === true,
    retryCodes,
    maxRetriesPerTurn,
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
    retryCodes: [...cfg.retryCodes],
    classifyTransientFailures: cfg.classifyTransientFailures,
    retryAllCodes: cfg.retryAllCodes,
    maxRetriesPerTurn: cfg.maxRetriesPerTurn,
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
    // Why a failure was left to the loop, newest first. A retry plugin that stays
    // silent about declining is indistinguishable from one that is broken.
    declines: [],
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
  for (const key of [
    "autoRetry", "retryWithoutProviderPolicy", "classifyTransientFailures",
    "retryAllCodes", "recordSessionEvents", "log",
  ]) {
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
  if (Object.hasOwn(patch, "retryCodes")) {
    if (!Array.isArray(patch.retryCodes)) {
      return { ok: false, status: 400, code: "invalid-value", message: "retryCodes must be an array of strings" };
    }
    const codes = [];
    for (const code of patch.retryCodes) {
      if (typeof code !== "string") return { ok: false, status: 400, code: "invalid-value", message: "retryCodes must contain only strings" };
      const trimmed = code.trim();
      if (trimmed.length === 0 || trimmed.length > 120) {
        return { ok: false, status: 400, code: "invalid-value", message: "each retried code must be 1..120 characters" };
      }
      if (!codes.includes(trimmed)) codes.push(trimmed);
    }
    value.retryCodes = codes;
  }
  if (Object.hasOwn(patch, "maxRetriesPerTurn")) {
    if (patch.maxRetriesPerTurn === null || patch.maxRetriesPerTurn === 0) value.maxRetriesPerTurn = null;
    else {
      const parsed = Number(patch.maxRetriesPerTurn);
      if (!Number.isFinite(parsed) || parsed < 1 || parsed > 10_000) {
        return { ok: false, status: 400, code: "invalid-value", message: "maxRetriesPerTurn must be null or an integer between 1 and 10000" };
      }
      value.maxRetriesPerTurn = Math.trunc(parsed);
    }
  }
  if (Object.hasOwn(patch, "markerFile")) {
    if (patch.markerFile === null) value.markerFile = null;
    else if (typeof patch.markerFile !== "string" || patch.markerFile.length === 0 || patch.markerFile.length > 4096) {
      return { ok: false, status: 400, code: "invalid-value", message: "markerFile must be null or a non-empty absolute path" };
    } else value.markerFile = patch.markerFile;
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
export { classifyFailure, statusOf };
export function apply(ctx, config) {
  const cfg = normalize(config);
  const stats = sharedStats();
  stats.mounts += 1;

  const lifetime = new AbortController();
  const active = new Set();

  /**
   * Session key -> number of waits in flight for that session.
   *
   * A count, not a Set: two failures for one session can be waiting at the same
   * time, and a Set would drop the session as soon as the shorter wait finished,
   * reporting "0 sessions retrying" while another wait was still running.
   */
  const activeSessions = new Map();
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

  // Boundaries that end the *step* chain. A turn boundary resets the turn
  // budget too; a step boundary must not, or the ceiling would be per-step and
  // a turn could still loop across steps.
  const STEP_RESETS = new Set(["step/start", "assistant/message"]);
  const TURN_RESETS = new Set(["turn/start", "turn/end"]);
  const CHAIN_RESETS = new Set([...STEP_RESETS, ...TURN_RESETS]);
  const EMPTY_CHAIN = Object.freeze({
    attempt: 0,
    retryId: undefined,
    turn: undefined,
    step: undefined,
    provider: undefined,
    turnAttempts: 0,
  });

  /**
   * Whether the projection handle drives the chain.
   *
   * From DSH 0.2.3 the registry returns a handle after an asynchronous
   * registration; that handle's `stateOf` is the only supported reader. The
   * bounded map stays in charge when registration is unavailable, and is used
   * only to count attempts that are not written to the session log.
   */
  let chainsRegistered = false;
  /** Why durable recording is on, off, or waiting; surfaced in the panel. */
  let projectionStatus = !cfg.recordSessionEvents
    ? "disabled-by-config"
    : CHAIN_SCHEMA === undefined ? "no-zod-schema" : "pending";
  let projectionError;
  /** The retained reader of the registered fold; undefined until registration settles. */
  let chainHandle;
  /**
   * Resolves true once the registered fold can prove a chain.
   *
   * Registration returns a handle asynchronously, and a durable retry event that
   * guessed its attempt number before the handle arrived would corrupt the log.
   * Recovery therefore awaits this before deciding whether it may write.
   */
  let projectionReady = Promise.resolve(false);
  if (cfg.recordSessionEvents && CHAIN_SCHEMA !== undefined) {
    // Optional service: a composition without projections still retries. Read
    // it through `get` (the same optional-access path the Web routes use) so
    // this plugin mounts without declaring a hard dependency on the registry.
    let projectionRegistry;
    try {
      projectionRegistry = typeof ctx.get === "function"
        ? ctx.get("sessionProjections")
        : ctx.sessionProjections;
    } catch {
      projectionRegistry = undefined;
    }
    if (typeof projectionRegistry?.register !== "function") {
      projectionStatus = "service-absent";
      log("warn", "sessionProjections is not mounted; retries continue without durable retry events");
    } else {
      try {
        const registered = projectionRegistry.register({
          key: CHAIN_KEY,
          // The chain coordinates are new state, and the step fold now drops the
          // retry identity instead of keeping it, so a 2 cell cannot seed this one.
          stateVersion: 3,
          stateSchema: CHAIN_SCHEMA,
          init: () => EMPTY_CHAIN,
          apply: (state, event) => {
            const type = event?.type;
            if (typeof type !== "string") return state;
            if (TURN_RESETS.has(type)) return EMPTY_CHAIN;
            if (STEP_RESETS.has(type)) {
              // The Session format owns one retryId per (turn, step, provider)
              // chain. A step boundary ends that chain, so its attempt count AND
              // its identity die here; only the turn budget survives.
              if (state.attempt === 0 && state.retryId === undefined
                && state.step === undefined && state.provider === undefined) return state;
              return { ...state, attempt: 0, retryId: undefined, step: undefined, provider: undefined };
            }
            if (type !== "llm/retry") return state;
            // Only this plugin's own retries own this chain.
            if (event.data?.policyKey !== POLICY_KEY) return state;
            const attempt = Number.isSafeInteger(event.data?.retry) && event.data.retry > 0 ? event.data.retry : 0;
            const turn = Number.isSafeInteger(event.data?.turn) && event.data.turn > 0 ? event.data.turn : undefined;
            const step = Number.isSafeInteger(event.data?.step) && event.data.step > 0 ? event.data.step : undefined;
            const provider = nonEmptyString(event.data?.provider);
            const retryId = nonEmptyString(event.data?.retryId);
            if (attempt === 0 || turn === undefined || step === undefined
              || provider === undefined || retryId === undefined) return state;
            const sameChain = turn === state.turn && step === state.step && provider === state.provider;
            if (sameChain && attempt === state.attempt && retryId === state.retryId) return state;
            const sameTurn = turn === state.turn;
            return {
              attempt,
              retryId,
              turn,
              step,
              provider,
              turnAttempts: (sameTurn ? (state.turnAttempts ?? 0) : 0) + 1,
            };
          },
        });
        projectionReady = Promise.resolve(registered).then(
          (handle) => {
            if (handle === null || typeof handle !== "object" || typeof handle.stateOf !== "function") {
              projectionStatus = "no-handle";
              projectionError = "registration returned no reader";
              log("warn", "session projection registration returned no reader; retries continue without durable retry events");
              return false;
            }
            chainHandle = handle;
            chainsRegistered = true;
            projectionStatus = "registered";
            return true;
          },
          (error) => {
            projectionStatus = "unavailable";
            projectionError = String(error);
            log("warn", `session projection registration failed (${String(error)}); retries continue without durable retry events`);
            return false;
          },
        );
      } catch (error) {
        projectionStatus = "register-failed";
        projectionError = String(error);
        log("warn", `session projections unavailable (${String(error)}); retries continue without durable retry events`);
      }
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
      const current = fallbackChains.get(id);
      if (current === undefined) return;
      // A step boundary ends the chain's identity but must keep the turn budget;
      // a turn boundary ends both.
      fallbackChains.set(id, TURN_RESETS.has(type)
        ? EMPTY_CHAIN
        : { ...current, attempt: 0, retryId: undefined, step: undefined, provider: undefined });
    });
  }

  /**
   * Release one in-flight wait for a session.
   * @param key - the session key counted by {@link activeSessions}.
   */
  function leaveSession(key) {
    const remaining = (activeSessions.get(key) ?? 1) - 1;
    if (remaining <= 0) activeSessions.delete(key);
    else activeSessions.set(key, remaining);
  }

  /**
   * Read the chain that owns one session's current request series.
   * @param session - the session that owns the chain.
   * @returns the chain state, or undefined when a registered fold cannot prove it.
   */
  function chainFor(session) {
    if (chainsRegistered) {
      try {
        const state = chainHandle?.stateOf(session);
        if (state !== null && typeof state === "object") return state;
      } catch (error) {
        // A registered unit that cannot answer leaves no provable identity. Do not
        // guess one from an empty local map: a wrong attempt number or a reused
        // retryId corrupts the stored log permanently. Leave this attempt to the
        // loop instead, and say why once.
        if (!projectionReadFailed) {
          projectionReadFailed = true;
          log(
            "warn",
            `cannot read the retry chain from this session (${String(error)}); `
              + `this attempt is left to the loop instead of written without a provable identity`,
          );
        }
      }
      return undefined;
    }
    const id = session?.id ?? "unidentified-session";
    return fallbackChains.get(id) ?? EMPTY_CHAIN;
  }

  /**
   * Record one scheduled attempt in the bounded local map.
   *
   * This runs only when the session log will not fold the attempt: the projection
   * is absent, or this mount is not writing durable events at all.
   * @param session - the owning session.
   * @param attempt - the attempt number being scheduled.
   * @param retryId - the identity shared by the retry's two durable events.
   * @param turn - the turn this attempt belongs to, for the turn ceiling.
   * @param step - the step owning the chain.
   * @param provider - the provider owning the chain.
   */
  function rememberChain(session, attempt, retryId, turn, step, provider) {
    const id = session?.id ?? "unidentified-session";
    if (fallbackChains.size >= FALLBACK_LIMIT && !fallbackChains.has(id)) {
      const oldest = fallbackChains.keys().next().value;
      if (oldest !== undefined) fallbackChains.delete(oldest);
    }
    const previous = fallbackChains.get(id);
    const sameTurn = previous?.turn !== undefined && turn !== undefined && previous.turn === turn;
    fallbackChains.set(id, {
      attempt,
      retryId,
      turn,
      step,
      provider,
      turnAttempts: (sameTurn ? previous.turnAttempts ?? 0 : 0) + 1,
    });
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
        // Durable events need a registered projection: without a provable
        // chain identity the plugin retries but writes nothing, so a stale
        // panel must not claim the chat surface will show this retry.
        recordSessionEvents: cfg.recordSessionEvents && chainsRegistered,
        // A panel must be able to distinguish "off by choice" from "the
        // projection could not register"; both suppress the chat retry chain.
        sessionProjection: projectionStatus,
        sessionProjectionError: projectionError,
      },
      ladder: ladder(),
      recommendedExclude: [...RECOMMENDED_EXCLUDE],
      // The real Harness vocabulary, so the panel can offer a picker instead of
      // asking an operator to spell a constant from memory. Providers still
      // surface their own codes, which is why the input stays free text too.
      knownFailureCodes: [...KNOWN_FAILURE_CODES],
      // The codes the Harness itself declares retryable: the panel shows these as
      // the default scope and offers them in the picker.
      harnessRetryableCodes: [...DEFAULT_RETRY_CODES],
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
      // Separated from `stats` because the panel renders it as an explanation,
      // not as a counter, and it carries the only record of what was refused.
      declines: stats.declines.slice(0, RECENT_LIMIT),
    };
  }

  /** One attempted schedule: record durably when provable, count, wait, then confirm. */
  async function backoff(agent, turn, step, provider, failure, attempt, retryId, delayMs, session, signal, recordEvents) {
    const fused = fuseSignals([signal, lifetime.signal]);
    if (fused.signal.aborted) {
      fused.release();
      return false;
    }
    const code = nonEmptyString(failure?.code) ?? "UNKNOWN";
    const route = nonEmptyString(provider) ?? "unknown";

    // Durable BEFORE the wait, so the log shows a wait that really happened.
    if (recordEvents) {
      record(agent, "llm/retry", {
        retryId,
        turn,
        step,
        provider: route,
        // mode "always" carries no maxRetries, so the chat surface renders the
        // budget as unbounded even when this plugin caps attempts per step.
        mode: "always",
        policyKey: POLICY_KEY,
        retry: attempt,
        delayMs,
        failure: normalizeFailure(failure),
      });
    }

    const sessionKey = session?.id ?? "unidentified-session";
    activeSessions.set(sessionKey, (activeSessions.get(sessionKey) ?? 0) + 1);
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
    leaveSession(sessionKey);
    fused.release();
    if (!completed || fused.signal.aborted) return false;

    if (recordEvents) {
      record(agent, "llm/retry-started", {
        retryId,
        turn,
        step,
        retry: attempt,
      });
    }
    return true;
  }

  /** Decide whether this layer owns recovery for one failed request. */
  async function recover(payload, next) {
    // Every deeper-in-composition layer gets the first word.
    const downstream = typeof next === "function" ? await next() : undefined;
    if (!cfg.autoRetry) return downstream;
    if (downstream?.kind === "retry") return downstream;

    const { agent, turn, step, provider, failure, signal, retryPolicy } = payload ?? {};
    // `typeof` rather than a truthiness test: a `null` payload field must be
    // rejected here, not dereferenced below. This listener sits in a waterfall
    // the agent loop awaits without a catch of its own, so throwing here would
    // replace the provider's failure with a TypeError and lose the real error.
    if (typeof agent !== "object" || agent === null) return downstream;
    if (typeof failure !== "object" || failure === null) return downstream;
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
    /**
     * Refuse a failure, and say why in a way the panel can show.
     *
     * Every decline is recorded: a plugin that silently does nothing is
     * indistinguishable from one that is broken, and the operator has no way to
     * learn which code needs adding.
     */
    const decline = (reason, detail) => {
      bump(stats.terminalSeen, code);
      stats.declines.unshift({
        at: new Date().toISOString(),
        code,
        reason,
        detail,
        message: typeof failure.message === "string" ? failure.message.slice(0, 300) : "",
      });
      if (stats.declines.length > RECENT_LIMIT) stats.declines.length = RECENT_LIMIT;
      log("info", `failure "${code}" left to the loop: ${detail}`);
      return downstream;
    };

    if (ALWAYS_TERMINAL.has(code)) {
      return decline("cancelled", "a cancellation is not a fault");
    }

    if (cfg.excludeCodes.has(code)) {
      return decline("excluded", "listed in excludeCodes");
    }

    // What the failure says, when its code is not enough to tell.
    //
    // A provider that namespaces its errors (`InferHub.ModelArts.81001.400`) never
    // matches a Harness literal, so a policy built only from literals degrades to
    // "retry nothing" for precisely the providers most likely to be flaky.
    const verdict = cfg.classifyTransientFailures ? classifyFailure(failure) : "unknown";
    if (verdict === "retry") {
      log("info", `failure "${code}" reports a recoverable condition; retrying`);
    } else if (verdict === "stop") {
      return decline("permanent", "the failure itself says a retry cannot clear it");
    }

    // Retry scope. A code outside the allow-list is the Harness's own signal that
    // re-sending will not help, or an adapter code nobody classified — and an
    // unclassified code is exactly what produced the endless turns under 2.x,
    // where everything except a cancellation was retried.
    if (verdict !== "retry" && !cfg.retryAllCodes && !cfg.retryCodes.has(code)) {
      return decline(
        "unknown-code",
        `code is not in the retry set and its message carries no transient evidence `
          + `(retryCodes: ${[...cfg.retryCodes].join(", ") || "none"})`,
      );
    }

    // A durable retry chain is addressed by (turn, step, provider, policyKey).
    // The Session format requires one retryId inside a chain, a fresh id in every
    // new chain, and attempt 1 there. Reusing an identity across steps, or starting
    // a new chain at attempt 2, makes the stored log permanently unreadable
    // (issue #1); so only the exact coordinates that own the chain may continue it.
    const coordinatesValid = Number.isSafeInteger(turn) && turn > 0
      && Number.isSafeInteger(step) && step > 0
      && typeof provider === "string" && provider.length > 0;
    // Registration delivers its handle on a microtask; a failure can arrive in
    // the same tick as the first mount. Await readiness so an event never guesses
    // its attempt number before the registered fold can prove the chain.
    const durable = cfg.recordSessionEvents ? await projectionReady : false;
    if (durable && !coordinatesValid) {
      return decline(
        "unprovable-chain",
        "the loop did not report turn, step and provider for this failure; a retry event cannot be written without corrupting the session log",
      );
    }

    // The ladder is keyed by the session, never by the agent object: the session
    // is created before the agent that owns it, and the agent itself carries no
    // `id`. `chainFor` returns undefined when a registered fold cannot prove the
    // chain, so that case delegates rather than minting a fresh ladder per call.
    const session = agent?.session;
    const chain = chainFor(session);
    if (chain === undefined) {
      bump(stats.terminalSeen, code);
      log("warn", `retry chain is unreadable for "${code}"; left to the loop`);
      return downstream;
    }

    const sameChain = chain.attempt > 0
      && chain.turn === turn && chain.step === step && chain.provider === provider;
    const attempt = sameChain ? chain.attempt + 1 : 1;
    if (cfg.maxAttempts !== null && attempt > cfg.maxAttempts) {
      log("warn", `attempt limit ${cfg.maxAttempts} reached for "${code}"; left to the loop`);
      return downstream;
    }

    // Turn ceiling. The step ladder resets every step, so a fault that survives
    // each step would otherwise restart at attempt 1 forever and the turn would
    // never end. This is the backstop that makes that impossible even for a code
    // the allow-list accepts.
    if (cfg.maxRetriesPerTurn !== null) {
      const spentThisTurn = chain.turn !== undefined && chain.turn === turn ? chain.turnAttempts ?? 0 : 0;
      if (spentThisTurn >= cfg.maxRetriesPerTurn) {
        bump(stats.terminalSeen, code);
        log(
          "warn",
          `turn retry ceiling ${cfg.maxRetriesPerTurn} reached for "${code}"; left to the loop`,
        );
        return downstream;
      }
    }

    // One identity per retry chain, so the two durable events pair up. A new
    // chain always mints one; only the chain that owns the coordinates continues
    // with the recorded identity.
    const retryId = sameChain && chain.retryId !== undefined ? chain.retryId : newRetryId();

    let delayMs = localDelay(cfg, attempt, Math.random);
    const retryAfter = failure?.providerRetryAfterMs;
    if (Number.isFinite(retryAfter) && retryAfter > 0) {
      delayMs = Math.min(Math.max(1, Math.round(retryAfter)), cfg.maxDelayMs);
    }

    // Count locally when no event will fold the attempt: durable recording is
    // off, or the projection is unavailable. When an event is written, the fold
    // it causes IS the state update.
    if (!durable || !coordinatesValid) {
      rememberChain(session, attempt, retryId, turn, step, provider);
    }
    if (!(await backoff(agent, turn, step, provider, failure, attempt, retryId, delayMs, session, signal, durable && coordinatesValid))) {
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
    // DSH 0.2.3's WebServer owns browser admission: a route defaults to
    // `required` and the Host's connection services decide it through
    // `webserver/authorize`. Route handlers receive only admitted requests. The
    // old manual `connection.requestRejection` check is gone, and with it the
    // "no admission service" refusal that broke panel writes on a current Host.
    webCtx.effect(() => webCtx.webServer.register({
      kind: "exact",
      path: STATS_PATH,
      auth: "required",
      handler: (req, res) => {
        if (req.method !== "GET" && req.method !== "HEAD") {
          sendMethodNotAllowed(res, "GET, HEAD");
          return;
        }
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
      auth: "required",
      handler: async (req, res) => {
        if (req.method !== "POST") {
          sendMethodNotAllowed(res, "POST");
          return;
        }
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
        stats.declines = [];
        sendJson(res, 200, { ok: true, stats: snapshot().stats });
      },
    }), "unlimited-retry: reset route");

    webCtx.effect(() => webCtx.webServer.register({
      kind: "exact",
      path: CONFIG_PATH,
      auth: "required",
      handler: async (req, res) => {
        if (req.method !== "POST") {
          sendMethodNotAllowed(res, "POST");
          return;
        }
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

  // The Settings service derives a form page for every active Loader entry.
  // This plugin ships its own panel, so declare that page instead of letting a
  // generated form compete with it. The Settings/Plugins surfaces then render
  // `settings.section` on the bundle row, which is the 0.2.3 behavior this
  // plugin targets.
  if (typeof ctx.inject === "function" && ctx.fiber !== undefined) {
    try {
      ctx.inject(["settings"], (settingsCtx) => {
        settingsCtx.effect(
          () => settingsCtx.settings.configure({ auto: false }, ctx.fiber),
          "unlimited-retry: custom settings page",
        );
      });
    } catch (error) {
      log("warn", `could not declare the custom settings page (${String(error)})`);
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
