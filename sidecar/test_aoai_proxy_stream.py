"""Unit tests for the /v1/stream/* streaming path in sidecar/aoai_proxy.py.

stdlib unittest only, NO network. A fake `azure.cognitiveservices.speech`
module is injected into sys.modules at import time — i.e. BEFORE any
StreamSessionManager creates a recognizer — so the whole continuous-
recognition path runs against in-memory fakes:

  - FakePushStream        captures write()/close()
  - FakeRecognizer        captures event .connect()s, exposes
                          fire_recognizing / fire_recognized / fire_canceled /
                          fire_session_stopped test helpers
  - FakePhraseListGrammar counts addPhrase calls

aoai_proxy reads env at import time, so (like test_aoai_proxy.py) the required
env vars are set BEFORE import and the module is reloaded under them.

Run from the repo root:
    sidecar/.venv/Scripts/python.exe -m unittest discover -s sidecar -p "test_*.py" -v
"""
import base64
import importlib
import io
import json
import os
import sys
import types
import unittest
from types import SimpleNamespace

# --- env BEFORE import (module reads env at import time) -------------------
os.environ["AZURE_PHRASE_LIST_ENABLED"] = "false"   # import-time PHRASE_LIST load = no-op
os.environ["SIDECAR_SECRET"] = "x"
os.environ["AZURE_TENANT_ID"] = "00000000-0000-0000-0000-000000000000"
os.environ["AZURE_CLIENT_ID"] = "11111111-1111-1111-1111-111111111111"
os.environ["AZURE_RESOURCE_ID"] = "/subscriptions/s/resourceGroups/rg/providers/Microsoft.CognitiveServices/accounts/foundry"
os.environ["AZURE_SPEECH_REGION"] = "westus2"

_HERE = os.path.dirname(os.path.abspath(__file__))
if _HERE not in sys.path:
    sys.path.insert(0, _HERE)

import aoai_proxy  # noqa: E402

m = importlib.reload(aoai_proxy)  # re-import under the env set above


# --- fake azure.cognitiveservices.speech ------------------------------------

class FakeResultReason:
    RecognizedSpeech = "RecognizedSpeech"
    NoMatch = "NoMatch"


class FakeCancellationReason:
    Error = "Error"
    EndOfStream = "EndOfStream"


class FakeSpeechConfig:
    def __init__(self, auth_token=None, region=None):
        self.auth_token = auth_token
        self.region = region
        self.speech_recognition_language = None
        self.properties = {}

    def set_property(self, prop, value):
        self.properties[prop] = value


class FakePropertyId:
    SpeechServiceConnection_LanguageIdMode = "SpeechServiceConnection_LanguageIdMode"


class FakeAutoDetectConfig:
    def __init__(self, languages=None):
        self.languages = languages


class FakeAudioStreamFormat:
    def __init__(self, samples_per_second=None, bits_per_sample=None, channels=None):
        self.samples_per_second = samples_per_second
        self.bits_per_sample = bits_per_sample
        self.channels = channels


class FakePushStream:
    def __init__(self, stream_format=None):
        self.stream_format = stream_format
        self.writes = []
        self.closed = False

    def write(self, data):
        self.writes.append(data)

    def close(self):
        self.closed = True


class FakeAudioConfig:
    def __init__(self, stream=None):
        self.stream = stream


class _Signal:
    def __init__(self):
        self.handlers = []

    def connect(self, handler):
        self.handlers.append(handler)

    def fire(self, evt):
        for h in list(self.handlers):
            h(evt)


