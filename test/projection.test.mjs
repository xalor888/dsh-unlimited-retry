/**
 * Integration tests against the REAL session-projection service and the REAL
 * Cordis dispatcher.
 *
 * The unit tests use a double for both, which is fast but cannot prove that the
 * plugin's registration, its zod state schema, and its scope handling actually
 * match the shipped contracts. These tests mount the shipped projection plugin
 * and dispatch through real Cordis contexts, so a mismatch fails here instead of
 * in a user's session.
 */
import { test as nodeTest } from "node:test";
import assert from "node:assert/strict";

/**
 * Locate the installed Harness.
 *
 * These tests exist to mount the REAL projection service and the REAL Cordis
 * dispatcher, so they need a Harness installation. CI has none, and a hard-coded
 * path would either fail there or silently test a stale copy. Resolution order:
 * `DSH_HOME`-derived install, an explicit `DSH_INSTALL_DIR`, then the default
 * global prefix. When none resolves, the suite skips rather than lying.
 */
// An explicit DSH_INSTALL_DIR is authoritative: it either works or the suite
// skips, so CI can assert the integration path is really exercised.
const EXPLICIT = process.env.DSH_INSTALL_DIR;
// DSH_INSTALL_DIR is set by the Harness when it spawns a shell, and it may point
// either at the dsh package or at its node_modules. Accept both, or the
// integration tests silently skip in exactly the environment they exist to test.
const candidatesFor = (root) => [
  root,
  `${root}/node_modules`,
  `${root}/node_modules/@deepseek-ai`,
];
const CANDIDATES = EXPLICIT === undefined
  ? [
      `${process.env.HOME ?? ""}/.local/lib/node_modules/@deepseek-ai/dsh/node_modules`,
      `${process.env.HOME ?? ""}/.local/lib/node_modules/@deepseek-ai/dsh`,
      "/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules",
      "/opt/homebrew/lib/node_modules/@deepseek-ai/dsh/node_modules",
    ]
  : candidatesFor(EXPLICIT);

const { existsSync, realpathSync } = await import("node:fs");
const { dirname, join } = await import("node:path");
const HARNESS = CANDIDATES.find(
  (candidate) => typeof candidate === "string" && candidate.length > 0
    && existsSync(`${candidate}/@deepseek-ai/cordis/lib/index.js`),
);

/**
 * Locate the Session format catalog, which the JSONL backend imports but which
 * is not linked beside every source-install layout. A packaged install exposes
 * it directly; a source install keeps it beside the JSONL package's real path.
 * @returns the catalog module path, or undefined when neither layout carries it.
 */
function catalogPath() {
  const direct = `${HARNESS}/@deepseek-ai/dsh-session-format-catalog/lib/index.js`;
  if (existsSync(direct)) return direct;
  try {
    const jsonl = realpathSync(`${HARNESS}/@deepseek-ai/dsh-session-persistence-jsonl`);
    const sibling = join(dirname(jsonl), "session-format-catalog/lib/index.js");
    if (existsSync(sibling)) return sibling;
  } catch {
    /* no JSONL package in this layout */
  }
  return undefined;
}

process.env.DSH_PROFILE = process.env.DSH_PROFILE ?? "web";
process.env.DSH_PROFILE_DIR = process.env.DSH_PROFILE_DIR ?? `${process.env.HOME}/.dsh/profiles/web`;

const plugin = await import("../index.js");

// An absent Harness is a missing prerequisite, not a passing test.
const skip = HARNESS === undefined
  ? "no installed DeepSeek Harness found; set DSH_INSTALL_DIR to run the integration tests"
  : false;

// Imported lazily so the skip path never touches a missing path.
/** Register a test, skipping the whole file when no Harness is installed. */
const it = (title, fn) => (skip === false ? nodeTest(title, fn) : nodeTest.skip(title, fn));

const { Context } = HARNESS === undefined ? {} : await import(`${HARNESS}/@deepseek-ai/cordis/lib/index.js`);
const { default: projectionPlugin } = HARNESS === undefined
  ? {}
  : await import(`${HARNESS}/@deepseek-ai/dsh-session-projection/lib/index.js`);
const CATALOG = HARNESS === undefined ? undefined : catalogPath();
const { sessionFormatCatalog } = CATALOG === undefined
  ? {}
  : await import(CATALOG);
