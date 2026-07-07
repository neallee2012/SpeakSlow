"""Unit tests for sidecar/aoai_proxy.py (stdlib unittest only).

aoai_proxy reads env at import time, so we set the required env vars BEFORE
importing the module. AZURE_PHRASE_LIST_ENABLED=false makes the import-time
PHRASE_LIST load a no-op; tests then patch module attributes directly and call
the pure/loader functions.

Run from the repo root:
    sidecar/.venv/Scripts/python.exe -m unittest discover -s sidecar -p "test_*.py" -v
"""
import importlib
import io
import json
import os
import sys
import tempfile
import threading
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


class BlockingDeviceCodeCred:
    def __init__(self, release_event, error=None):
        self.release_event = release_event
        self.error = error
        self.started = threading.Event()
        self._lock = threading.Lock()
        self.authenticate_calls = 0

    def authenticate(self, scopes):
        with self._lock:
            self.authenticate_calls += 1
        m._set_device_code_msg("前往 https://microsoft.com/devicelogin 並輸入代碼：ABC-123")
        self.started.set()
        if not self.release_event.wait(5):
            raise RuntimeError("test timed out waiting to finish authenticate")
        if self.error:
            raise RuntimeError(self.error)
        return SimpleNamespace(username="ada@example.com")

    def get_token(self, scope):
        return SimpleNamespace(token="device-token", expires_on=time.time() + 3600)


class DeviceCodeAuthTests(unittest.TestCase):
    def setUp(self):
        self.release = threading.Event()
        self.fake = BlockingDeviceCodeCred(self.release)
        self.saved_records = []
        self._saved = {
            "AUTH_FLOW": m.AUTH_FLOW,
            "_cred": m._cred,
            "_record": m._record,
            "_auth_lock": m._auth_lock,
            "_device_code_lock": m._device_code_lock,
            "_device_code_auth": m._device_code_auth,
            "_device_code_msg": m._device_code_msg,
            "_token_cache": m._token_cache,
            "_ensure_credential": m._ensure_credential,
            "_save_record": m._save_record,
        }
        m.AUTH_FLOW = "device_code"
        m._cred = None
        m._record = None
        m._auth_lock = threading.Lock()
        m._device_code_lock = threading.Lock()
        m._device_code_auth = {"pending": False, "thread": None, "error": None}
        m._device_code_msg = {"value": None}
        m._token_cache = {"token": None, "expires_on": 0}
        m._ensure_credential = lambda: self.fake
        m._save_record = lambda record: self.saved_records.append(record)

    def tearDown(self):
        self.release.set()
        thread = m._device_code_auth.get("thread")
        if thread:
            thread.join(1)
        for k, v in self._saved.items():
            setattr(m, k, v)

    def _request(self, method, path):
        handler = m.Handler.__new__(m.Handler)
        handler.path = path
        handler.headers = {
            "Content-Length": "0",
            "Authorization": "Bearer x",
        }
        handler.rfile = io.BytesIO()
        handler.wfile = io.BytesIO()
        captured = {}
        handler.send_response = lambda status: captured.__setitem__("status", status)
        handler.send_header = lambda *a, **k: None
        handler.end_headers = lambda: None
        if method == "POST":
            handler.do_POST()
        else:
            handler.do_GET()
        payload = handler.wfile.getvalue()
        return captured.get("status"), (json.loads(payload) if payload else None)

    def _post_login(self):
        return self._request("POST", "/v1/auth/login")

    def _get_status(self):
        return self._request("GET", "/v1/auth/status")

    def _wait_until(self, predicate, timeout=1.0):
        deadline = time.time() + timeout
        while time.time() < deadline:
            if predicate():
                return
            time.sleep(0.01)
        self.fail("condition was not met before timeout")

    def test_login_returns_immediately_and_status_shows_device_code_while_blocked(self):
        start = time.monotonic()
        status, out = self._post_login()
        elapsed = time.monotonic() - start
        self.assertEqual(status, 200)
        self.assertLess(elapsed, 0.5)
        self.assertEqual(out["success"], True)
        self.assertEqual(out["pending"], True)
        self.assertTrue(self.fake.started.wait(1))

        status, out = self._get_status()
        self.assertEqual(status, 200)
        self.assertEqual(out["signedIn"], False)
        self.assertEqual(out["pending"], True)
        self.assertEqual(out["pendingDeviceCode"], "前往 https://microsoft.com/devicelogin 並輸入代碼：ABC-123")

    def test_authenticate_completion_persists_record_and_status_becomes_signed_in(self):
        self._post_login()
        self.assertTrue(self.fake.started.wait(1))
        self.release.set()
        self._wait_until(lambda: not m._device_code_pending())

        status, out = self._get_status()
        self.assertEqual(status, 200)
        self.assertEqual(out["signedIn"], True)
        self.assertEqual(out["pending"], False)
        self.assertEqual(out["username"], "ada@example.com")
        self.assertEqual(len(self.saved_records), 1)

    def test_authenticate_failure_surfaces_error_once(self):
        self.fake.error = "AADSTS authorization pending expired"
        self._post_login()
        self.assertTrue(self.fake.started.wait(1))
        self.release.set()
        self._wait_until(lambda: not m._device_code_pending())

        status, out = self._get_status()
        self.assertEqual(status, 200)
        self.assertEqual(out["signedIn"], False)
        self.assertEqual(out["pending"], False)
        self.assertIn("AADSTS authorization pending expired", out["error"])

        status, out = self._get_status()
        self.assertEqual(status, 200)
        self.assertEqual(out["signedIn"], False)
        self.assertNotIn("error", out)

    def test_second_login_while_pending_reuses_existing_authenticate(self):
        status, first = self._post_login()
        self.assertEqual(status, 200)
        self.assertTrue(self.fake.started.wait(1))

        status, second = self._post_login()
        self.assertEqual(status, 200)
        self.assertEqual(first["pending"], True)
        self.assertEqual(second["pending"], True)
        self.assertEqual(second["pendingDeviceCode"], "前往 https://microsoft.com/devicelogin 並輸入代碼：ABC-123")
        self.assertEqual(self.fake.authenticate_calls, 1)

    def test_get_access_token_fails_fast_while_device_code_login_pending(self):
        self._post_login()
        self.assertTrue(self.fake.started.wait(1))

        with self.assertRaisesRegex(RuntimeError, "device_code 登入進行中"):
            m.get_access_token()
        self.assertEqual(self.fake.authenticate_calls, 1)


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
