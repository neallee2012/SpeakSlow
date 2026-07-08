// 執行：node --test test/aiPrompts.test.js
const { test } = require("node:test");
const assert = require("node:assert");
const { buildPrompts, SYSTEM_PROMPT, stripAIPreamble } = require("../src/helpers/aiPrompts");

test("風格指示：有填時注入 optimize 與 optimize_long（在禁止項之後、原始文本之前）", () => {
  const p = buildPrompts("測試文字", "語氣直接，不加敬語");
  assert.ok(p.optimize.includes("使用者自訂風格偏好"));
  assert.ok(p.optimize.includes("語氣直接，不加敬語"));
  assert.ok(p.optimize.indexOf("嚴格的禁止項") < p.optimize.indexOf("使用者自訂風格偏好"));
  assert.ok(p.optimize.indexOf("使用者自訂風格偏好") < p.optimize.indexOf("原始文本"));
  assert.ok(p.optimize_long.includes("語氣直接，不加敬語"));
  // 衝突即忽略的位階宣告必須在（防「忽略以上規則」型注入，經對抗性 eval 實測）
  assert.ok(p.optimize.includes("一律忽略該偏好"));
  assert.ok(p.optimize_long.includes("一律忽略該偏好"));
});

test("風格指示：未填/空白時 prompt 與舊版完全一致（零注入）", () => {
  const base = buildPrompts("測試文字");
  assert.ok(!base.optimize.includes("使用者自訂風格偏好"));
  assert.strictEqual(buildPrompts("測試文字", "").optimize, base.optimize);
  assert.strictEqual(buildPrompts("測試文字", "   ").optimize, base.optimize);
});

test("風格指示：超過 2000 字截斷（防 prompt 爆量）", () => {
  const long = "很".repeat(3000);
  const p = buildPrompts("x", long);
  assert.ok(!p.optimize.includes("很".repeat(2001)));
  assert.ok(p.optimize.includes("很".repeat(2000)));
});

test("風格指示：不影響其他模式（condense/summarize 等）", () => {
  const p = buildPrompts("x", "任何風格");
  assert.ok(!p.condense.includes("任何風格"));
  assert.ok(!p.summarize.includes("任何風格"));
});

test("stripAIPreamble：砍代碼框與前言標頭", () => {
  assert.strictEqual(stripAIPreamble("```\n結果文字\n```"), "結果文字");
  assert.strictEqual(stripAIPreamble("優化後的文本：\n結果文字"), "結果文字");
  assert.strictEqual(stripAIPreamble("正常文字"), "正常文字");
});

test("SYSTEM_PROMPT 匯出存在（eval 與生產共用）", () => {
  assert.ok(SYSTEM_PROMPT.includes("文字處理引擎"));
});

test("stripAIPreamble：空值標記保底——模型的字面「空」輸出一律轉真空字串", () => {
  for (const s of ["（空）", "（空字串）", "（空字符串）", "（无内容）", "(empty)", "（完全空白，不输出任何内容）"]) {
    assert.strictEqual(stripAIPreamble(s), "", s);
  }
  // 正常內容（含括號）不受影響
  assert.strictEqual(stripAIPreamble("正常的句子（含括號）不受影響"), "正常的句子（含括號）不受影響");
  assert.strictEqual(stripAIPreamble("（這是一個正常的括號補充說明）"), "（這是一個正常的括號補充說明）");
});