/** The V4 relationship test needs the shipped catalog; a layout without it skips. */
const catalogSkip = CATALOG === undefined
  ? "no Session format catalog resolvable beside this Harness install"
  : false;
const v4Test = (title, fn) => (skip === false && catalogSkip === false ? nodeTest(title, fn) : nodeTest.skip(title, fn));

/**
 * A session double complete enough for the real registry to fold its log.
 *
 * `seq` on each recorded event is not cosmetic: the registry refuses to advance
 * a cell across a missing seq, and treats that as a hard error.
 */
function realishSession(id) {
  const events = [];
  const session = {
    id,
    header: {},
    inheritedEventCount: 0,
    seq: 0,
    surface: { nodes: [] },
    snapshotEvents: () => events.slice(),
    eventAt: (seq) => events[Number(seq)],
    append(type, data) {
      const seq = session.seq;
      events.push({ type, data, seq });
      session.seq += 1;
      return { seq };
    },
    get events() {
      return events;
    },
  };
  return session;
}

/** Mount the shipped projection service on a fresh root context. */
async function projectionRoot() {
  const root = new Context();
  root.plugin(projectionPlugin);
  await new Promise((resolve) => setTimeout(resolve, 60));
  return root;
}

/** Fire one request failure through the real dispatcher. */
function fire(app, session, failure = { message: "x", code: "TRANSPORT" }) {
  return app.waterfall(
    "agent/request-error",
    { agent: { session }, turn: 1, step: 1, provider: "provider", failure, signal: new AbortController().signal },
    async () => undefined,
  );
}

it("against the real registry, maxAttempts bounds the step and a new step resets it", async () => {
  const root = await projectionRoot();
  const app = root.extend();
  plugin.apply(app, { initialDelayMs: 1, maxDelayMs: 2, maxAttempts: 2 });

  const session = realishSession("integration-1");
  assert.deepEqual(await fire(app, session), { kind: "retry" });
  assert.deepEqual(await fire(app, session), { kind: "retry" });
  assert.equal(await fire(app, session), undefined, "the cap is enforced through the folded ladder");

  session.append("step/start", { turn: 2, step: 1 });
  assert.deepEqual(await fire(app, session), { kind: "retry" }, "a new step restarts the ladder");
});

it("the registered state schema round-trips a cell the registry will replay", async () => {
  // The registry validates a replayed cell with `stateSchema.parse`, so an
  // inadequate schema registers cleanly and only fails on resume.
  const root = await projectionRoot();
  const app = root.extend();
  plugin.apply(app, { initialDelayMs: 1, maxDelayMs: 2 });

  const session = realishSession("integration-2");
  await fire(app, session);

  // Force a full re-materialization from the recorded log, which is the resume path.
  const value = root.sessionProjections.stateOf(session, "unlimitedRetryChain");
  assert.equal(typeof value?.attempt, "number");
  assert.equal(value.attempt, 1);
});

it("the ladder dies with its session instead of accumulating per session", async () => {
  const root = await projectionRoot();
  const app = root.extend();
  plugin.apply(app, { initialDelayMs: 1, maxDelayMs: 1 });

  // Many independent sessions: each retries once, and none share a ladder.
  for (let index = 0; index < 50; index += 1) {
    const session = realishSession(`integration-many-${index}`);
    const action = await fire(app, session);
    assert.deepEqual(action, { kind: "retry" }, `session ${index} retried independently`);
    assert.equal(root.sessionProjections.stateOf(session, "unlimitedRetryChain").attempt, 1);
  }
});

/**
 * Reopen a synthetic-but-physical V4 log through the shipped relationship
 * validator. The log carries the framework rows a retry chain needs around the
 * plugin's own events; only the plugin events vary between tests.
 * @param events - the Session events the plugin appended.
 */
