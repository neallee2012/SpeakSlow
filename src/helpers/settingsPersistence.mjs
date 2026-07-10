const SAVE_ONLY_TOGGLES = new Set(["debug_log_ai_prompts"]);

export function shouldAutoPersistToggle(key) {
  return !SAVE_ONLY_TOGGLES.has(key);
}
