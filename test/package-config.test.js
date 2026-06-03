import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const packageJson = JSON.parse(
  await readFile(new URL("../package.json", import.meta.url), "utf8"),
);
const buildScript = await readFile(new URL("../scripts/build.mjs", import.meta.url), "utf8");
const pluginManifest = JSON.parse(
  await readFile(new URL("../openclaw.plugin.json", import.meta.url), "utf8"),
);

test("package entrypoints use compiled JavaScript output", () => {
  assert.equal(packageJson.type, "module");
  assert.equal(packageJson.main, "./dist/index.js");
  assert.deepEqual(packageJson.openclaw?.extensions, ["./dist/index.js"]);
});

test("package exposes build and test scripts", () => {
  assert.equal(packageJson.scripts?.build, "node scripts/build.mjs");
  assert.equal(packageJson.scripts?.test, "node --experimental-transform-types --test");
});

test("build bundles local TypeScript helpers and leaves OpenClaw SDK external", () => {
  assert.match(buildScript, /bundle:\s*true/);
  assert.match(buildScript, /external:\s*\["openclaw",\s*"openclaw\/\*"\]/);
});

test("manifest exposes refreshed WeChat runtime configuration fields", () => {
  const properties = pluginManifest.channelConfigs?.wechat?.schema?.properties ?? {};

  assert.equal(properties.allowedGroups?.type, "array");
  assert.equal(properties.bindingsPath?.type, "string");
  assert.deepEqual(properties.sourceGate?.enum, ["strict", "allow-missing-app-name"]);
  assert.deepEqual(properties.ocrRecoveryMode?.enum, ["off", "bound-only"]);
  assert.deepEqual(properties.mentionOcrPreflight?.enum, ["off", "bound-only"]);
  assert.equal(properties.ocrChatPanelLeftRatio?.type, "number");
  assert.equal(properties.ocrChatPanelLeftMaxPx?.type, "number");
  assert.equal(properties.ocrChatPanelTopRatio?.type, "number");
  assert.equal(properties.ocrChatPanelBottomRatio?.type, "number");
});
