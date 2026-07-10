const { test } = require("node:test");
const assert = require("node:assert");

const load = () => import("../src/helpers/settingsPersistence.mjs");

test("sidecar env-backed debug toggle waits for explicit Save", async () => {
  const { shouldAutoPersistToggle } = await load();
  assert.strictEqual(shouldAutoPersistToggle("debug_log_ai_prompts"), false);
  assert.strictEqual(shouldAutoPersistToggle("enable_notifications"), true);
});
