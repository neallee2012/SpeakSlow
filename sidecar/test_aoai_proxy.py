"""Unit tests for sidecar/aoai_proxy.py (stdlib unittest only).

aoai_proxy reads env at import time, so we set the required env vars BEFORE
importing the module. AZURE_PHRASE_LIST_ENABLED=false makes the import-time
PHRASE_LIST load a no-op; tests then patch module attributes directly and call
the pure/loader functions.

Run from the repo root:
    sidecar/.venv/Scripts/python.exe -m unittest discover -s sidecar -p "test_*.py" -v
"""
import importlib
import os
import sys
import tempfile
import time
import unittest
from types import SimpleNamespace

# --- env BEFORE import (module reads env at import time) -------------------
os.environ["AZURE_PHRASE_LIST_ENABLED"] = "false"   # import-time PHRASE_LIST load = no-op
os.environ["SIDECAR_SECRET"] = "x"
os.environ["AZURE_TENANT_ID"] = "00000000-0000-0000-0000-000000000000"
os.environ["AZURE_CLIENT_ID"] = "11111111-1111-1111-1111-111111111111"

_HERE = os.path.dirname(os.path.abspath(__file__))
if _HERE not in sys.path:
    sys.path.insert(0, _HERE)

import aoai_proxy  # noqa: E402

m = importlib.reload(aoai_proxy)  # re-import under the env set above


class PhraseListLoaderTests(unittest.TestCase):
    """(a) m._load_phrase_list — patch module attrs, point _phrase_dir at a tmpdir."""

    def setUp(self):
        self._saved = {
            "_phrase_dir": m._phrase_dir,
            "PHRASE_LIST_ENABLED": m.PHRASE_LIST_ENABLED,
            "PHRASE_BUNDLES": m.PHRASE_BUNDLES,
            "PHRASE_EXTRA": m.PHRASE_EXTRA,
            "PHRASE_MAX": m.PHRASE_MAX,
        }
        self._tmp = tempfile.TemporaryDirectory()
        tmpdir = self._tmp.name
        m._phrase_dir = lambda: tmpdir
        m.PHRASE_LIST_ENABLED = True
        m.PHRASE_EXTRA = ""

    def tearDown(self):
        for k, v in self._saved.items():
            setattr(m, k, v)
        self._tmp.cleanup()

    def _write_bundle(self, name, lines):
        with open(os.path.join(self._tmp.name, f"{name}.txt"), "w", encoding="utf-8") as f:
            f.write("\n".join(lines))

    def test_comments_and_blank_lines_skipped(self):
        self._write_bundle("bundle_a", [
            "# this is a comment",
            "",
            "   ",
            "Azure OpenAI",
            "# another comment",
            "Fast Transcription",
            "",
        ])
        m.PHRASE_BUNDLES = ["bundle_a"]
        out = m._load_phrase_list()
        self.assertEqual(out, ["Azure OpenAI", "Fast Transcription"])

    def test_case_insensitive_dedup_across_bundles(self):
        self._write_bundle("bundle_a", ["MCP", "Entra ID"])
        self._write_bundle("bundle_b", ["mcp", "Kubernetes"])
        m.PHRASE_BUNDLES = ["bundle_a", "bundle_b"]
        out = m._load_phrase_list()
        lowered = [p.lower() for p in out]
        self.assertEqual(lowered.count("mcp"), 1)
        self.assertIn("MCP", out)          # first-seen casing wins
        self.assertNotIn("mcp", out)
        self.assertEqual(out, ["MCP", "Entra ID", "Kubernetes"])

    def test_extras_split_on_ascii_and_fullwidth_semicolons_and_newlines(self):
        m.PHRASE_BUNDLES = []
        m.PHRASE_EXTRA = "Contoso; 專案代號 Falcon；Fabrikam\nNorthwind"
        out = m._load_phrase_list()
        self.assertEqual(out, ["Contoso", "專案代號 Falcon", "Fabrikam", "Northwind"])

    def test_missing_bundle_file_does_not_raise(self):
        self._write_bundle("bundle_a", ["Alpha"])
        m.PHRASE_BUNDLES = ["does_not_exist", "bundle_a"]
        try:
            out = m._load_phrase_list()
        except Exception as e:  # pragma: no cover
            self.fail(f"_load_phrase_list raised on missing bundle: {e}")
        self.assertEqual(out, ["Alpha"])

    def test_cap_truncates_to_phrase_max(self):
        self._write_bundle("bundle_a", [f"phrase-{i}" for i in range(10)])
        m.PHRASE_BUNDLES = ["bundle_a"]
        m.PHRASE_MAX = 5
        out = m._load_phrase_list()
        self.assertEqual(len(out), 5)
        self.assertEqual(out, [f"phrase-{i}" for i in range(5)])

    def test_disabled_returns_empty(self):
        self._write_bundle("bundle_a", ["Alpha"])
        m.PHRASE_BUNDLES = ["bundle_a"]
        m.PHRASE_LIST_ENABLED = False
        self.assertEqual(m._load_phrase_list(), [])


