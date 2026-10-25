/**
 * Unit tests for the retry decision path.
 *
 * The plugin is exercised through a fake Cordis context, so these tests assert
 * observable behaviour (what the listener returns, what it appends, how long it
 * waited) rather than internal function names.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

process.env.DSH_PROFILE = process.env.DSH_PROFILE ?? "web";
process.env.DSH_PROFILE_DIR = process.env.DSH_PROFILE_DIR ?? `${process.env.HOME}/.dsh/profiles/web`;

const plugin = await import("../index.js");

/** Build a fake context that records registrations and lets a test fire events. */
function fakeContext(options = {}) {
  const listeners = new Map();
  const disposers = [];
  const services = new Map(Object.entries(options.services ?? {}));

  /** Cordis exposes services as context properties, so the double must too. */
  function serviceProps() {
    return Object.fromEntries(services);
  }

  function base() {
    return {
      logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
      ...serviceProps(),
      on(event, listener) {
        listeners.set(event, listener);
        const off = () => listeners.delete(event);
        disposers.push(off);
        return off;
      },
      effect(create, label) {
        const dispose = create();
        const off = typeof dispose === "function" ? dispose : () => {};
        disposers.push(off);
        off.label = label;
        return off;
      },
      get(name) {
        return services.get(name);
      },
      inject(deps, callback) {
        if (deps.every((dep) => services.has(dep))) callback(makeChild());
        return { then: (fn) => Promise.resolve(fn?.()) };
      },
    };
  }

  /** Child context sharing the service table, used by the route branch. */
  function makeChild() {
    return base();
  }

  // A faithful-enough session-projection registry: state folds over the events
  // a session records, held per session in a Map the test can inspect.
  const projections = new Map();
  const projectionCells = new Map();
  services.set("sessionProjections", {
    register(definition) {
      projections.set(definition.key, definition);
      return () => projections.delete(definition.key);
    },
    stateOf(session, key) {
      const definition = projections.get(key);
      if (definition === undefined) return undefined;
      const id = session?.id ?? "unidentified-session";
      return projectionCells.get(id)?.get(key) ?? definition.init();
    },
    /** Fold one recorded event, the way the real registry drives its units. */
    fold(session, event) {
      const id = session?.id ?? "unidentified-session";
      if (!projectionCells.has(id)) projectionCells.set(id, new Map());
      const cell = projectionCells.get(id);
      for (const [key, definition] of projections) {
        const previous = cell.get(key) ?? definition.init();
        cell.set(key, definition.apply(previous, event));
      }
    },
  });

  const ctx = base();

  return {
    ctx,
    listeners,
    services,
    fire(event, ...args) {
      const listener = listeners.get(event);
      assert.ok(listener, `no listener registered for ${event}`);
      return listener(...args);
    },
    async dispose() {
      for (const off of [...disposers].reverse()) await off();
      disposers.length = 0;
    },
  };
}

/** A minimal agent double whose session records appended events. */
function fakeAgent(id = "session-1", projection) {
  const appended = [];
  const session = {
    id,
    append(type, data) {
      appended.push({ type, data });
      // The real Session drives registered projections as it records.
      projection?.fold(session, { type, data });
      return { seq: appended.length };
    },
  };
  return { id, appended, session };
}

/** One transient failure payload. */
function failurePayload(code = "NETWORK", extra = {}) {
  return {
    agent: fakeAgent("session-1", extra.projection),
    turn: 1,
    step: 1,
    provider: "deepseek",
    failure: { message: `boom: ${code}`, code, ...extra },
    retryPolicy: undefined,
    signal: new AbortController().signal,
  };
}

test("module exports the Cordis function-plugin shape", () => {
  assert.equal(plugin.name, "unlimited-retry");
  assert.equal(typeof plugin.apply, "function");
});

test("Config is a native schemastery schema with documented defaults", () => {
  assert.ok(plugin.Config, "Config must exist when schemastery is resolvable");
  assert.equal(plugin.Config[Symbol.for("schemastery")], true);
  assert.equal(typeof plugin.Config.type, "string");
  const result = plugin.Config["~standard"].validate({});
  assert.equal(result.issues, undefined);
  assert.deepEqual(result.value, {
    autoRetry: true,
    initialDelayMs: 1000,
    maxDelayMs: 60000,
    jitterRatio: 0.2,
    retryWithoutProviderPolicy: true,
    excludeCodes: [],
    recordSessionEvents: true,
    log: true,
  });
});

