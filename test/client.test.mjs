/**
 * Client-half tests.
 *
 * The browser artifact registers itself into `window.__ModuleLoader__`, so the
 * test installs that facade with a stubbed module table and then drives the
 * plugin's `apply` against a fake slots/locale context. Rendering is exercised
 * through `react-dom/server`, which proves the component tree composes without a
 * browser and without a live host.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
// The Harness ships React inside its frontend bundle (18.3.1) rather than as a
// resolvable package, so the test uses a local copy of the same major/minor.
const requireLocal = createRequire(join(here, "..", "package.json"));
const React = requireLocal("react");
const { renderToStaticMarkup } = requireLocal("react-dom/server");

const CLIENT_PATH = join(here, "..", "client.js");

/**
 * Evaluate the browser bundle and return its exported module.
 * @returns the module registered into the loader facade.
 */
async function loadClient() {
  const source = await readFile(CLIENT_PATH, "utf8");
  let registration;
  const moduleTable = {
    react: React,
    "react/jsx-runtime": requireLocal("react/jsx-runtime"),
    // The panel only needs a snapshot store; a minimal faithful double keeps the
    // test independent of the browser client package.
    "@deepseek-ai/dsh-client-store": {
      createSnapshotStore(initial) {
        let state = initial;
        const listeners = new Set();
        return {
          getSnapshot: () => state,
          subscribe(listener) {
            listeners.add(listener);
            return () => listeners.delete(listener);
          },
          update(mutate) {
            const draft = { ...state };
            mutate(draft);
            state = draft;
            for (const listener of listeners) listener();
          },
        };
      },
    },
  };

  globalThis.window = {
    __ModuleLoader__: {
      load(candidate) {
        registration = candidate;
      },
    },
  };
  globalThis.fetch = async () => {
    throw new Error("network disabled in this test");
  };

  // The bundle is a browser script, not a module; evaluate it in module scope.
  const evaluated = new Function(`${source}\nreturn window.__ModuleLoader__;`)();
  assert.ok(registration, "the bundle must register one factory");
  assert.equal(registration.id, "dsh-unlimited-retry");
  const exported = registration.factory((specifier) => {
    if (!Object.hasOwn(moduleTable, specifier)) throw new Error(`unexpected require: ${specifier}`);
    return moduleTable[specifier];
  });
  return { exported, evaluated };
}

/**
 * Build a fake client context recording slot registrations.
 * @param language - active locale for the bound `t` helper.
 */
function fakeClientContext(language = "en") {
  const registered = [];
  const dictionaries = [];
  const disposers = [];
  const ctx = {
    effect(create, label) {
      const dispose = create();
      const off = typeof dispose === "function" ? dispose : () => {};
      disposers.push(off);
      off.label = label;
      return off;
    },
    locale: {
      // The real service takes one namespace and a per-language dictionary map.
      register(namespace, values) {
        dictionaries.push({ namespace, values });
        return () => {};
      },
      bind(namespace) {
        return (key) => {
          const entry = dictionaries.find((candidate) => candidate.namespace === namespace);
          const template = entry?.values?.[language]?.[key];
          return typeof template === "string" ? template : key;
        };
      },
    },
    slots: {
      inject(_owner, callback) {
        callback();
        return () => {};
      },
      register(options, component) {
        registered.push({ options, component });
        return () => {};
      },
    },
  };
  return { ctx, registered, dictionaries, disposers };
}

test("the bundle registers a client plugin with a locale and a settings page", async () => {
  const { exported } = await loadClient();
  assert.equal(exported.NS, "unlimitedRetry");
  assert.equal(typeof exported.apply, "function");
  assert.deepEqual(exported.inject, ["slots", "locale"]);

  const fake = fakeClientContext();
  exported.apply(fake.ctx);

  const dictionary = fake.dictionaries.find((entry) => entry.namespace === "unlimitedRetry");
  assert.ok(dictionary, "the page must register its own dictionaries");
  assert.ok(Object.keys(dictionary.values.en).length > 30);
  assert.ok(Object.keys(dictionary.values.zh).length > 30);

  assert.equal(fake.registered.length, 1);
  const [{ options, component }] = fake.registered;
  assert.equal(options.name, "settings.section");
  assert.equal(options.id, "unlimited-retry");
  assert.equal(options.order, 35);
  assert.equal(typeof options.label, "function");
  assert.equal(options.label(), "Retry");
  assert.equal(typeof component, "function");

  const face = options.inject();
  assert.ok(face.feed, "the page receives its poll feed");
  assert.ok(face.hooks.feed, "the feed is projected as a selector hook");
});