class FakeCred:
    def __init__(self):
        self.calls = 0

    def get_token(self, scope):
        self.calls += 1
        return SimpleNamespace(token=f"tok-{self.calls}", expires_on=time.time() + 3600)


class TokenCacheTests(unittest.TestCase):
    """(b) m.get_access_token — in-memory cache with a 300s refresh margin."""

    def setUp(self):
        self._saved = {
            "_ensure_credential": m._ensure_credential,
            "AUTH_FLOW": m.AUTH_FLOW,
            "_token_cache": m._token_cache,
        }
        self.fake = FakeCred()
        m._token_cache = {"token": None, "expires_on": 0}
        m._ensure_credential = lambda: self.fake
        # azure_cli flow skips authenticate()/AuthenticationRecord handling
        m.AUTH_FLOW = "azure_cli"

    def tearDown(self):
        for k, v in self._saved.items():
            setattr(m, k, v)

    def test_cache_hit_avoids_repeat_get_token(self):
        t1 = m.get_access_token()
        t2 = m.get_access_token()
        t3 = m.get_access_token()
        self.assertEqual(self.fake.calls, 1)
        self.assertEqual(t1, "tok-1")
        self.assertEqual(t1, t2)
        self.assertEqual(t2, t3)

    def test_refresh_when_inside_expiry_margin(self):
        first = m.get_access_token()
        self.assertEqual(self.fake.calls, 1)
        # 200s left < 300s margin → next call must refresh
        m._token_cache["expires_on"] = time.time() + 200
        second = m.get_access_token()
        self.assertEqual(self.fake.calls, 2)
        self.assertEqual(second, "tok-2")
        self.assertNotEqual(first, second)


class BuildTranscriptionDefinitionTests(unittest.TestCase):
    """(c) build_transcription_definition — pure function extracted in STEP 1."""

    def test_mai_mode_has_enhanced_mode_with_model(self):
        d = m.build_transcription_definition("mai-transcribe", ["zh-TW"], "mai-transcribe-1", [])
        self.assertEqual(d["enhancedMode"], {"enabled": True, "model": "mai-transcribe-1"})
        self.assertEqual(d["profanityFilterMode"], "None")
        self.assertEqual(d["locales"], ["zh-TW"])

    def test_mai_mode_locales_passed_through_empty_stays_empty(self):
        d = m.build_transcription_definition("mai-transcribe", [], "mai-transcribe-1", [])
        self.assertEqual(d["locales"], [])

    def test_mai_mode_never_gets_phrase_list(self):
        d = m.build_transcription_definition("mai-transcribe", [], "mai-transcribe-1", ["MCP", "Contoso"])
        self.assertNotIn("phraseList", d)

    def test_zh_tw_stt_default_locales_when_empty(self):
        d = m.build_transcription_definition("zh-tw-stt", [], "mai-transcribe-1", [])
        self.assertEqual(d["locales"], ["zh-TW", "en-US"])
        self.assertEqual(d["profanityFilterMode"], "None")

    def test_zh_tw_stt_explicit_locales_respected(self):
        d = m.build_transcription_definition("zh-tw-stt", ["zh-TW"], "mai-transcribe-1", [])
        self.assertEqual(d["locales"], ["zh-TW"])

    def test_zh_tw_stt_phrase_list_present_when_non_empty(self):
        d = m.build_transcription_definition("zh-tw-stt", [], "mai-transcribe-1", ["MCP", "Contoso"])
        self.assertEqual(d["phraseList"], {"phrases": ["MCP", "Contoso"]})

    def test_zh_tw_stt_phrase_list_absent_when_empty(self):
        d = m.build_transcription_definition("zh-tw-stt", [], "mai-transcribe-1", [])
        self.assertNotIn("phraseList", d)


if __name__ == "__main__":
    unittest.main()
