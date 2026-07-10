// 執行：node --test test/aiPrompts.test.js
const { test } = require("node:test");
const assert = require("node:assert");
const { buildPrompts, SYSTEM_PROMPT, stripAIPreamble, isMeltdownOutput } = require("../src/helpers/aiPrompts");

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

test("stripAIPreamble：只有雜音輸入才把模型空值標記轉成真空字串", () => {
  for (const s of ["（空）", "（空字串）", "（空字符串）", "（无内容）", "(empty)", "（完全空白，不输出任何内容）"]) {
    assert.strictEqual(stripAIPreamble(s, "嗯"), "", s);
  }
  // 一詞聽寫可能就是表單值，不得因輸出長得像空值標記而刪除
  for (const s of ["None", "N/A", "empty", "空", "空白"]) {
    assert.strictEqual(stripAIPreamble(s, s), s, s);
  }
  // 正常內容（含括號）不受影響
  assert.strictEqual(stripAIPreamble("正常的句子（含括號）不受影響"), "正常的句子（含括號）不受影響");
  assert.strictEqual(stripAIPreamble("（這是一個正常的括號補充說明）"), "（這是一個正常的括號補充說明）");
  // 含「空/輸出/內容」單字但不是空值片語的正常括號輸出——不得誤殺
  for (const s of ["（空投）", "（輸出格式）", "（內容待補）", "（時間還空著）"]) {
    assert.strictEqual(stripAIPreamble(s), s, s);
  }
});

test("isMeltdownOutput：撞 max_tokens 且爆長 → 失控（回退原文）", () => {
  const input = "是否有完整地打開？請對我完整的訊息";
  // 真實案例：模型吐出 ~2000 tokens 的重複思考迴圈
  const meltdown = input + "\n```\n" + "我需要謹慎處理這段語音轉文字的內容。".repeat(80);
  assert.strictEqual(isMeltdownOutput(input, meltdown, "length"), true);
});

test("isMeltdownOutput：撞 max_tokens 即不安全——被截斷的輸出即使比輸入短也回退（防長口述掉尾巴）", () => {
  const longInput = "很長的口述內容。".repeat(200);           // 1600 字
  const truncated = "很長的口述內容。".repeat(120);           // 潤飾到一半被 token 上限砍掉
  assert.strictEqual(isMeltdownOutput(longInput, truncated, "length"), true);
  // 空輸出 + length 也回退（半成品都不貼）
  assert.strictEqual(isMeltdownOutput(longInput, "", "length"), true);
});

test("isMeltdownOutput：正常潤飾（略長於輸入）不誤判", () => {
  const input = "呃我想那個約週三開會討論預算";
  const normal = "我想約週三開會討論預算。";
  assert.strictEqual(isMeltdownOutput(input, normal, "stop"), false);
  // 清單類合理擴張（加編號換行）也不誤判
  const listIn = "第一要安全第二要準時第三要省錢";
  const listOut = "1. 要安全\n2. 要準時\n3. 要省錢";
  assert.strictEqual(isMeltdownOutput(listIn, listOut, "stop"), false);
});

test("isMeltdownOutput：正常結束但輸出爆長（洩漏）也擋", () => {
  const input = "測試一句話";
  const leaked = "你是文字處理工具".repeat(50); // >4x input，即使 finish=stop
  assert.strictEqual(isMeltdownOutput(input, leaked, "stop"), true);
});

test("isMeltdownOutput：擴寫模式不套輸入輸出比例限制", () => {
  const expanded = "文案內容".repeat(55);
  assert.strictEqual(isMeltdownOutput("好", expanded, "stop", "optimize"), true);
  assert.strictEqual(isMeltdownOutput("好", expanded, "stop", "copywrite"), false);
  assert.strictEqual(isMeltdownOutput("好", expanded, "stop", "extract_vocab"), false);
  assert.strictEqual(isMeltdownOutput("好", expanded, "stop", "freeform"), false);
});

test("isMeltdownOutput：內容過濾或拒絕一律回退原文", () => {
  assert.strictEqual(isMeltdownOutput("重要口述", "", "content_filter"), true);
  assert.strictEqual(isMeltdownOutput("重要口述", "只剩一半", "content_filter"), true);
  assert.strictEqual(isMeltdownOutput("重要口述", "", "stop", "optimize", "無法處理"), true);
});

test("isMeltdownOutput：空輸出/空輸入安全", () => {
  assert.strictEqual(isMeltdownOutput("abc", "", "stop"), false);
  assert.strictEqual(isMeltdownOutput("", "x", "stop"), false);
});