class FakeRecognizer:
    instances = []

    def __init__(self, speech_config=None, audio_config=None,
                 auto_detect_source_language_config=None):
        self.speech_config = speech_config
        self.audio_config = audio_config
        self.auto_detect = auto_detect_source_language_config
        self.recognizing = _Signal()
        self.recognized = _Signal()
        self.canceled = _Signal()
        self.session_stopped = _Signal()
        self.started = False
        self.stopped = False
        FakeRecognizer.instances.append(self)

    def start_continuous_recognition(self):
        self.started = True

    def stop_continuous_recognition(self):
        self.stopped = True

    # -- test helpers (mimic SDK event payload shapes) --
    def fire_recognizing(self, text):
        self.recognizing.fire(SimpleNamespace(result=SimpleNamespace(text=text, reason=None)))

    def fire_recognized(self, text, reason=FakeResultReason.RecognizedSpeech):
        self.recognized.fire(SimpleNamespace(result=SimpleNamespace(text=text, reason=reason)))

    def fire_canceled(self, err, reason=FakeCancellationReason.Error):
        self.canceled.fire(SimpleNamespace(error_details=err, reason=reason))

    def fire_canceled_nested(self, err, reason=FakeCancellationReason.Error):
        # 真 SDK 形狀：SpeechRecognitionCanceledEventArgs 沒有直掛 .reason/.error_details，
        # 全部巢狀在 .cancellation_details 底下（live E2E 抓到的回歸：直讀拿到 None，
        # EndOfStream 被誤判成錯誤 → end 回 502 'canceled: None'）。
        self.canceled.fire(SimpleNamespace(
            cancellation_details=SimpleNamespace(reason=reason, error_details=err)))

    def fire_session_stopped(self):
        self.session_stopped.fire(SimpleNamespace())


class FakePhraseListGrammar:
    last = None

    def __init__(self, recognizer=None):
        self.recognizer = recognizer
        self.phrases = []

    @classmethod
    def from_recognizer(cls, recognizer):
        g = cls(recognizer)
        cls.last = g
        return g

    def addPhrase(self, phrase):
        self.phrases.append(phrase)


def _install_fake_speechsdk():
    speech = types.ModuleType("azure.cognitiveservices.speech")
    speech.SpeechConfig = FakeSpeechConfig
    speech.SpeechRecognizer = FakeRecognizer
    speech.AutoDetectSourceLanguageConfig = FakeAutoDetectConfig
    speech.PhraseListGrammar = FakePhraseListGrammar
    speech.ResultReason = FakeResultReason
    speech.CancellationReason = FakeCancellationReason
    speech.PropertyId = FakePropertyId
    audio = types.ModuleType("azure.cognitiveservices.speech.audio")
    audio.AudioStreamFormat = FakeAudioStreamFormat
    audio.PushAudioInputStream = FakePushStream
    audio.AudioConfig = FakeAudioConfig
    speech.audio = audio
    cs = types.ModuleType("azure.cognitiveservices")
    cs.speech = speech
    sys.modules["azure.cognitiveservices"] = cs
    sys.modules["azure.cognitiveservices.speech"] = speech
    sys.modules["azure.cognitiveservices.speech.audio"] = audio
    import azure  # real namespace package (azure-identity is installed)
    azure.cognitiveservices = cs  # `import a.b.c as x` attribute walk hits the fakes
    return speech


FAKE_SDK = _install_fake_speechsdk()

_B64 = base64.b64encode(b"\x01\x02\x03\x04").decode("ascii")


class StreamTestBase(unittest.TestCase):
    """Shared mocks: no real auth, empty phrase list, fast end-wait."""

    def setUp(self):
        self._saved = {
            "get_access_token": m.get_access_token,
            "PHRASE_LIST": m.PHRASE_LIST,
            "STREAM_END_WAIT_S": m.STREAM_END_WAIT_S,
            "RESOURCE_ID": m.RESOURCE_ID,
            "SPEECH_REGION": m.SPEECH_REGION,
            "ASR_LOCALES": m.ASR_LOCALES,
            "STREAM_MANAGER": m.STREAM_MANAGER,
        }
        m.get_access_token = lambda: "fake-token"
        m.PHRASE_LIST = []
        m.STREAM_END_WAIT_S = 0.05   # tests must not sit through the real 8s wait
        m.RESOURCE_ID = "/sub/rid"
        m.SPEECH_REGION = "westus2"
        m.ASR_LOCALES = []   # 預設空 → 串流用 ["zh-TW","en-US"]
        m.STREAM_MANAGER = m.StreamSessionManager()
        FakeRecognizer.instances = []
        FakePhraseListGrammar.last = None
        self.mgr = m.STREAM_MANAGER

    def tearDown(self):
        for k, v in self._saved.items():
            setattr(m, k, v)