test("every English key has a Chinese counterpart", async () => {
  const { exported } = await loadClient();
  const fake = fakeClientContext();
  exported.apply(fake.ctx);
  const { values } = fake.dictionaries.find((entry) => entry.namespace === "unlimitedRetry");
  const missing = Object.keys(values.en).filter((key) => typeof values.zh[key] !== "string");
  assert.deepEqual(missing, [], `untranslated keys: ${missing.join(", ")}`);
  const extra = Object.keys(values.zh).filter((key) => typeof values.en[key] !== "string");
  assert.deepEqual(extra, [], `orphan Chinese keys: ${extra.join(", ")}`);
});

test("no English key leaks a literal placeholder into Chinese copy", async () => {
  const { exported } = await loadClient();
  const fake = fakeClientContext();
  exported.apply(fake.ctx);
  const { values } = fake.dictionaries.find((entry) => entry.namespace === "unlimitedRetry");
  // Both dictionaries must use the same placeholder set per key.
  const placeholders = (text) => [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();
  for (const key of Object.keys(values.en)) {
    assert.deepEqual(
      placeholders(values.en[key]),
      placeholders(values.zh[key]),
      `placeholder mismatch on "${key}"`,
    );
  }
});

test("the page renders a live snapshot without touching the DOM", async () => {
  const { exported } = await loadClient();
  const fake = fakeClientContext();
  exported.apply(fake.ctx);
  const [{ options, component }] = fake.registered;

  const snapshot = {
    status: "ready",
    data: sampleSnapshot(),
    error: null,
    errorCode: null,
    fetchedAt: Date.now(),
    consecutiveFailures: 0,
  };
  const useFeed = () => snapshot;
  const props = { ...options.inject(), t: fake.ctx.locale.bind("unlimitedRetry"), useFeed };

  const html = renderToStaticMarkup(React.createElement(component, props));
  assert.match(html, /Model request retry/);
  assert.match(html, /Effective retry ladder/);
  assert.match(html, /INVALID_REQUEST/);
  assert.match(html, /NETWORK/);
  // The page reports the unbounded budget honestly rather than inventing a cap.
  assert.match(html, /No limit/);
});

test("the page renders Chinese copy when the locale is Chinese", async () => {
  const { exported } = await loadClient();
  const fake = fakeClientContext();
  exported.apply(fake.ctx);
  const [{ options, component }] = fake.registered;

  const snapshot = {
    status: "ready",
    data: sampleSnapshot(),
    error: null,
    errorCode: null,
    fetchedAt: Date.now(),
    consecutiveFailures: 0,
  };
  const zhContext = fakeClientContext("zh");
  exported.apply(zhContext.ctx);
  const t = zhContext.ctx.locale.bind("unlimitedRetry");
  const html = renderToStaticMarkup(React.createElement(component, {
    ...options.inject(),
    t,
    useFeed: () => snapshot,
  }));
  assert.match(html, /模型请求重试/);
  assert.match(html, /实际重试顺序/);
  assert.match(html, /不设上限/);
});

test("an unreachable host renders an error state instead of crashing", async () => {
  const { exported } = await loadClient();
  const fake = fakeClientContext();
  exported.apply(fake.ctx);
  const [{ options, component }] = fake.registered;

  const html = renderToStaticMarkup(React.createElement(component, {
    ...options.inject(),
    t: fake.ctx.locale.bind("unlimitedRetry"),
    useFeed: () => ({
      status: "error",
      data: null,
      error: "Failed to fetch",
      errorCode: null,
      fetchedAt: 0,
      consecutiveFailures: 5,
    }),
  }));
  assert.match(html, /did not answer/);
  assert.match(html, /Failed to fetch/, "the underlying cause stays visible");
});

test("a read-only composition disables writes but still renders the policy", async () => {
  const { exported } = await loadClient();
  const fake = fakeClientContext();
  exported.apply(fake.ctx);
  const [{ options, component }] = fake.registered;

  const data = sampleSnapshot();
  data.capabilities.canWriteConfig = false;
  const html = renderToStaticMarkup(React.createElement(component, {
    ...options.inject(),
    t: fake.ctx.locale.bind("unlimitedRetry"),
    useFeed: () => ({
      status: "ready",
      data,
      error: null,
      errorCode: null,
      fetchedAt: Date.now(),
      consecutiveFailures: 0,
    }),
  }));
  assert.match(html, /no config editor/i);
});

test("the empty activity state is explicit rather than blank", async () => {
  const { exported } = await loadClient();
  const fake = fakeClientContext();
  exported.apply(fake.ctx);
  const [{ options, component }] = fake.registered;

  const data = sampleSnapshot();
  data.stats.totalRetries = 0;
  data.stats.lastRetryAt = null;
  data.stats.lastCode = null;
  data.stats.byCode = [];
  data.stats.byProvider = [];
  data.stats.terminalSeen = [];
  data.stats.recent = [];

  const html = renderToStaticMarkup(React.createElement(component, {
    ...options.inject(),
    t: fake.ctx.locale.bind("unlimitedRetry"),
    useFeed: () => ({
      status: "ready",
      data,
      error: null,
      errorCode: null,
      fetchedAt: Date.now(),
      consecutiveFailures: 0,
    }),
  }));
  assert.match(html, /No retry has been performed/);
  assert.match(html, /never/, "the last-retry stat reads 'never', not an empty cell");
});

test("the panel styles itself with theme tokens only", async () => {
  const source = await readFile(CLIENT_PATH, "utf8");
  const css = source.slice(source.indexOf("const CSS = `"), source.indexOf("`;", source.indexOf("const CSS = `")));
  assert.ok(css.length > 1000, "the panel ships its own stylesheet");

  // Every colour must come from a token, so light/dark and rethemes follow.
  const colourLiterals = [...css.matchAll(/(?:color|background|border-color|outline)\s*:\s*([^;}]+)/g)]
    .map((match) => match[1].trim())
    .filter((value) => /#[0-9a-f]{3,8}\b|\brgba?\(|\bhsla?\(/i.test(value))
    .filter((value) => !value.includes("var(--dsw-"));
  assert.deepEqual(colourLiterals, [], `hard-coded colours: ${colourLiterals.join(" | ")}`);

  // The switch must stay a real switch for assistive technology.
  assert.match(source, /role: "switch"/);
  assert.match(source, /"aria-checked"/);
  // No client package is imported beyond the platform seeds.
  const requires = [...source.matchAll(/require\("([^"]+)"\)/g)].map((match) => match[1]);
  for (const specifier of requires) {
    assert.ok(
      ["react", "react/jsx-runtime", "@deepseek-ai/dsh-client-store"].includes(specifier),
      `unexpected client dependency: ${specifier}`,
    );
  }
});

/** A representative host snapshot, including the edge cases the panel must survive. */
function sampleSnapshot() {
  return {
    schemaVersion: 1,
    plugin: { name: "unlimited-retry", version: "2.0.0", pid: 4242, mountedAt: new Date().toISOString(), uptimeMs: 3_725_000, mounts: 2 },
    config: {
      autoRetry: true,
      maxAttempts: null,
      initialDelayMs: 1000,
      maxDelayMs: 60000,
      jitterRatio: 0.2,
      retryWithoutProviderPolicy: true,
      excludeCodes: ["INVALID_REQUEST", "AUTH"],
      recordSessionEvents: true,
      log: true,
    },
    capabilities: { unlimited: true, retriesEveryCode: false, canWriteConfig: true },
    ladder: [{ attempt: 1, delayMs: 1000, clamped: false }, { attempt: 2, delayMs: 2000, clamped: false }],
    recommendedExclude: ["AUTH", "QUOTA", "CONTEXT_OVERFLOW"],
    knownFailureCodes: ["ABORTED", "RATE_LIMIT", "TIMEOUT", "TRANSPORT"],
    alwaysTerminalCodes: ["ABORTED"],
    stats: {
      totalRetries: 12,
      activeWaits: 1,
      sessionsRetrying: 1,
      lastRetryAt: new Date(Date.now() - 42_000).toISOString(),
      lastCode: "NETWORK",
      lastProvider: "deepseek",
      lastDelayMs: 4000,
      lastAttempt: 3,
      byCode: [{ code: "NETWORK", count: 9 }, { code: "RATE_LIMITED", count: 3 }],
      byProvider: [{ provider: "deepseek", count: 12 }],
      terminalSeen: [{ code: "AUTH", count: 1 }],
      recent: [
        { at: new Date(Date.now() - 42_000).toISOString(), attempt: 3, code: "NETWORK", provider: "deepseek", delayMs: 4000 },
        { at: new Date(Date.now() - 96_000).toISOString(), attempt: 2, code: "NETWORK", provider: "deepseek", delayMs: 2000 },
      ],
    },
  };
}

test("a reload right after a save is not reported as an outage", async () => {
  const { exported } = await loadClient();
  const fake = fakeClientContext();
  exported.apply(fake.ctx);
  const [{ options, component }] = fake.registered;

  // The host half reloads on a config write, so the first poll after a save can
  // legitimately fail. That must not paint a red banner over a successful save.
  const html = renderToStaticMarkup(React.createElement(component, {
    ...options.inject(),
    t: fake.ctx.locale.bind("unlimitedRetry"),
    useFeed: () => ({
      status: "error",
      data: sampleSnapshot(),
      error: "Failed to fetch",
      errorCode: null,
      fetchedAt: Date.now(),
      consecutiveFailures: 1,
    }),
  }));
  assert.doesNotMatch(html, /did not answer/, "one failed poll is not an outage");
  // The data itself is still on screen, from the previous successful poll.
  assert.match(html, /Model request retry/);
});

test("the panel explains the always-terminal rule instead of hiding it", async () => {
  const { exported } = await loadClient();
  const fake = fakeClientContext();
  exported.apply(fake.ctx);
  const [{ options, component }] = fake.registered;

  const html = renderToStaticMarkup(React.createElement(component, {
    ...options.inject(),
    t: fake.ctx.locale.bind("unlimitedRetry"),
    useFeed: () => ({
      status: "ready",
      data: sampleSnapshot(),
      error: null,
      errorCode: null,
      fetchedAt: Date.now(),
      consecutiveFailures: 0,
    }),
  }));
  // A rule the operator cannot override must be visible, not a mystery.
  assert.match(html, /ABORTED always stay terminal/);
  assert.match(html, /cancellation is not a fault/);
});

test("the code input offers the real Harness vocabulary as suggestions", async () => {
  const { exported } = await loadClient();
  const fake = fakeClientContext();
  exported.apply(fake.ctx);
  const [{ options, component }] = fake.registered;

  const html = renderToStaticMarkup(React.createElement(component, {
    ...options.inject(),
    t: fake.ctx.locale.bind("unlimitedRetry"),
    useFeed: () => ({
      status: "ready",
      data: sampleSnapshot(),
      error: null,
      errorCode: null,
      fetchedAt: Date.now(),
      consecutiveFailures: 0,
    }),
  }));
  assert.match(html, /<datalist[^>]*id="du-code-options"/);
  assert.match(html, /value="TIMEOUT"/);
  assert.match(html, /value="RATE_LIMIT"/);
});

test("clearing a numeric field does not rewrite it while typing", async () => {
  const source = await readFile(CLIENT_PATH, "utf8");
  // A committed value of 0 or 1 on every keystroke makes a field impossible to
  // retype: the operator deletes the contents and it immediately refills.
  assert.match(source, /function parseField\(raw, min, max\)/);
  assert.doesNotMatch(
    source,
    /Number\(event\.target\.value\) \|\| 1/,
    "no handler may coerce an empty field to 1",
  );
  assert.match(source, /if \(parsed !== undefined\) patch\(/);
});
