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
const CANDIDATES = EXPLICIT === undefined
  ? [
      `${process.env.HOME ?? ""}/.local/lib/node_modules/@deepseek-ai/dsh/node_modules`,
      "/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules",
      "/opt/homebrew/lib/node_modules/@deepseek-ai/dsh/node_modules",
    ]
  : [EXPLICIT];

const { existsSync } = await import("node:fs");
const HARNESS = CANDIDATES.find(
  (candidate) => typeof candidate === "string" && candidate.length > 0
    && existsSync(`${candidate}/@deepseek-ai/cordis/lib/index.js`),
);

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
function fire(app, session, failure = { message: "x", code: "NETWORK" }) {
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
      failure: { message: "x", code: "NETWORK" },
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