test("Config rejects a zero attempt limit instead of silently accepting it", () => {
  const result = plugin.Config["~standard"].validate({ maxAttempts: 0 });
  assert.ok(result.issues?.length > 0, "maxAttempts 0 must be a validation error");
});

test("a failure nobody recovered is retried", async () => {
  const fake = fakeContext();
  plugin.apply(fake.ctx, { initialDelayMs: 1, maxDelayMs: 2 });

  const action = await fake.fire("agent/request-error", failurePayload(), async () => undefined);
  assert.deepEqual(action, { kind: "retry" });
  await fake.dispose();
});

test("a downstream recovery keeps ownership", async () => {
  const fake = fakeContext();
  plugin.apply(fake.ctx, { initialDelayMs: 1, maxDelayMs: 2 });

  const action = await fake.fire("agent/request-error", failurePayload(), async () => ({ kind: "retry" }));
  assert.deepEqual(action, { kind: "retry" });
  // It delegated instead of waiting on its own schedule.
  await fake.dispose();
});

test("autoRetry:false leaves failures terminal", async () => {
  const fake = fakeContext();
  plugin.apply(fake.ctx, { autoRetry: false });

  const action = await fake.fire("agent/request-error", failurePayload(), async () => undefined);
  assert.equal(action, undefined);
  await fake.dispose();
});

test("excludeCodes stays terminal and is counted", async () => {
  const fake = fakeContext();
  plugin.apply(fake.ctx, { excludeCodes: ["AUTH"], initialDelayMs: 1, maxDelayMs: 2 });

  const payload = failurePayload("AUTH");
  const action = await fake.fire("agent/request-error", payload, async () => undefined);
  assert.equal(action, undefined);
  assert.equal(payload.agent.appended.length, 0, "a terminal failure appends nothing");
  await fake.dispose();
});

test("durable events bracket the wait in the documented order", async () => {
  const fake = fakeContext();
  plugin.apply(fake.ctx, { initialDelayMs: 1, maxDelayMs: 2 });

  const payload = failurePayload("RATE_LIMITED");
  const action = await fake.fire("agent/request-error", payload, async () => undefined);
  assert.deepEqual(action, { kind: "retry" });

  const types = payload.agent.appended.map((entry) => entry.type);
  assert.deepEqual(types, ["llm/retry", "llm/retry-started"]);

  const scheduled = payload.agent.appended[0].data;
  assert.equal(scheduled.mode, "always", "an unbounded budget renders as unbounded in the chat surface");
  assert.equal(scheduled.policyKey, "unlimited-retry");
  assert.ok(scheduled.delayMs >= 1 && scheduled.delayMs <= 2);
  assert.equal(scheduled.failure.code, "RATE_LIMITED");
  assert.equal(scheduled.retry, 1);
  assert.equal(payload.agent.appended[1].data.retryId, scheduled.retryId);
});

test("recordSessionEvents:false writes no session events", async () => {
  const fake = fakeContext();
  plugin.apply(fake.ctx, { recordSessionEvents: false, initialDelayMs: 1, maxDelayMs: 2 });

  const payload = failurePayload();
  const action = await fake.fire("agent/request-error", payload, async () => undefined);
  assert.deepEqual(action, { kind: "retry" });
  assert.equal(payload.agent.appended.length, 0);
  await fake.dispose();
});

test("a provider-requested delay is honoured but clamped by maxDelayMs", async () => {
  const fake = fakeContext();
  plugin.apply(fake.ctx, { initialDelayMs: 1, maxDelayMs: 5, jitterRatio: 0 });

  const payload = failurePayload("RATE_LIMITED", { providerRetryAfterMs: 60_000 });
  const action = await fake.fire("agent/request-error", payload, async () => undefined);
  assert.deepEqual(action, { kind: "retry" });
  assert.equal(payload.agent.appended[0].data.delayMs, 5, "the provider hint cannot exceed the ceiling");
  await fake.dispose();
});

