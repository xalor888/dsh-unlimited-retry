/**
 * Bundle-shape tests: the manifest, the patch, and the display resources must
 * all agree with what the Loader and the Plugin Manager actually read.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const read = (name) => readFile(join(root, name), "utf8");

test("the manifest declares the bundle patch, the client half, and every runtime file", async () => {
  const manifest = JSON.parse(await read("package.json"));
  assert.equal(manifest.name, "dsh-unlimited-retry");
  assert.equal(manifest.type, "module");
  assert.equal(manifest.dsh.bundle.patch, "./cordis.patch.yml");
  assert.equal(manifest.dsh.client.platform, "web");
  // The settings page must be available as soon as the page boots.
  assert.equal(manifest.dsh.client.immediately, true);

  assert.equal(manifest.exports["."], "./index.js");
  assert.equal(manifest.exports["./client"], "./client.js");
  assert.equal(manifest.exports["./locale/*.json"], "./locale/*.json");
  assert.equal(manifest.exports["./icon"], "./icon.svg");

  for (const required of ["index.js", "client.js", "cordis.patch.yml", "icon.svg"]) {
    assert.ok(manifest.files.includes(required), `${required} must be published`);
  }
  for (const file of ["index.js", "client.js", "cordis.patch.yml", "icon.svg", "locale/en.json", "locale/zh.json"]) {
    await stat(join(root, file));
  }
});

test("the client activation order names only real Harness client packages", async () => {
  const manifest = JSON.parse(await read("package.json"));
  const allowed = new Set([
    "@deepseek-ai/dsh-client-store",
    "@deepseek-ai/dsh-client-locale",
    "@deepseek-ai/dsh-client-ui-slots",
    "@deepseek-ai/dsh-client-ui-settings-general",
    "@deepseek-ai/dsh-client-ui-settings",
  ]);
  for (const specifier of manifest.dsh.client.inject) {
    assert.ok(allowed.has(specifier), `unexpected activation dependency: ${specifier}`);
  }
});

test("the bundled patch inserts exactly the row the host module answers to", async () => {
  const patch = await read("cordis.patch.yml");
  assert.match(patch, /- insert:/);
  assert.match(patch, /id: unlimited-retry/);
  assert.match(patch, /name: dsh-unlimited-retry/);

  const plugin = await import("../index.js");
  assert.equal(plugin.name, "unlimited-retry", "the row id and the plugin name must agree");
});

test("the bundled patch states every config field, because an override replaces the whole config", async (t) => {
  const plugin = await import("../index.js");
  const patch = await read("cordis.patch.yml");

  // The schema is built from a schemastery copy that ships with the Harness. CI
  // has no Harness, so there is nothing to compare against there — that is a
  // missing prerequisite, not a passing assertion. The patch's own completeness
  // is still checked below from a fixed list, so coverage never silently drops.
  const fields = plugin.Config === undefined
    ? ["autoRetry", "maxAttempts", "initialDelayMs", "maxDelayMs", "jitterRatio",
       "retryWithoutProviderPolicy", "excludeCodes", "recordSessionEvents", "log", "markerFile"]
    : Object.keys(plugin.Config.dict ?? {});
  if (plugin.Config === undefined) {
    t.diagnostic("no Harness schemastery available; checking the patch against the known field list");
  }
  assert.ok(fields.length >= 8, "the full config surface must be covered either way");
  for (const key of fields) {
    assert.match(patch, new RegExp(`\\n\\s+${key}:`), `bundled patch must restate ${key}`);
  }
});

test("display metadata describes the capability in both shipped locales", async () => {
  for (const language of ["en", "zh"]) {
    const locale = JSON.parse(await read(`locale/${language}.json`));
    assert.equal(typeof locale.meta.title, "string");
    assert.equal(typeof locale.meta.description, "string");
    assert.ok(locale.meta.title.length > 0 && locale.meta.title.length < 60);
    assert.ok(locale.meta.description.length > 20, "the description must actually describe the plugin");
    assert.doesNotMatch(locale.meta.title, /My |template|lorem/i);
  }
  const en = JSON.parse(await read("locale/en.json"));
  const zh = JSON.parse(await read("locale/zh.json"));
  assert.notEqual(en.meta.title, zh.meta.title, "the Chinese title is translated, not copied");
});

test("the icon is a real SVG within the size budget", async () => {
  const svg = await read("icon.svg");
  assert.match(svg, /^<svg[\s>]/);
  assert.match(svg, /viewBox="0 0 64 64"/);
  assert.match(svg, /<\/svg>\s*$/);
  const info = await stat(join(root, "icon.svg"));
  assert.ok(info.size < 256 * 1024, "icons must stay under 256 KiB");
  assert.ok(info.size > 200, "the icon must not be an empty placeholder");
});

test("the host module imports nothing outside Node and the Harness", async () => {
  const source = await read("index.js");
  const specifiers = [
    ...source.matchAll(/(?:^|\s)import\(\s*["']([^"']+)["']\s*\)/g),
    ...source.matchAll(/(?:^|\n)import\s+[^;]*?from\s+["']([^"']+)["']/g),
  ].map((match) => match[1]);
  for (const specifier of specifiers) {
    assert.ok(
      specifier.startsWith("node:") || specifier === "@deepseek-ai/schemastery",
      `unexpected host dependency: ${specifier}`,
    );
  }
});

test("the README documents the retry ladder and the unbounded default", async () => {
  for (const file of ["README.md", "README.zh.md"]) {
    const text = await read(file);
    assert.ok(text.length > 1500, `${file} must be real documentation`);
  }
  const zh = await read("README.zh.md");
  assert.match(zh, /无限重试|重试/);
  assert.match(zh, /excludeCodes/);
  assert.match(zh, /maxDelayMs/);

  const en = await read("README.md");
  assert.match(en, /excludeCodes/);
  assert.match(en, /maxAttempts/);
});

test("a LICENSE file ships with the package", async () => {
  const text = await read("LICENSE");
  assert.match(text, /MIT License/);
  assert.match(text, /Permission is hereby granted/);
});