class StreamSessionManagerTests(StreamTestBase):

    def test_init_wires_live_verified_recipe(self):
        sid = self.mgr.init(sample_rate=16000)
        self.assertTrue(sid)
        self.assertEqual(len(FakeRecognizer.instances), 1)
        rec = FakeRecognizer.instances[0]
        self.assertTrue(rec.started)
        self.assertEqual(rec.speech_config.auth_token, "aad#/sub/rid#fake-token")
        self.assertEqual(rec.speech_config.region, "westus2")
        self.assertEqual(rec.speech_config.speech_recognition_language, "zh-TW")
        self.assertEqual(rec.auto_detect.languages, ["zh-TW", "en-US"])
        stream = rec.audio_config.stream
        self.assertIsInstance(stream, FakePushStream)
        self.assertEqual(stream.stream_format.samples_per_second, 16000)
        self.assertEqual(stream.stream_format.bits_per_sample, 16)
        self.assertEqual(stream.stream_format.channels, 1)
        # all four event handlers connected
        self.assertEqual(len(rec.recognizing.handlers), 1)
        self.assertEqual(len(rec.recognized.handlers), 1)
        self.assertEqual(len(rec.canceled.handlers), 1)
        self.assertEqual(len(rec.session_stopped.handlers), 1)

    def test_feed_writes_audio_and_returns_partial_after_recognizing(self):
        sid = self.mgr.init()
        rec = FakeRecognizer.instances[-1]
        self.assertEqual(self.mgr.feed(sid, _B64), "")   # nothing recognized yet
        self.assertEqual(rec.audio_config.stream.writes, [b"\x01\x02\x03\x04"])
        rec.fire_recognizing("你好")
        self.assertEqual(self.mgr.feed(sid, _B64), "你好")

    def test_recognized_appends_to_finals_feed_returns_finals_plus_partial(self):
        sid = self.mgr.init()
        rec = FakeRecognizer.instances[-1]
        rec.fire_recognizing("你好")
        rec.fire_recognized("你好。")
        self.assertEqual(self.mgr.feed(sid, _B64), "你好。")  # partial cleared on finalize
        rec.fire_recognizing("今天")
        self.assertEqual(self.mgr.feed(sid, _B64), "你好。今天")

    def test_end_returns_joined_final_text_and_removes_session(self):
        sid = self.mgr.init()
        rec = FakeRecognizer.instances[-1]
        stream = rec.audio_config.stream
        rec.fire_recognized("你好。")
        rec.fire_recognized("今天天氣不錯。")
        rec.fire_session_stopped()   # done already set → end does not wait
        final = self.mgr.end(sid)
        self.assertEqual(final, "你好。今天天氣不錯。")
        self.assertTrue(stream.closed)
        self.assertTrue(rec.stopped)
        with self.assertRaises(m.StreamError) as ctx:
            self.mgr.feed(sid, _B64)
        self.assertEqual(ctx.exception.status, 404)

    def test_end_partial_never_leaks_into_final_text(self):
        sid = self.mgr.init()
        rec = FakeRecognizer.instances[-1]
        rec.fire_recognized("定稿。")
        rec.fire_recognizing("還在猜")   # un-finalized hypothesis
        rec.fire_session_stopped()
        self.assertEqual(self.mgr.end(sid), "定稿。")

    def test_unknown_session_feed_and_end_error(self):
        with self.assertRaises(m.StreamError) as ctx:
            self.mgr.feed("no-such-id", _B64)
        self.assertEqual(ctx.exception.status, 404)
        with self.assertRaises(m.StreamError) as ctx:
            self.mgr.end("no-such-id")
        self.assertEqual(ctx.exception.status, 404)

    def test_second_init_closes_first(self):
        sid1 = self.mgr.init()
        rec1 = FakeRecognizer.instances[0]
        stream1 = rec1.audio_config.stream
        sid2 = self.mgr.init()
        self.assertNotEqual(sid1, sid2)
        self.assertTrue(stream1.closed)
        self.assertTrue(rec1.stopped)
        with self.assertRaises(m.StreamError):   # old session gone
            self.mgr.feed(sid1, _B64)
        self.assertEqual(self.mgr.feed(sid2, _B64), "")   # new session usable

    def test_canceled_surfaces_error_on_feed_and_end(self):
        sid = self.mgr.init()
        rec = FakeRecognizer.instances[-1]
        rec.fire_canceled("WebSocket upgrade failed: 401")
        with self.assertRaises(m.StreamError) as ctx:
            self.mgr.feed(sid, _B64)
        self.assertEqual(ctx.exception.status, 502)
        self.assertIn("WebSocket upgrade failed: 401", str(ctx.exception))
        with self.assertRaises(m.StreamError) as ctx:
            self.mgr.end(sid)
        self.assertIn("WebSocket upgrade failed: 401", str(ctx.exception))

    def test_canceled_end_of_stream_is_normal_completion(self):
        sid = self.mgr.init()
        rec = FakeRecognizer.instances[-1]
        rec.fire_recognized("好的。")
        rec.fire_canceled("", reason=FakeCancellationReason.EndOfStream)
        self.assertEqual(self.mgr.end(sid), "好的。")   # no error raised

    def test_canceled_nested_end_of_stream_is_normal_completion(self):
        # 真 SDK 巢狀形狀（live E2E 回歸）：EndOfStream 必須被視為正常收尾
        sid = self.mgr.init()
        rec = FakeRecognizer.instances[-1]
        rec.fire_recognized("好的。")
        rec.fire_canceled_nested(None, reason=FakeCancellationReason.EndOfStream)
        self.assertEqual(self.mgr.end(sid), "好的。")

    def test_canceled_nested_error_surfaces_details(self):
        sid = self.mgr.init()
        rec = FakeRecognizer.instances[-1]
        rec.fire_canceled_nested("auth expired", reason=FakeCancellationReason.Error)
        with self.assertRaises(m.StreamError) as ctx:
            self.mgr.end(sid)
        self.assertIn("auth expired", str(ctx.exception))

    def test_multi_locale_uses_continuous_lid(self):
        # 多語自動偵測必須配 Continuous LID——AtStart 會被開頭的英文詞鎖死整段語言
        #（實測回歸 2026-07-08：「Benchmark」開頭 → 整段中文變 en-US 幻聽）
        m.ASR_LOCALES = ["zh-TW", "en-US"]
        self.mgr.init()
        rec = FakeRecognizer.instances[-1]
        self.assertIsNotNone(rec.auto_detect)
        self.assertEqual(rec.auto_detect.languages, ["zh-TW", "en-US"])
        self.assertEqual(
            rec.speech_config.properties.get("SpeechServiceConnection_LanguageIdMode"),
            "Continuous")

    def test_single_locale_skips_lid_entirely(self):
        # 單語模式（["zh-TW"]）：不建 auto-detect、零鎖語言風險
        m.ASR_LOCALES = ["zh-TW"]
        self.mgr.init()
        rec = FakeRecognizer.instances[-1]
        self.assertIsNone(rec.auto_detect)
        self.assertEqual(rec.speech_config.speech_recognition_language, "zh-TW")

    def test_phrase_list_added_when_non_empty(self):
        m.PHRASE_LIST = ["MCP", "Entra ID", "Kubernetes"]
        self.mgr.init()
        self.assertIsNotNone(FakePhraseListGrammar.last)
        self.assertEqual(FakePhraseListGrammar.last.phrases, ["MCP", "Entra ID", "Kubernetes"])
        self.assertIs(FakePhraseListGrammar.last.recognizer, FakeRecognizer.instances[-1])

    def test_phrase_list_skipped_when_empty(self):
        m.PHRASE_LIST = []
        self.mgr.init()
        self.assertIsNone(FakePhraseListGrammar.last)

    def test_init_without_sdk_reports_missing(self):
        saved = sys.modules["azure.cognitiveservices.speech"]
        sys.modules["azure.cognitiveservices.speech"] = None   # import → ImportError
        try:
            with self.assertRaises(m.StreamError) as ctx:
                self.mgr.init()
            self.assertEqual(ctx.exception.status, 500)
            self.assertIn("azure-cognitiveservices-speech 未安裝", str(ctx.exception))
        finally:
            sys.modules["azure.cognitiveservices.speech"] = saved

    def test_feed_rejects_bad_base64(self):
        sid = self.mgr.init()
        with self.assertRaises(m.StreamError) as ctx:
            self.mgr.feed(sid, "not base64!!")
        self.assertEqual(ctx.exception.status, 400)