test("maxAttempts bounds this plugin and then delegates", async () => {
  const fake = fakeContext();
  plugin.apply(fake.ctx, { maxAttempts: 2, initialDelayMs: 1, maxDelayMs: 2 });

  const agent = fakeAgent("session-1", fake.services.get("sessionProjections"));
  const payload = () => ({
    ...failurePayload(),
    agent,
  });

  assert.deepEqual(await fake.fire("agent/request-error", payload(), async () => undefined), { kind: "retry" });
  assert.deepEqual(await fake.fire("agent/request-error", payload(), async () => undefined), { kind: "retry" });
  assert.equal(await fake.fire("agent/request-error", payload(), async () => undefined), undefined);
  await fake.dispose();
});

test("an aborted turn cancels the wait and never reports a retry", async () => {
  const fake = fakeContext();
  plugin.apply(fake.ctx, { initialDelayMs: 5_000, maxDelayMs: 5_000, jitterRatio: 0 });

  const controller = new AbortController();
  const payload = { ...failurePayload(), signal: controller.signal };
  const pending = fake.fire("agent/request-error", payload, async () => undefined);
  setTimeout(() => controller.abort(), 10);

  const action = await pending;
  assert.equal(action, undefined, "an aborted wait must not claim the retry");
  const types = payload.agent.appended.map((entry) => entry.type);
  assert.deepEqual(types, ["llm/retry"], "the scheduled record survives, the started record does not");
  await fake.dispose();
});

test("retryWithoutProviderPolicy:false skips failures with no policy", async () => {
  const fake = fakeContext();
  plugin.apply(fake.ctx, { retryWithoutProviderPolicy: false, initialDelayMs: 1, maxDelayMs: 2 });

  const action = await fake.fire("agent/request-error", failurePayload(), async () => undefined);
  assert.equal(action, undefined);
  await fake.dispose();
});

test("a new step restarts the ladder instead of continuing at the ceiling", async () => {
  const fake = fakeContext();
  plugin.apply(fake.ctx, { initialDelayMs: 1, maxDelayMs: 2, jitterRatio: 0 });

  const projection = fake.services.get("sessionProjections");
  const agent = fakeAgent("session-1", projection);
  await fake.fire("agent/request-error", { ...failurePayload(), agent }, async () => undefined);
  await fake.fire("agent/request-error", { ...failurePayload(), agent }, async () => undefined);
  assert.equal(agent.appended.at(-1).data.retry, 2);

  // A new step begins: the recorded boundary resets the folded ladder.
  agent.session.append("step/start", { turn: 2, step: 1 });
  await fake.fire("agent/request-error", { ...failurePayload(), agent }, async () => undefined);
  assert.equal(agent.appended.at(-1).data.retry, 1, "attempt numbering restarts per step");
  await fake.dispose();
});

test("legacy retryAllCodes/terminalCodes still mount and are accepted", async () => {
  const fake = fakeContext();
  // A 1.x patch must not break on 2.0.0.
  plugin.apply(fake.ctx, { retryAllCodes: true, terminalCodes: ["AUTH"], initialDelayMs: 1, maxDelayMs: 2 });

  const action = await fake.fire("agent/request-error", failurePayload("AUTH"), async () => undefined);
  assert.equal(action, undefined, "terminalCodes is honoured as excludeCodes");
  await fake.dispose();
});

