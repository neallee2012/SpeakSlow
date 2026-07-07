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

/**
 * 自訂修正字典（使用者維護）：一行一條「錯字=>正字」，例：論視=>潤飾。
 * # 開頭為註解、空行略過；「正字」留空表示刪除該詞。
 *
 * 與內建術語規則的差異：
 *  - 純字串替換（不用 ASCII 詞邊界 \b）——CJK 字元間沒有 \b 邊界，
 *    內建規則的比對方式對中文詞無效，這裡必須用 includes/split-join。
 *  - 大小寫敏感（使用者寫什麼就比對什麼，行為完全可預期）。
 *  - 依錯字長度由長到短套用，避免短規則先吃掉長規則。
 *
 * 用途：ASR 對個人高頻詞的頑固同音錯（潤飾→論視）用確定性替換根治，
 * 不賭 Phrase List 的機率、不賭 LLM 潤飾的猜測。
 */
function parseCorrections(rulesText) {
  if (!rulesText || typeof rulesText !== "string") return [];
  const rules = [];
  for (const line of rulesText.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const idx = t.indexOf("=>");
    if (idx <= 0) continue; // 沒有 => 或錯字為空：略過
    const from = t.slice(0, idx).trim();
    const to = t.slice(idx + 2).trim(); // 允許空字串 = 刪除該詞
    if (!from || from === to) continue;
    rules.push({ from, to });
  }
  return rules.sort((a, b) => b.from.length - a.from.length); // 長錯字先套用
}

/**
 * 單趟「同時」替換（原子字典語義）：把所有錯字組成一個 alternation regex，
 * 一次掃描完成全部替換。替換結果**不會**再被其他規則二次改寫——
 * 「A=>B 加 B=>A」是安全的互換，不會像逐條套用那樣串接坍塌（Copilot P2）。
 * alternation 依規則排序（長→短），JS regex 在同位置取第一個命中 → 長錯字優先。
 * 附帶效益：規則再多也只掃文字一趟（逐段套用時不再 O(規則數×段數) 重掃）。
 *
 * @param {string} input 轉寫文字
 * @param {Array<{from:string,to:string}>} rules parseCorrections 的輸出
 * @returns {{text:string, applied:Array<{from:string,to:string}>}}
 */
function applyCorrections(input, rules) {
  if (!input || typeof input !== "string" || !rules || !rules.length) {
    return { text: input, applied: [] };
  }
  // 編譯結果 memo 在 rules 陣列上：_postProcessor 每次轉寫 parse 一次規則，
  // 逐段套用時不重編 regex
  if (!rules.__re) {
    rules.__re = new RegExp(rules.map((r) => _escape(r.from)).join("|"), "g");
    rules.__map = new Map(rules.map((r) => [r.from, r.to]));
  }
  const applied = [];
  const seen = new Set();
  const text = input.replace(rules.__re, (m) => {
    const to = rules.__map.get(m);
    if (!seen.has(m)) {
      seen.add(m);
      applied.push({ from: m, to });
    }
    return to;
  });
  return { text, applied };
}

module.exports = { normalizeTerms, parseCorrections, applyCorrections, _loadRules };