class JoinStreamSegmentsTests(unittest.TestCase):

    def test_cjk_segments_join_without_space(self):
        self.assertEqual(m._join_stream_segments(["你好。", "今天天氣不錯。"]), "你好。今天天氣不錯。")

    def test_ascii_boundary_gets_space(self):
        self.assertEqual(m._join_stream_segments(["Hello world.", "How are you?"]),
                         "Hello world. How are you?")

    def test_mixed_boundary_no_space(self):
        self.assertEqual(m._join_stream_segments(["OK", "沒問題", "GG"]), "OK沒問題GG")

    def test_blank_parts_skipped(self):
        self.assertEqual(m._join_stream_segments(["", "  ", "你好", None, "。"]), "你好。")


class StreamHttpRouteTests(StreamTestBase):
    """Route-level tests: drive Handler.do_POST with stubbed I/O (no sockets)."""

    def _post(self, path, body, secret="x"):
        handler = m.Handler.__new__(m.Handler)   # skip socket-bound __init__
        raw = body if isinstance(body, (bytes, bytearray)) else json.dumps(body).encode("utf-8")
        handler.path = path
        handler.headers = {
            "Content-Length": str(len(raw)),
            "Authorization": f"Bearer {secret}",
        }
        handler.rfile = io.BytesIO(raw)
        handler.wfile = io.BytesIO()
        captured = {}
        handler.send_response = lambda status: captured.__setitem__("status", status)
        handler.send_header = lambda *a, **k: None
        handler.end_headers = lambda: None
        handler.do_POST()
        payload = handler.wfile.getvalue()
        return captured.get("status"), (json.loads(payload) if payload else None)

    def test_http_roundtrip_init_feed_end(self):
        status, out = self._post("/v1/stream/init", {"sample_rate": 16000})
        self.assertEqual(status, 200)
        self.assertTrue(out["success"])
        sid = out["sessionId"]
        self.assertTrue(sid)

        rec = FakeRecognizer.instances[-1]
        rec.fire_recognizing("你好")
        status, out = self._post("/v1/stream/feed",
                                 {"session_id": sid, "audio_data": _B64, "is_final": False})
        self.assertEqual(status, 200)
        self.assertEqual(out, {"success": True, "partialText": "你好"})

        rec.fire_recognized("你好，世界。")
        rec.fire_session_stopped()
        status, out = self._post("/v1/stream/end", {"session_id": sid})
        self.assertEqual(status, 200)
        self.assertEqual(out, {"success": True, "finalText": "你好，世界。", "rawText": "你好，世界。"})

    def test_http_unknown_session_error_shape(self):
        status, out = self._post("/v1/stream/feed", {"session_id": "nope", "audio_data": _B64})
        self.assertEqual(status, 404)
        self.assertFalse(out["success"])
        self.assertIn("unknown stream session", out["error"])
        status, out = self._post("/v1/stream/end", {"session_id": "nope"})
        self.assertEqual(status, 404)
        self.assertFalse(out["success"])

    def test_http_bad_secret_rejected(self):
        status, out = self._post("/v1/stream/init", {"sample_rate": 16000}, secret="wrong")
        self.assertEqual(status, 401)
        self.assertEqual(len(FakeRecognizer.instances), 0)   # never reached the manager

    def test_http_invalid_json_body(self):
        status, out = self._post("/v1/stream/init", b"{not json")
        self.assertEqual(status, 400)
        self.assertFalse(out["success"])

    def test_http_sdk_missing_message(self):
        saved = sys.modules["azure.cognitiveservices.speech"]
        sys.modules["azure.cognitiveservices.speech"] = None
        try:
            status, out = self._post("/v1/stream/init", {"sample_rate": 16000})
            self.assertEqual(status, 500)
            self.assertEqual(out, {"success": False, "error": "azure-cognitiveservices-speech 未安裝"})
        finally:
            sys.modules["azure.cognitiveservices.speech"] = saved


if __name__ == "__main__":
    unittest.main()