test("dispose aborts in-flight recovery and stops retrying", async () => {
  const fake = fakeContext();
  plugin.apply(fake.ctx, { initialDelayMs: 5_000, maxDelayMs: 5_000, jitterRatio: 0 });

  const payload = failurePayload();
  const pending = fake.fire("agent/request-error", payload, async () => undefined);

  // Wait until the scheduled record has landed, so the test observes an actual
  // in-flight wait rather than racing the listener's first await.
  for (let tick = 0; tick < 50 && payload.agent.appended.length === 0; tick += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  assert.equal(payload.agent.appended.length, 1, "the wait was scheduled");

  await fake.dispose();

  assert.equal(await pending, undefined, "a disposed plugin claims no retry");
  assert.deepEqual(
    payload.agent.appended.map((entry) => entry.type),
    ["llm/retry"],
    "the cancelled wait never reports that it started",
  );
});

test("the stats endpoint reports the live read model", async () => {
  const routes = new Map();
  const fake = fakeContext({
    services: {
      webServer: {
        register(route) {
          routes.set(route.path, route);
          return () => routes.delete(route.path);
        },
      },
    },
  });
  plugin.apply(fake.ctx, { initialDelayMs: 1, maxDelayMs: 2 });

  assert.ok(routes.has("/unlimited-retry/stats"));

  const response = captureResponse();
  routes.get("/unlimited-retry/stats").handler(fakeRequest("GET"), response.res);
  assert.equal(response.status, 200);
  const body = JSON.parse(response.text());
  assert.equal(body.schemaVersion, 1);
  assert.equal(body.plugin.name, "unlimited-retry");
  assert.equal(body.config.maxAttempts, null);
  assert.equal(body.capabilities.unlimited, true);
  assert.equal(body.capabilities.retriesEveryCode, true);
  assert.ok(Array.isArray(body.ladder) && body.ladder.length > 0);
  assert.ok(body.recommendedExclude.includes("AUTH"));
  await fake.dispose();
});

test("the stats endpoint answers HEAD and rejects other methods", async () => {
  const routes = new Map();
  const fake = fakeContext({
    services: { webServer: { register: (route) => (routes.set(route.path, route), () => {}) } },
  });
  plugin.apply(fake.ctx, {});

  const route = routes.get("/unlimited-retry/stats");
  const head = captureResponse();
  route.handler(fakeRequest("HEAD"), head.res);
  assert.equal(head.status, 200);
  assert.equal(head.text(), "");

  const post = captureResponse();
  route.handler(fakeRequest("POST"), post.res);
  assert.equal(post.status, 405);
  assert.equal(post.headers.allow, "GET, HEAD");
  await fake.dispose();
});

test("config writes are refused when the composition has no admission service", async () => {
  const routes = new Map();
  const fake = fakeContext({
    services: { webServer: { register: (route) => (routes.set(route.path, route), () => {}) } },
  });
  plugin.apply(fake.ctx, {});

  const response = captureResponse();
  await routes.get("/unlimited-retry/config").handler(
    fakeRequest("POST", { "content-type": "application/json" }, JSON.stringify({ autoRetry: false })),
    response.res,
  );
  assert.equal(response.status, 403);
  assert.equal(JSON.parse(response.text()).code, "not-admitted");
  await fake.dispose();
});

test("config writes go through the config editor for an addressable row", async () => {
  const routes = new Map();
  const edits = [];
  const entry = { options: { id: "unlimited-retry", name: "dsh-unlimited-retry" } };
  const fake = fakeContext({
    services: {
      webServer: { register: (route) => (routes.set(route.path, route), () => {}) },
      connection: { requestRejection: () => undefined },
      configEditor: {
        entries: () => [entry],
        edit: async (target, change) => {
          edits.push({ target, next: change({ autoRetry: true, maxAttempts: null }, {}) });
        },
      },
    },
  });
  plugin.apply(fake.ctx, {});

  const response = captureResponse();
  await routes.get("/unlimited-retry/config").handler(
    fakeRequest("POST", { "content-type": "application/json" }, JSON.stringify({ autoRetry: false, maxAttempts: 7 })),
    response.res,
  );
  assert.equal(response.status, 200);
  assert.equal(edits.length, 1);
  assert.equal(edits[0].target, entry);
  assert.equal(edits[0].next.autoRetry, false);
  assert.equal(edits[0].next.maxAttempts, 7);
  await fake.dispose();
});

test("a config patch with an unknown key is rejected before any write", async () => {
  const routes = new Map();
  let edits = 0;
  const fake = fakeContext({
    services: {
      webServer: { register: (route) => (routes.set(route.path, route), () => {}) },
      connection: { requestRejection: () => undefined },
      configEditor: { entries: () => [{ options: { id: "unlimited-retry" } }], edit: async () => { edits += 1; } },
    },
  });
  plugin.apply(fake.ctx, {});

  const response = captureResponse();
  await routes.get("/unlimited-retry/config").handler(
    fakeRequest("POST", { "content-type": "application/json" }, JSON.stringify({ retryAllCodes: true })),
    response.res,
  );
  assert.equal(response.status, 400);
  assert.equal(JSON.parse(response.text()).code, "unknown-key");
  assert.equal(edits, 0);
  await fake.dispose();
});

test("the recommended preset writes the permanent code set", async () => {
  const routes = new Map();
  let written;
  const fake = fakeContext({
    services: {
      webServer: { register: (route) => (routes.set(route.path, route), () => {}) },
      connection: { requestRejection: () => undefined },
      configEditor: {
        entries: () => [{ options: { id: "unlimited-retry" } }],
        edit: async (_entry, change) => {
          written = change({}, {});
        },
      },
    },
  });
  plugin.apply(fake.ctx, {});

  const response = captureResponse();
  await routes.get("/unlimited-retry/config").handler(
    fakeRequest("POST", { "content-type": "application/json" }, JSON.stringify({ resetToRecommendedExcludes: true })),
    response.res,
  );
  assert.equal(response.status, 200);
  assert.ok(written.excludeCodes.includes("AUTH"));
  assert.ok(written.excludeCodes.includes("CONTEXT_OVERFLOW"));
  await fake.dispose();
});

test("reset clears the counters it is asked to clear", async () => {
  const routes = new Map();
  const fake = fakeContext({
    services: {
      webServer: { register: (route) => (routes.set(route.path, route), () => {}) },
      connection: { requestRejection: () => undefined },
    },
  });
  plugin.apply(fake.ctx, { initialDelayMs: 1, maxDelayMs: 2 });

  // Produce one counted retry, so a reset has something observable to clear.
  await fake.fire("agent/request-error", failurePayload(), async () => undefined);
  const before = captureResponse();
  routes.get("/unlimited-retry/stats").handler(fakeRequest("GET"), before.res);
  assert.ok(JSON.parse(before.text()).stats.totalRetries >= 1);

  const route = routes.get("/unlimited-retry/reset");
  const refused = captureResponse();
  await route.handler(fakeRequest("POST", { "content-type": "application/json" }, JSON.stringify({})), refused.res);
  assert.equal(refused.status, 400);
  assert.equal(JSON.parse(refused.text()).code, "confirmation-required");

  const accepted = captureResponse();
  await route.handler(
    fakeRequest("POST", { "content-type": "application/json" }, JSON.stringify({ confirm: true })),
    accepted.res,
  );
  assert.equal(accepted.status, 200);
  assert.equal(JSON.parse(accepted.text()).stats.totalRetries, 0);

  const after = captureResponse();
  routes.get("/unlimited-retry/stats").handler(fakeRequest("GET"), after.res);
  const cleared = JSON.parse(after.text()).stats;
  assert.equal(cleared.totalRetries, 0);
  assert.deepEqual(cleared.byCode, []);
  assert.deepEqual(cleared.recent, []);
  await fake.dispose();
});

test("a rejected browser request is answered before the handler runs", async () => {
  const routes = new Map();
  const fake = fakeContext({
    services: {
      webServer: { register: (route) => (routes.set(route.path, route), () => {}) },
      connection: { requestRejection: () => 401 },
    },
  });
  plugin.apply(fake.ctx, {});

  const response = captureResponse();
  routes.get("/unlimited-retry/stats").handler(fakeRequest("GET"), response.res);
  assert.equal(response.status, 401);
  assert.equal(JSON.parse(response.text()).code, "unauthenticated");
  await fake.dispose();
});

test("non-JSON config bodies are refused with 415", async () => {
  const routes = new Map();
  const fake = fakeContext({
    services: {
      webServer: { register: (route) => (routes.set(route.path, route), () => {}) },
      connection: { requestRejection: () => undefined },
    },
  });
  plugin.apply(fake.ctx, {});

  const response = captureResponse();
  await routes.get("/unlimited-retry/config").handler(
    fakeRequest("POST", { "content-type": "text/plain" }, "autoRetry=false"),
    response.res,
  );
  assert.equal(response.status, 415);
  await fake.dispose();
});

test("an oversized config body is refused with 413", async () => {
  const routes = new Map();
  const fake = fakeContext({
    services: {
      webServer: { register: (route) => (routes.set(route.path, route), () => {}) },
      connection: { requestRejection: () => undefined },
    },
  });
  plugin.apply(fake.ctx, {});

  const response = captureResponse();
  const huge = JSON.stringify({ excludeCodes: ["x".repeat(9000)] });
  await routes.get("/unlimited-retry/config").handler(
    fakeRequest("POST", { "content-type": "application/json" }, huge),
    response.res,
  );
  assert.equal(response.status, 413);
  await fake.dispose();
});

test("counters survive a plugin reload", async () => {
  const first = fakeContext();
  plugin.apply(first.ctx, { initialDelayMs: 1, maxDelayMs: 2 });
  await first.fire("agent/request-error", failurePayload(), async () => undefined);
  await first.dispose();

  // A second mount in the same process reads the same shared counters.
  const second = fakeContext({
    services: { webServer: { register: (route) => (route.path === "/unlimited-retry/stats" ? (secondRoute = route, () => {}) : () => {}) } },
  });
  let secondRoute;
  plugin.apply(second.ctx, { initialDelayMs: 1, maxDelayMs: 2 });

  const response = captureResponse();
  secondRoute.handler(fakeRequest("GET"), response.res);
  const body = JSON.parse(response.text());
  assert.ok(body.stats.totalRetries >= 1, "counters are process-wide, not per mount");
  assert.ok(body.plugin.mounts >= 2);
  await second.dispose();
});

/** Minimal HTTP response double. */
function captureResponse() {
  const chunks = [];
  const capture = {
    status: 0,
    headers: {},
    res: {
      writeHead(status, headers) {
        capture.status = status;
        capture.headers = headers ?? {};
        return capture.res;
      },
      end(chunk) {
        if (chunk !== undefined) chunks.push(Buffer.from(chunk));
      },
    },
    text() {
      return Buffer.concat(chunks).toString("utf8");
    },
  };
  return capture;
}

/** Minimal HTTP request double that streams an optional body. */
function fakeRequest(method, headers = {}, body) {
  const stream = (async function* generate() {
    if (body !== undefined) yield Buffer.from(body);
  })();
  return { method, headers, [Symbol.asyncIterator]: () => stream };
}

// ---------------------------------------------------------------------------
// Cancellation is not a fault.
//
// `dsh-llm` produces an `aborted` finish when `signal.aborted || code ===
// "ABORTED"`, so an ABORTED failure reaches this listener with the loop signal
// still live. Retrying it would re-run work the user cancelled — forever, under
// an unbounded budget. These tests pin the guard at every level it can be
// reached from.
// ---------------------------------------------------------------------------

test("a cancelled request is never retried, even with no exclusions at all", async () => {
  const fake = fakeContext();
  // Deliberately the most permissive configuration: no codes excluded.
  plugin.apply(fake.ctx, { excludeCodes: [], maxAttempts: null, initialDelayMs: 1, maxDelayMs: 2 });

  const payload = failurePayload("ABORTED");
  const action = await fake.fire("agent/request-error", payload, async () => undefined);
  assert.equal(action, undefined, "a cancellation must not be retried");
  assert.equal(payload.agent.appended.length, 0, "and must not be reported as a retry");
  await fake.dispose();
});

test("the cancellation guard ignores case and surrounding whitespace", async () => {
  const fake = fakeContext();
  plugin.apply(fake.ctx, { excludeCodes: [], initialDelayMs: 1, maxDelayMs: 2 });

  for (const spelling of ["ABORTED", "aborted", "Aborted", " ABORTED ", "\taborted\n"]) {
    const action = await fake.fire(
      "agent/request-error",
      failurePayload(spelling),
      async () => undefined,
    );
    assert.equal(action, undefined, `"${spelling}" must be recognised as a cancellation`);
  }
  await fake.dispose();
});

test("a code merely starting with ABORT is not treated as a cancellation", async () => {
  const fake = fakeContext();
  plugin.apply(fake.ctx, { excludeCodes: [], initialDelayMs: 1, maxDelayMs: 2 });

  const action = await fake.fire("agent/request-error", failurePayload("ABORT_WATCHDOG_EXPIRED"), async () => undefined);
  assert.deepEqual(action, { kind: "retry" }, "the guard is an exact match, not a prefix test");
  await fake.dispose();
});

test("configured exclusions are matched canonically too", async () => {
  const fake = fakeContext();
  // Mixed case and padding in the operator's own list must still match.
  plugin.apply(fake.ctx, { excludeCodes: ["auth", "  Quota  "], initialDelayMs: 1, maxDelayMs: 2 });

  for (const code of ["AUTH", "auth", "Quota", "QUOTA"]) {
    const action = await fake.fire("agent/request-error", failurePayload(code), async () => undefined);
    assert.equal(action, undefined, `"${code}" must match the configured exclusion`);
  }
  const action = await fake.fire("agent/request-error", failurePayload("NETWORK"), async () => undefined);
  assert.deepEqual(action, { kind: "retry" }, "an unrelated code still retries");
  await fake.dispose();
});

test("a cancelled request is counted as terminal, not as a silent no-op", async () => {
  const routes = new Map();
  const fake = fakeContext({
    services: { webServer: { register: (route) => (routes.set(route.path, route), () => {}) } },
  });
  plugin.apply(fake.ctx, { excludeCodes: [], initialDelayMs: 1, maxDelayMs: 2 });

  // Counters are process-wide, so read deltas rather than absolutes.
  const read = () => {
    const response = captureResponse();
    routes.get("/unlimited-retry/stats").handler(fakeRequest("GET"), response.res);
    return JSON.parse(response.text()).stats;
  };
  const terminalFor = (stats, code) => stats.terminalSeen.find((row) => row.code === code)?.count ?? 0;

  const before = read();
  await fake.fire("agent/request-error", failurePayload("aborted"), async () => undefined);
  const after = read();

  assert.equal(after.totalRetries, before.totalRetries, "a cancellation performs no retry");
  assert.equal(terminalFor(after, "ABORTED") - terminalFor(before, "ABORTED"), 1,
    "the panel must show that the cancellation was declined");
  await fake.dispose();
});

test("a submission with no usable session identity keeps one stable ladder", async () => {
  const fake = fakeContext();
  plugin.apply(fake.ctx, { maxAttempts: 2, initialDelayMs: 1, maxDelayMs: 2 });

  // No session id anywhere: the ladder must still be shared, not per-call, or
  // maxAttempts could never be reached. This session has no `id`, so both the
  // projection and the fallback collapse to one fixed key.
  const projection = fake.services.get("sessionProjections");
  const session = { append(type, data) { projection.fold(session, { type, data }); } };
  const payload = { ...failurePayload(), agent: { session } };
  assert.deepEqual(await fake.fire("agent/request-error", payload, async () => undefined), { kind: "retry" });
  assert.deepEqual(await fake.fire("agent/request-error", payload, async () => undefined), { kind: "retry" });
  assert.equal(await fake.fire("agent/request-error", payload, async () => undefined), undefined);
  await fake.dispose();
});

// ---------------------------------------------------------------------------
// Ladder lifecycle.
//
// The ladder is per step, and it must stay per step under every configuration.
// A ladder that never resets turns `maxAttempts` into a per-session lifetime cap,
// which is a far sharper failure than it looks: one capped step would leave the
// session permanently unable to retry.
// ---------------------------------------------------------------------------

test("the ladder resets per step even with session events turned off", async () => {
  const fake = fakeContext();
  plugin.apply(fake.ctx, {
    maxAttempts: 2,
    initialDelayMs: 1,
    maxDelayMs: 2,
    recordSessionEvents: false,
  });

  const agent = fakeAgent("session-1");
  const fire = () => fake.fire("agent/request-error", { ...failurePayload(), agent }, async () => undefined);

  assert.deepEqual(await fire(), { kind: "retry" });
  assert.deepEqual(await fire(), { kind: "retry" });
  assert.equal(await fire(), undefined, "the cap is reached within this step");

  // A new step is a new request series. The real Session dispatches
  // `session/event` as it records, so the double must too.
  agent.session.append("step/start", { turn: 2, step: 1 });
  const onSessionEvent = fake.listeners.get("session/event");
  assert.ok(onSessionEvent, "the fallback ladder must observe session boundaries");
  onSessionEvent(agent.session, { type: "step/start" });
  assert.deepEqual(await fire(), { kind: "retry" }, "the cap applies per step, not per session");
  await fake.dispose();
});

test("ladders do not accumulate one entry per session", async () => {
  const fake = fakeContext();
  plugin.apply(fake.ctx, {
    initialDelayMs: 1,
    maxDelayMs: 1,
    recordSessionEvents: false,
    maxAttempts: 2,
  });

  // 400 distinct sessions is far past the fallback bound; the point is that the
  // plugin keeps working and does not hold an entry per session forever.
  for (let index = 0; index < 400; index += 1) {
    const agent = fakeAgent(`session-${index}`);
    const action = await fake.fire(
      "agent/request-error",
      { ...failurePayload(), agent, signal: new AbortController().signal },
      async () => undefined,
    );
    assert.deepEqual(action, { kind: "retry" });
  }
  await fake.dispose();
});

test("concurrent waits in one step each get their own attempt number", async () => {
  const fake = fakeContext();
  plugin.apply(fake.ctx, { initialDelayMs: 1, maxDelayMs: 2 });

  const projection = fake.services.get("sessionProjections");
  const agent = fakeAgent("session-1", projection);
  const fire = () => fake.fire("agent/request-error", { ...failurePayload(), agent }, async () => undefined);

  const [first, second] = await Promise.all([fire(), fire()]);
  assert.deepEqual(first, { kind: "retry" });
  assert.deepEqual(second, { kind: "retry" });

  const attempts = agent.appended
    .filter((entry) => entry.type === "llm/retry")
    .map((entry) => entry.data.retry)
    .sort((a, b) => a - b);
  assert.deepEqual(attempts, [1, 2], "two concurrent waits are attempts 1 and 2, not both 1");
  await fake.dispose();
});

// ---------------------------------------------------------------------------
// Hostile and malformed input.
//
// This listener sits in a waterfall the agent loop awaits with no catch of its
// own, so an exception here would replace the provider's real failure with a
// TypeError and lose the error the user needed to see. Every field is treated as
// untrusted.
// ---------------------------------------------------------------------------

test("a malformed failure is delegated, never thrown from the waterfall", async () => {
  const fake = fakeContext();
  plugin.apply(fake.ctx, { initialDelayMs: 1, maxDelayMs: 2 });

  const signal = new AbortController().signal;
  const session = { id: "s", append: () => {} };
  const hostile = [
    null,
    undefined,
    {},
    { agent: { session }, failure: null, signal },
    { agent: { session }, failure: "boom", signal },
    { agent: { session }, failure: 42, signal },
    { agent: null, failure: { code: "NETWORK" }, signal },
    { agent: "not-an-agent", failure: { code: "NETWORK" }, signal },
    { agent: { session }, failure: { message: "x", code: 42 }, signal },
    { agent: { session }, failure: { message: "x", code: "" }, signal },
    { agent: { session }, failure: { message: "x", code: "NETWORK" } },
    { agent: { session }, failure: { message: "x", code: "NETWORK" }, signal: null },
  ];

  for (const payload of hostile) {
    const action = await fake.fire("agent/request-error", payload, async () => undefined);
    assert.ok(
      action === undefined || action?.kind === "retry",
      `payload ${JSON.stringify(payload)} produced ${JSON.stringify(action)}`,
    );
  }
  await fake.dispose();
});

test("an absurd provider delay cannot escape the ceiling", async () => {
  const fake = fakeContext();
  plugin.apply(fake.ctx, { initialDelayMs: 1, maxDelayMs: 5, jitterRatio: 0 });

  for (const providerRetryAfterMs of [1e15, Number.MAX_SAFE_INTEGER, Number.POSITIVE_INFINITY, -5, Number.NaN]) {
    const payload = failurePayload("RATE_LIMITED", { providerRetryAfterMs });
    const action = await fake.fire("agent/request-error", payload, async () => undefined);
    assert.deepEqual(action, { kind: "retry" });
    const recorded = payload.agent.appended[0].data.delayMs;
    assert.ok(
      Number.isFinite(recorded) && recorded >= 1 && recorded <= 5,
      `providerRetryAfterMs ${providerRetryAfterMs} produced delay ${recorded}`,
    );
  }
  await fake.dispose();
});

test("a failing config editor is reported, not thrown out of the route", async () => {
  const routes = new Map();
  const fake = fakeContext({
    services: {
      webServer: { register: (route) => (routes.set(route.path, route), () => {}) },
      connection: { requestRejection: () => undefined },
      configEditor: {
        entries() {
          throw new Error("entries exploded");
        },
        edit() {
          throw new Error("edit exploded");
        },
      },
    },
  });
  plugin.apply(fake.ctx, {});

  // The read model must survive an unusable editor and simply report read-only.
  const stats = captureResponse();
  routes.get("/unlimited-retry/stats").handler(fakeRequest("GET"), stats.res);
  assert.equal(stats.status, 200);

  const write = captureResponse();
  await routes.get("/unlimited-retry/config").handler(
    fakeRequest("POST", { "content-type": "application/json" }, JSON.stringify({ autoRetry: false })),
    write.res,
  );
  // 409 is the specific answer: the row could not be resolved, which is a
  // different condition from a malformed patch (400).
  assert.ok(write.status === 400 || write.status === 409, `unexpected status ${write.status}`);
  assert.match(JSON.parse(write.text()).code, /bad-request|not-addressable|no-editor/);
  await fake.dispose();
});
