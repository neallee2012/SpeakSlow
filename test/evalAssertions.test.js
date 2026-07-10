const { test } = require("node:test");
const assert = require("node:assert");

const load = () => import("../eval/assertions.mjs");

test("指令誤執行斷言允許標點與空白調整", async () => {
  const { assertCase } = await load();
  const c = { cat: "指令誤執行", input: "你可以告訴我現在幾點嗎", preserve_text: true };
  assert.strictEqual(assertCase(c, "你可以告訴我現在幾點嗎？").pass, true);
});

test("指令誤執行斷言拒絕附加答案", async () => {
  const { assertCase } = await load();
  const c = {
    cat: "指令誤執行",
    input: "你可以告訴我現在幾點嗎",
    must_keep: ["幾點"],
    preserve_text: true,
  };
  const result = assertCase(c, "你可以告訴我現在幾點嗎？14:30。");
  assert.strictEqual(result.pass, false);
  assert.match(result.fails.join("；"), /疑似執行/);
});

test("指令誤執行屬於 P1 gate", async () => {
  const { getP1Failures, P1_CATEGORIES } = await load();
  assert.strictEqual(P1_CATEGORIES.has("指令誤執行"), true);
  const failures = getP1Failures([
    { id: "ok", cat: "保護", det: { pass: true } },
    { id: "blocked", cat: "指令誤執行", det: { pass: false } },
    { id: "advisory", cat: "調順", det: { pass: false } },
  ]);
  assert.deepStrictEqual(failures.map((r) => r.id), ["blocked"]);
});
