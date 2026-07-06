/**
 * azureTermNormalizer — Azure ASR 轉寫後的「確定性」專有名詞標準化。
 *
 * 產品/技術名詞不交給 LLM 猜（不穩定），用確定性 alias→canonical 字典修正，
 * 確保交付文件中產品名一致（如 azure open ai / Azure open AI → Azure OpenAI）。
 * 規則來自獨立檔 azureTerms.json（可版本化、與主要邏輯解耦）。
 *
 * 設計重點：
 *  - 依 from 長度由長到短套用，避免短 alias 先吃掉長片語。
 *  - 大小寫不敏感；ASCII 詞邊界（\b）比對，所以嵌在中文裡的英文術語也能命中，
 *    而中文本身不受影響。
 *  - 只在「實際改了字」時記錄到 applied（已是 canonical 的命中視為 no-op）。
 *  - 不改變字串以外的結構（timestamp / segment 由呼叫端逐段套用即可保留）。
 */
const fs = require("fs");
const path = require("path");

let _rules = null;

function _loadRules() {
  if (_rules) return _rules;
  try {
    const raw = fs.readFileSync(path.join(__dirname, "azureTerms.json"), "utf-8");
    const data = JSON.parse(raw);
    const rules = Array.isArray(data.rules) ? data.rules : [];
    _rules = rules
      .filter((r) => r && r.from && r.to)
      .map((r) => ({ from: String(r.from), to: String(r.to) }))
      .sort((a, b) => b.from.length - a.from.length) // 長片語先套用
      // 預編譯：載入時編一次，避免每次 normalizeTerms（逐段觸發）重建 36 個 RegExp。
      // global regex 與 String.replace 併用安全：Symbol.replace 會先重設 lastIndex。
      .map((r) => ({ ...r, re: new RegExp("\\b" + _escape(r.from) + "\\b", "gi") }));
  } catch (e) {
    _rules = [];
  }
  return _rules;
}

function _escape(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * @param {string} input 轉寫文字
 * @param {Array<{from:string,to:string}>} [rulesOverride] 測試/停用用；傳 [] 等於不標準化
 * @returns {{text:string, applied:Array<{from:string,to:string}>}}
 */
function normalizeTerms(input, rulesOverride) {
  if (!input || typeof input !== "string") return { text: input, applied: [] };
  const rules = rulesOverride || _loadRules();
  let text = input;
  const applied = [];
  for (const rule of rules) {
    // 內建規則已預編譯（rule.re）；rulesOverride 傳入的測試規則現編
    const re = rule.re || new RegExp("\\b" + _escape(rule.from) + "\\b", "gi");
    text = text.replace(re, (m) => {
      if (m !== rule.to) applied.push({ from: m, to: rule.to }); // 已是 canonical 不記錄
      return rule.to;
    });
  }
  return { text, applied };
}

module.exports = { normalizeTerms, _loadRules };