function validateV4Rows(events) {
  const rows = [{ type: "turn/start", data: { turn: 1 } }];
  for (const step of [1, 2]) {
    rows.push({ type: "step/start", data: { turn: 1, step } });
    rows.push({
      type: "request/header",
      data: { reason: "initial", header: { config: { provider: "mock", model: "mock" } } },
    });
    rows.push(...events
      .filter((event) => (event.type === "llm/retry" || event.type === "llm/retry-started") && event.data?.step === step)
      .map((event) => ({ type: event.type, data: event.data })));
    rows.push({ type: "step/end", data: { turn: 1, step } });
  }
  rows.push({ type: "turn/end", data: { turn: 1, reason: { kind: "completed" } } });

  const restore = sessionFormatCatalog.createRestore(
    { type: "session", version: 4, id: "retry-chain", createdAt: 1, delegationDepth: 0, isSeeded: false },
    { recovery: "strict", validation: "current" },
  );
  for (const [seq, candidate] of rows.entries()) {
    const event = { ...candidate, seq, time: seq + 1 };
    restore.decodeRow(JSON.parse(JSON.stringify(sessionFormatCatalog.encodeCurrentEvent(event))));
  }
  return restore.finish();
}

v4Test("two retrying steps in one turn write two valid V4 chains", async () => {
  const root = await projectionRoot();
  const app = root.extend();
  plugin.apply(app, { initialDelayMs: 1, maxDelayMs: 2, maxAttempts: 2, jitterRatio: 0 });

  const session = realishSession("integration-v4-chain");
  const fire = (step) => app.waterfall(
    "agent/request-error",
    {
      agent: { session },
      turn: 1,
      step,
      provider: "mock",
      failure: { message: "boom", code: "TRANSPORT" },
      signal: new AbortController().signal,
    },
    async () => undefined,
  );

  assert.deepEqual(await fire(1), { kind: "retry" });
  assert.deepEqual(await fire(1), { kind: "retry" });
  session.append("step/start", { turn: 1, step: 2 });
  assert.deepEqual(await fire(2), { kind: "retry" });

  const retries = session.events.filter((event) => event.type === "llm/retry");
  assert.equal(retries.length, 3, "two attempts in step 1 and one in step 2");
  assert.equal(retries[0].data.retryId, retries[1].data.retryId, "one chain keeps one retryId");
  assert.notEqual(retries[2].data.retryId, retries[0].data.retryId, "a new step starts a new chain");
  assert.equal(retries[2].data.retry, 1, "and at attempt 1");

  // The real loader must accept the physical log. This is the assertion 3.1.0
  // failed after a restart: the validator rejects a chain that reuses an id.
  assert.doesNotThrow(() => validateV4Rows(session.events));

  const corrupt = session.events.map((event) => event.type.startsWith("llm/retry") && event.data.step === 2
    ? { ...event, data: { ...event.data, retryId: retries[0].data.retryId } }
    : event);
  assert.throws(() => validateV4Rows(corrupt), /retryId per policy chain|scheduled coordinates/);
});

it("a cancellation is declined through the real dispatcher too", async () => {
  const root = await projectionRoot();
  const app = root.extend();
  plugin.apply(app, { initialDelayMs: 1, maxDelayMs: 2, excludeCodes: [] });

  const session = realishSession("integration-abort");
  assert.equal(await fire(app, session, { message: "cancelled", code: "ABORTED" }), undefined);
  assert.equal(session.events.filter((event) => event.type === "llm/retry").length, 0);
});

it("cancelling the turn during the wait stops the retry", async () => {
  const root = await projectionRoot();
  const app = root.extend();
  plugin.apply(app, { initialDelayMs: 5_000, maxDelayMs: 5_000, jitterRatio: 0 });

  const session = realishSession("integration-cancel");
  const controller = new AbortController();
  const pending = app.waterfall(
    "agent/request-error",
    {
      agent: { session },
      turn: 1,
      step: 1,
      provider: "provider",
      failure: { message: "x", code: "TRANSPORT" },
      signal: controller.signal,
    },
    async () => undefined,
  );
  setTimeout(() => controller.abort(), 10);

  assert.equal(await pending, undefined, "an aborted wait claims no retry");
  const types = session.events.map((event) => event.type);
  assert.deepEqual(types, ["llm/retry"], "the scheduled record survives, the started record does not");
});

it("sibling agents under one composition each get their own ladder", async () => {
  const root = await projectionRoot();
  const app = root.extend();
  plugin.apply(app, { initialDelayMs: 1, maxDelayMs: 2, maxAttempts: 1 });

  const first = realishSession("sibling-a");
  const second = realishSession("sibling-b");

  assert.deepEqual(await fire(app, first), { kind: "retry" });
  assert.deepEqual(await fire(app, second), { kind: "retry" }, "the second agent is not capped by the first");
  assert.equal(await fire(app, first), undefined, "the first agent is capped on its own ladder");
});
