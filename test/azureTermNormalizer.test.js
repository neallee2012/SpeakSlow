// 執行：node --test test/
const { test } = require("node:test");
const assert = require("node:assert");
const { normalizeTerms } = require("../src/helpers/azureTermNormalizer");

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
