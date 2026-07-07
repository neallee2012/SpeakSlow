// 執行：node --test test/
const { test } = require("node:test");
const assert = require("node:assert");
const { normalizeTerms, parseCorrections, applyCorrections } = require("../src/helpers/azureTermNormalizer");

// ===== 自訂修正字典 =====

test("parseCorrections：解析、註解/空行略過、長錯字排前", () => {
  const rules = parseCorrections("# 我的修正\n論視=>潤飾\n\n船=>串\n人工智慧論視=>AI 潤飾\n沒有箭頭這行\n=>只有右邊\n同字=>同字");
  assert.deepStrictEqual(rules.map((r) => r.from), ["人工智慧論視", "論視", "船"]); // 長→短；無效行全略過
  assert.deepStrictEqual(rules[1], { from: "論視", to: "潤飾" });
});

test("applyCorrections：中文詞直接替換（不受 ASCII 詞邊界限制）＋全部出現處都換", () => {
  const rules = parseCorrections("論視=>潤飾");
  const r = applyCorrections("AI的論視功能，論視很重要", rules);
  assert.strictEqual(r.text, "AI的潤飾功能，潤飾很重要");
  assert.deepStrictEqual(r.applied, [{ from: "論視", to: "潤飾" }]);
});

test("applyCorrections：長錯字優先，短規則不搶食", () => {
  const rules = parseCorrections("船=>串\n船流程=>串流城"); // 故意讓兩者可能重疊
  const r = applyCorrections("船流程啟動", rules);
  assert.strictEqual(r.text, "串流城啟動"); // 長規則先吃
});

test("applyCorrections：單趟原子替換——替換結果不被其他規則串接改寫（Copilot P2）", () => {
  const rules = parseCorrections("論視=>潤飾\n潤飾=>修飾");
  // 逐條套用會把 論視→潤飾→修飾 串接坍塌；單趟語義下各自獨立
  const r = applyCorrections("論視與潤飾", rules);
  assert.strictEqual(r.text, "潤飾與修飾");
});

test("applyCorrections：循環規則（A=>B、B=>A）是安全互換，不坍塌", () => {
  const rules = parseCorrections("甲=>乙\n乙=>甲");
  assert.strictEqual(applyCorrections("甲乙甲", rules).text, "乙甲乙");
});

test("applyCorrections：正字留空＝刪除該詞；無規則/空文字安全", () => {
  const rules = parseCorrections("嗯=>");
  assert.strictEqual(applyCorrections("嗯我想想嗯", rules).text, "我想想");
  assert.deepStrictEqual(applyCorrections("abc", []), { text: "abc", applied: [] });
  assert.deepStrictEqual(applyCorrections("", rules), { text: "", applied: [] });
});

test("canonicalize azure open ai → Azure OpenAI（嵌在中文裡）", () => {
  const r = normalizeTerms("我們用 azure open ai 做治理");
  assert.strictEqual(r.text, "我們用 Azure OpenAI 做治理");
  assert.deepStrictEqual(r.applied, [{ from: "azure open ai", to: "Azure OpenAI" }]);
});

test("spaced acronym m c p → MCP", () => {
  assert.strictEqual(normalizeTerms("用 m c p 串接").text, "用 MCP 串接");
});

test("longest-match-first 保留 Service 尾", () => {
  assert.strictEqual(normalizeTerms("azure openai service 上線").text, "Azure OpenAI Service 上線");
});

test("已是 canonical → no-op、不產生 applied 雜訊", () => {
  const r = normalizeTerms("Azure OpenAI 已就緒");
  assert.strictEqual(r.text, "Azure OpenAI 已就緒");
  assert.deepStrictEqual(r.applied, []);
});

test("詞邊界：substring 不誤觸（mcpx 不變）", () => {
  assert.strictEqual(normalizeTerms("mcpx 不是 mcp").text, "mcpx 不是 MCP");
});

test("傳空規則陣列＝停用標準化", () => {
  assert.strictEqual(normalizeTerms("azure open ai", []).text, "azure open ai");
});

test("真實 STT 輸出：casing 由標準化修正", () => {
  // 來自 live Fast Transcription 的實際輸出（phraseList 聽對了詞，casing 交給標準化）
  const r = normalizeTerms("請幫我把Azure open AI的存取改成managed identity並啟用rbac。");
  assert.strictEqual(r.text, "請幫我把Azure OpenAI的存取改成Managed Identity並啟用RBAC。");
});

test("不過度標準化：移除的歧義 alias 維持原樣（Copilot P2）", () => {
  // 'api management'（注入 Azure）與 'ai harnessed'（動詞→名詞）已移除
  assert.strictEqual(normalizeTerms("we discussed api management today").text, "we discussed api management today");
  assert.strictEqual(normalizeTerms("AI harnessed for productivity").text, "AI harnessed for productivity");
});

test("非字串輸入安全回傳", () => {
  assert.deepStrictEqual(normalizeTerms(null), { text: null, applied: [] });
  assert.deepStrictEqual(normalizeTerms(""), { text: "", applied: [] });
});
