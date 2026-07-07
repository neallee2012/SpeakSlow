#!/usr/bin/env python3
"""SpeakSlow local Azure sidecar — OpenAI-compatible front, Azure (Entra ID) back.

Adapted from the user's openclaw `aoai-proxy.py`, with auth swapped from VM
Managed-Identity (IMDS) to desktop Microsoft Entra ID via `azure-identity`
(InteractiveBrowserCredential / DeviceCodeCredential, persistent token cache).
Runs on the laptop, bundled+spawned by Electron like `sherpa_server`.

Data flow
=========

  SpeakSlow (Electron main)                 this sidecar (127.0.0.1)            Azure (foundryweus2)
  ─────────────────────────                 ──────────────────────             ────────────────────
  AI 潤飾  ── POST /v1/chat/completions ───►  + Bearer(Entra) ──────────────►  /openai/deployments/<dep>/chat/completions
  Azure ASR ─ POST /v1/audio/transcriptions ► build Speech multipart ───────►  /speechtotext/transcriptions:transcribe
              (raw audio/wav body)            parse combinedPhrases[0].text       (mai-transcribe-1, enhancedMode)
                                          ◄── {text, segments?}  ◄───────────
  串流 ASR ── POST /v1/stream/init ────────►  Speech SDK 連續辨識 ───────────►  wss://<SPEECH_REGION>.stt.…（SDK 自管連線）
              POST /v1/stream/feed            PushAudioInputStream               token = aad#<RESOURCE_ID>#<Entra token>
              (base64 Int16 PCM per feed) ◄── {partialText} 每次 feed 回 partial
              POST /v1/stream/end         ◄── {finalText, rawText}（標準化在 Node 端做）

串流協定鏡射 sherpa 串流（request/response，無 WebSocket、無 server-push）：
init 建 session（單一活躍，init 會先關舊的）、feed 寫音訊並回「已定稿段落＋
當前 partial」、end 收尾回全文。Speech SDK 為選配（batch-only 打包可不裝，
延遲 import，缺件時回 {"success":false,"error":"azure-cognitiveservices-speech 未安裝"}）。

Single Entra token (scope cognitiveservices.azure.com/.default) covers BOTH
chat and speech because foundryweus2 is one AI-Services resource. Fast
Transcription takes a PLAIN Bearer token (no aad# wrapping). azure-identity
caches + auto-refreshes; the AuthenticationRecord persists silent login across
restarts.

Local protection: every /v1/* request must carry `Authorization: Bearer
<SIDECAR_SECRET>` (a random per-launch secret Electron passes in). The proxy
binds 127.0.0.1 only.

Env (passed by Electron at spawn)
  AZURE_ENDPOINT            https://foundryweus2.cognitiveservices.azure.com/
  AZURE_TENANT_ID           16b3c013-...
  AZURE_CLIENT_ID           4441a9d4-...           (public client app)
  AZURE_CHAT_DEPLOYMENT     <default chat deployment if request omits "model">
  AZURE_CHAT_API_VERSION    2024-10-21
  AZURE_ASR_MODEL           mai-transcribe-1
  AZURE_ASR_API_VERSION     2025-10-15
  AZURE_ASR_LOCALES         []  (JSON array; ""/"[]" = multilingual auto-detect)
  AZURE_RESOURCE_ID         Speech 資源的 ARM resource ID（串流 aad# token 需要）
  AZURE_SPEECH_REGION       westus2                (串流 Speech SDK region)
  AZURE_AUTH_FLOW           interactive | device_code   (default interactive)
  SIDECAR_HOST              127.0.0.1
  SIDECAR_PORT              0 = pick a free port and print it
  SIDECAR_SECRET            shared local bearer secret
  SIDECAR_RECORD_PATH       where to persist the Entra AuthenticationRecord
"""
import base64
import json
import os
import sys
import threading
import time
import uuid
import hmac
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import requests
from azure.identity import (
    InteractiveBrowserCredential,
    DeviceCodeCredential,
    TokenCachePersistenceOptions,
    AuthenticationRecord,
)

# ---- config -------------------------------------------------------------
ENDPOINT        = os.environ.get("AZURE_ENDPOINT", "https://foundryweus2.cognitiveservices.azure.com").rstrip("/")
TENANT_ID       = os.environ.get("AZURE_TENANT_ID", "")
CLIENT_ID       = os.environ.get("AZURE_CLIENT_ID", "")
CHAT_DEPLOYMENT = os.environ.get("AZURE_CHAT_DEPLOYMENT", "")
CHAT_API_VER    = os.environ.get("AZURE_CHAT_API_VERSION", "2024-10-21")
ASR_MODEL       = os.environ.get("AZURE_ASR_MODEL", "mai-transcribe-1")
ASR_API_VER     = os.environ.get("AZURE_ASR_API_VERSION", "2025-10-15")
# zh-tw-stt = 經典 Azure Speech STT，locale zh-TW 原生繁體（推薦）；
# mai-transcribe = MAI-Transcribe 多語（輸出簡體，需 node 端 OpenCC 轉繁）
ASR_MODE        = os.environ.get("AZURE_ASR_MODE", "zh-tw-stt")
# 串流辨識（Speech SDK 連續辨識）：aad# token 需要資源的 ARM resource ID + region
RESOURCE_ID     = os.environ.get("AZURE_RESOURCE_ID", "")
SPEECH_REGION   = os.environ.get("AZURE_SPEECH_REGION", "westus2")
AUTH_FLOW       = os.environ.get("AZURE_AUTH_FLOW", "interactive").lower()
HOST            = os.environ.get("SIDECAR_HOST", "127.0.0.1")
PORT            = int(os.environ.get("SIDECAR_PORT", "0"))
SECRET          = os.environ.get("SIDECAR_SECRET", "")
RECORD_PATH     = os.environ.get("SIDECAR_RECORD_PATH", os.path.join(os.path.expanduser("~"), ".speakslow", "entra-record.json"))

SCOPE = "https://cognitiveservices.azure.com/.default"   # covers chat + speech on an AI-Services resource

try:
    ASR_LOCALES = json.loads(os.environ.get("AZURE_ASR_LOCALES", "[]") or "[]")
    if not isinstance(ASR_LOCALES, list):
        ASR_LOCALES = []
except Exception:
    ASR_LOCALES = []

# ---- Phrase List（只在「經典/預設 Fast Transcription」= zh-tw-stt 路徑支援）------
# Phrase List 是 runtime recognition feature，用來提升預先提供詞/短語的辨識機率，
# 不需模型訓練。官方定位：Fast transcription default 支援；LLM Speech / MAI-transcribe
# 「不」支援（它們用 prompting），所以這裡只綁定到 zh-tw-stt。詞庫上限 500
# （接近上限應改用 Custom Speech）。詞庫從 phrases/<bundle>.txt 載入，使用者可在設定
# 加自訂熱詞（AZURE_PHRASE_EXTRA）。Phrase List 強化「術語被聽對」，不是語言判別修正。
PHRASE_LIST_ENABLED = os.environ.get("AZURE_PHRASE_LIST_ENABLED", "true").strip().lower() not in ("0", "false", "no", "")
PHRASE_BUNDLES = [b.strip() for b in os.environ.get("AZURE_PHRASE_BUNDLES", "ai_governance,ai_harness,azure_cloud").split(",") if b.strip()]
PHRASE_EXTRA = os.environ.get("AZURE_PHRASE_EXTRA", "")
PHRASE_MAX = 500

def _phrase_dir():
    if getattr(sys, "frozen", False):
        return os.path.join(getattr(sys, "_MEIPASS", os.path.dirname(sys.executable)), "phrases")
    return os.path.join(os.path.dirname(os.path.abspath(__file__)), "phrases")

def _load_phrase_list():
    if not PHRASE_LIST_ENABLED:
        return []
    out, seen = [], set()
    def add(p):
        p = p.strip()
        if not p or p.startswith("#"):
            return
        k = p.lower()
        if k in seen:
            return
        seen.add(k); out.append(p)
    d = _phrase_dir()
    for b in PHRASE_BUNDLES:
        fp = os.path.join(d, f"{b}.txt")
        try:
            with open(fp, "r", encoding="utf-8") as f:
                for line in f:
                    add(line)
        except FileNotFoundError:
            print(f"[sidecar] WARN phrase bundle not found: {fp}", flush=True)
        except Exception as e:
            print(f"[sidecar] WARN phrase bundle read failed {fp}: {e}", flush=True)
    for chunk in PHRASE_EXTRA.replace(";", "\n").replace("；", "\n").split("\n"):
        add(chunk)
    if len(out) > PHRASE_MAX:
        print(f"[sidecar] WARN phrase list {len(out)} > {PHRASE_MAX}，截斷（建議改用 Custom Speech）", flush=True)
        out = out[:PHRASE_MAX]
    return out

PHRASE_LIST = _load_phrase_list()


def build_transcription_definition(mode, locales, asr_model, phrase_list):
    """Build the Fast Transcription 'definition' payload (pure function).

    mai-transcribe 多語：locales=[] 自動偵測；輸出簡體（node 端再 OpenCC 轉繁）。
    zh-tw-stt（預設）：經典 STT，zh-TW 原生繁體；加 en-US 給中英混用（片語級辨識）。
    locales 空時用 ["zh-TW","en-US"]；設定可覆寫（例如只要 ["zh-TW"]）。
    Phrase List 只在經典路徑加（已 live 驗證的 schema = {"phrases":[...]}）。
    """
    if mode == "mai-transcribe":
        return {
            "locales": locales,
            "enhancedMode": {"enabled": True, "model": asr_model},
            "profanityFilterMode": "None",
        }
    definition = {
        "locales": locales if locales else ["zh-TW", "en-US"],
        "profanityFilterMode": "None",
    }
    if phrase_list:
        definition["phraseList"] = {"phrases": phrase_list}
    return definition

# ---- Entra ID credential ------------------------------------------------
_cred = None
_record = None
_auth_lock = threading.Lock()
_device_code_msg = {"value": None}   # latest device-code prompt, surfaced via /v1/auth/status
# token 記憶體快取：AzureCliCredential「不」快取（每次 get_token 都 spawn az 子行程，
# Windows 上 1–3 秒），所以在這層自己快取到期前 5 分鐘。expires_on 為 epoch 秒。
_token_cache = {"token": None, "expires_on": 0}
# HTTP 連線復用：裸 requests.post 每次重新 TCP+TLS 握手（到美西 ~300–400ms）；
# Session 保持 keep-alive，跨請求復用連線。
_http = requests.Session()


def _load_record():
    try:
        with open(RECORD_PATH, "r", encoding="utf-8") as f:
            return AuthenticationRecord.deserialize(f.read())
    except Exception:
        return None


def _save_record(record):
    try:
        os.makedirs(os.path.dirname(RECORD_PATH), exist_ok=True)
        with open(RECORD_PATH, "w", encoding="utf-8") as f:
            f.write(record.serialize())
    except Exception as e:
        print(f"[sidecar] WARN could not persist auth record: {e}", flush=True)


def _build_credential(record):
    # azure_cli / default：用機器上現有的 `az login` session（無彈窗）。適合 dev/power-user，
    # 或想用 Azure CLI 身分而非 app 內登入。仍是 Entra ID。
    if AUTH_FLOW in ("azure_cli", "default"):
        from azure.identity import AzureCliCredential
        return AzureCliCredential(tenant_id=TENANT_ID or None)
    cache = TokenCachePersistenceOptions(name="speakslow-azure")
    common = dict(
        tenant_id=TENANT_ID or None,
        client_id=CLIENT_ID or None,
        cache_persistence_options=cache,
        authentication_record=record,
    )
    if AUTH_FLOW == "device_code":
        def _prompt(verification_uri, user_code, _expires_on):
            msg = f"前往 {verification_uri} 並輸入代碼：{user_code}"
            _device_code_msg["value"] = msg
            print(f"[sidecar] DEVICE CODE: {msg}", flush=True)
        return DeviceCodeCredential(prompt_callback=_prompt, **common)
    # 不指定 redirect_uri：azure-identity 會用 http://localhost 並自動挑一個空閒 port
    # （AAD 上註冊 http://localhost 可對應任意 port）。硬寫 "http://localhost" 會逼用 port 80。
    return InteractiveBrowserCredential(**common)


def _ensure_credential():
    global _cred, _record
    if _cred is None:
        _record = _load_record()
        _cred = _build_credential(_record)
    return _cred


def get_access_token():
    """Return a valid bearer token; triggers interactive/device login on first use.

    自帶記憶體快取：InteractiveBrowserCredential 走 MSAL 有快取，但 AzureCliCredential
    每次 get_token 都 spawn `az` 子行程（1–3 秒），必須在這層快取。到期前 5 分鐘換新。
    serialized across calls so we never pop two browser windows at once.
    """
    global _record
    # 快取命中走 fast path（不搶鎖）；臨界區內再 double-check 防重複刷新
    if _token_cache["token"] and _token_cache["expires_on"] - time.time() > 300:
        return _token_cache["token"]
    with _auth_lock:
        if _token_cache["token"] and _token_cache["expires_on"] - time.time() > 300:
            return _token_cache["token"]
        cred = _ensure_credential()
        # azure_cli/default 不需要 authenticate()/record（直接拿 az session 的 token）
        if AUTH_FLOW not in ("azure_cli", "default") and _record is None:
            # First login for this machine — interactive (browser) or device code.
            _record = cred.authenticate(scopes=[SCOPE])
            _save_record(_record)
            _device_code_msg["value"] = None
        t = cred.get_token(SCOPE)
        _token_cache["token"] = t.token
        _token_cache["expires_on"] = t.expires_on
        return t.token


def auth_status():
    if AUTH_FLOW in ("azure_cli", "default"):
        try:
            get_access_token()
            return {"signedIn": True, "mode": AUTH_FLOW}
        except Exception as e:
            return {"signedIn": False, "mode": AUTH_FLOW, "error": str(e)}
    try:
        with _auth_lock:
            _ensure_credential()  # 載入磁碟上的 AuthenticationRecord：重啟後 _record 是 None 但快取仍在
            signed_in = _record is not None
            username = getattr(_record, "username", None) if _record else None
        return {"signedIn": signed_in, "username": username, "pendingDeviceCode": _device_code_msg["value"]}
    except Exception as e:
        return {"signedIn": False, "error": str(e)}


# ---- Azure Speech 串流辨識（連續辨識，鏡射 sherpa 串流協定）------------------
# 協定 = request/response：init 建 session、每次 feed 寫入音訊並回傳 partial、
# end 收尾回傳全文（無 WebSocket、無 server-push）。Speech SDK 為選配
# （batch-only 打包可不裝）：延遲 import，缺件時回友善錯誤。

STREAM_END_WAIT_S = 8.0   # end：關 push stream 後等最終 recognized/session_stopped 的上限秒數


class StreamError(Exception):
    """Streaming API error carrying the HTTP status to surface."""

    def __init__(self, status, message):
        super().__init__(message)
        self.status = status


def _import_speechsdk():
    """Lazy import：batch-only 環境沒裝 Speech SDK 也能啟動 sidecar。"""
    try:
        import azure.cognitiveservices.speech as speechsdk
        return speechsdk
    except ImportError:
        return None


def _join_stream_segments(parts):
    """把已定稿段落（＋當前 partial）串成一段文字。

    中文段落直接相連（Azure 段尾自帶標點）；兩段交界都是 ASCII（英文/數字）
    時補一個空白，避免 code-switching 時英文字黏在一起。
    """
    out = ""
    for p in parts:
        p = (p or "").strip()
        if not p:
            continue
        if out and out[-1].isascii() and p[0].isascii():
            out += " "
        out += p
    return out


class StreamSessionManager:
    """單一活躍 Azure Speech 連續辨識 session（plain class，方便用假 SDK 單測）。

    live-verified 配方（spike）：
      SpeechConfig(auth_token="aad#<RESOURCE_ID>#<Entra token>", region=SPEECH_REGION)
      + speech_recognition_language="zh-TW"
      + AutoDetectSourceLanguageConfig(["zh-TW","en-US"])（中英 code-switching）
      + PushAudioInputStream(sample_rate/16bit/mono) + start_continuous_recognition()
    事件：recognizing → 暫存 partial；recognized(RecognizedSpeech) → 段落定稿；
    canceled(EndOfStream) → 正常收尾；canceled(其他) → 記錯誤、feed/end 回報。
    """

    def __init__(self):
        self._lock = threading.Lock()
        self._sessions = {}      # session_id → state dict
        self._active_id = None

    # -- lifecycle --
    def init(self, sample_rate=16000):
        speechsdk = _import_speechsdk()
        if speechsdk is None:
            raise StreamError(500, "azure-cognitiveservices-speech 未安裝")
        # 舊 session 不在這裡提前關：token/SDK 啟動失敗時要保住現役 session
        # （提前關會讓「失敗的重啟」弄丟活的 session → 之後 feed/end 全 404，Copilot P1）。
        # 換手在方法尾端「新 session 建立成功後」由 racing-swap 一次完成。
        token = get_access_token()       # 失敗由 handler 轉成 502
        speech_config = speechsdk.SpeechConfig(
            auth_token=f"aad#{RESOURCE_ID}#{token}", region=SPEECH_REGION)
        speech_config.speech_recognition_language = "zh-TW"
        auto_detect = speechsdk.AutoDetectSourceLanguageConfig(languages=["zh-TW", "en-US"])
        fmt = speechsdk.audio.AudioStreamFormat(
            samples_per_second=sample_rate, bits_per_sample=16, channels=1)
        push_stream = speechsdk.audio.PushAudioInputStream(stream_format=fmt)
        audio_config = speechsdk.audio.AudioConfig(stream=push_stream)
        recognizer = speechsdk.SpeechRecognizer(
            speech_config=speech_config,
            audio_config=audio_config,
            auto_detect_source_language_config=auto_detect,
        )
        if PHRASE_LIST:
            grammar = speechsdk.PhraseListGrammar.from_recognizer(recognizer)
            for p in PHRASE_LIST:
                grammar.addPhrase(p)

        sid = str(uuid.uuid4())
        sess = {
            "push_stream": push_stream,
            "recognizer": recognizer,
            "finals": [],                # 已定稿段落
            "partial": "",               # 當前 partial 假說
            "error": None,
            "done": threading.Event(),   # session_stopped / canceled
        }

        def _on_recognizing(evt):
            with self._lock:
                sess["partial"] = getattr(evt.result, "text", "") or ""

        def _on_recognized(evt):
            if getattr(evt.result, "reason", None) != speechsdk.ResultReason.RecognizedSpeech:
                return
            text = getattr(evt.result, "text", "") or ""
            with self._lock:
                if text:
                    sess["finals"].append(text)
                sess["partial"] = ""

        def _on_canceled(evt):
            # 真 SDK 的 reason/error_details 巢狀在 evt.cancellation_details 底下
            # （SpeechRecognitionCanceledEventArgs 沒有直掛 .reason —— 直讀會拿到 None，
            # EndOfStream 判定永遠失敗，正常收尾被誤判成錯誤）。保留直掛 fallback 給測試假 SDK。
            det = getattr(evt, "cancellation_details", None)
            reason = getattr(det, "reason", None) if det is not None else None
            if reason is None:
                reason = getattr(evt, "reason", None)
            eos = getattr(speechsdk.CancellationReason, "EndOfStream", object())
            if reason is not None and reason == eos:
                sess["done"].set()       # 音訊餵完的正常收尾，不是錯誤
                return
            details = (
                (getattr(det, "error_details", None) if det is not None else None)
                or getattr(evt, "error_details", None)
                or str(reason)
            )
            with self._lock:
                sess["error"] = f"Azure Speech canceled: {details}"
            sess["done"].set()

        def _on_stopped(_evt):
            sess["done"].set()

        recognizer.recognizing.connect(_on_recognizing)
        recognizer.recognized.connect(_on_recognized)
        recognizer.canceled.connect(_on_canceled)
        recognizer.session_stopped.connect(_on_stopped)
        recognizer.start_continuous_recognition()

        with self._lock:
            racing = self._active_id     # 理論上 None；防兩個 init 併發互踩
            self._sessions[sid] = sess
            self._active_id = sid
        if racing is not None and racing != sid:
            self._abort(racing)
        return sid

    def feed(self, session_id, audio_b64, is_final=False):
        """寫入一段 base64 Int16 PCM，回傳「已定稿段落＋當前 partial」。

        is_final 只是 sherpa 協定欄位的鏡射；真正的 flush 在 /v1/stream/end。
        """
        sess = self._require(session_id)
        try:
            audio = base64.b64decode(audio_b64 or "")
        except Exception:
            raise StreamError(400, "audio_data 不是有效的 base64")
        with self._lock:
            if sess["error"]:
                raise StreamError(502, sess["error"])
        if audio:
            try:
                sess["push_stream"].write(audio)
            except Exception as e:
                with self._lock:
                    err = sess["error"]
                raise StreamError(502, err or f"push stream write failed: {e}")
        with self._lock:
            if sess["error"]:
                raise StreamError(502, sess["error"])
            parts = list(sess["finals"])
            if sess["partial"]:
                parts.append(sess["partial"])
        return _join_stream_segments(parts)

    def end(self, session_id):
        """收尾：關 stream → 等最終辨識（上限 STREAM_END_WAIT_S）→ stop → 回全文。"""
        sess = self._require(session_id)
        try:
            try:
                sess["push_stream"].close()
            except Exception:
                pass
            # 等 SDK 把殘餘音訊辨識完（最終 recognized → canceled(EndOfStream)/session_stopped）
            sess["done"].wait(STREAM_END_WAIT_S)
            try:
                sess["recognizer"].stop_continuous_recognition()
            except Exception:
                pass
        finally:
            with self._lock:
                self._sessions.pop(session_id, None)
                if self._active_id == session_id:
                    self._active_id = None
        with self._lock:
            err = sess["error"]
            parts = list(sess["finals"])
        if err:
            raise StreamError(502, err)
        return _join_stream_segments(parts)

    # -- internals --
    def _require(self, session_id):
        with self._lock:
            sess = self._sessions.get(session_id)
        if sess is None:
            raise StreamError(404, f"unknown stream session: {session_id or '(empty)'}")
        return sess

    def _abort(self, session_id):
        """立刻關掉 session、不等最終結果（init 換新 session 時用）。"""
        with self._lock:
            sess = self._sessions.pop(session_id, None)
            if self._active_id == session_id:
                self._active_id = None
        if sess is None:
            return
        try:
            sess["push_stream"].close()
        except Exception:
            pass
        try:
            sess["recognizer"].stop_continuous_recognition()
        except Exception:
            pass


STREAM_MANAGER = StreamSessionManager()


# ---- HTTP handler -------------------------------------------------------
class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        return

    # -- helpers --
    def _write(self, status, body, content_type="application/json"):
        if isinstance(body, str):
            body = body.encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _err(self, status, msg):
        self._write(status, json.dumps({"error": {"type": "sidecar_error", "message": msg}}))

    def _authorized(self):
        if not SECRET:
            return True  # no secret configured (dev) → allow
        got = self.headers.get("Authorization", "")
        if got.startswith("Bearer "):
            got = got[len("Bearer "):]
        return hmac.compare_digest(got, SECRET)

    def _read_body(self):
        n = int(self.headers.get("Content-Length", "0") or "0")
        return self.rfile.read(n) if n else b""

    # -- GET --
    def do_GET(self):
        path = self.path.split("?", 1)[0]
        if path == "/healthz":
            return self._write(200, "ok\n", "text/plain")
        if path == "/v1/auth/status":
            if not self._authorized():
                return self._err(401, "bad local secret")
            return self._write(200, json.dumps(auth_status()))
        return self._err(404, "not found")

    # -- POST --
    def do_POST(self):
        path = self.path.split("?", 1)[0]
        if not self._authorized():
            return self._err(401, "bad local secret")

        if path == "/v1/auth/login":
            try:
                get_access_token()
                return self._write(200, json.dumps(auth_status()))
            except Exception as e:
                return self._err(502, f"login failed: {e}")

        if path == "/v1/chat/completions":
            return self._handle_chat()

        if path == "/v1/audio/transcriptions":
            return self._handle_transcription()

        if path == "/v1/stream/init":
            return self._handle_stream_init()

        if path == "/v1/stream/feed":
            return self._handle_stream_feed()

        if path == "/v1/stream/end":
            return self._handle_stream_end()

        return self._err(404, "not found")

    # -- /v1/stream/* → Azure Speech 連續辨識（鏡射 sherpa 串流協定的回應形狀）--
    def _stream_err(self, status, msg):
        self._write(status, json.dumps({"success": False, "error": msg}))

    def _read_json_object(self):
        try:
            body = json.loads(self._read_body() or b"{}")
        except Exception:
            return None
        return body if isinstance(body, dict) else None

    def _handle_stream_init(self):
        body = self._read_json_object()
        if body is None:
            return self._stream_err(400, "invalid JSON body")
        try:
            sample_rate = int(body.get("sample_rate") or 16000)
        except (TypeError, ValueError):
            return self._stream_err(400, "invalid sample_rate")
        try:
            sid = STREAM_MANAGER.init(sample_rate=sample_rate)
        except StreamError as e:
            return self._stream_err(e.status, str(e))
        except Exception as e:
            return self._stream_err(502, f"stream init failed: {e}")
        self._write(200, json.dumps({"success": True, "sessionId": sid}))

    def _handle_stream_feed(self):
        body = self._read_json_object()
        if body is None:
            return self._stream_err(400, "invalid JSON body")
        try:
            partial = STREAM_MANAGER.feed(
                body.get("session_id") or "",
                body.get("audio_data") or "",
                is_final=bool(body.get("is_final")),
            )
        except StreamError as e:
            return self._stream_err(e.status, str(e))
        except Exception as e:
            return self._stream_err(502, f"stream feed failed: {e}")
        self._write(200, json.dumps({"success": True, "partialText": partial}))

    def _handle_stream_end(self):
        body = self._read_json_object()
        if body is None:
            return self._stream_err(400, "invalid JSON body")
        try:
            final = STREAM_MANAGER.end(body.get("session_id") or "")
        except StreamError as e:
            return self._stream_err(e.status, str(e))
        except Exception as e:
            return self._stream_err(502, f"stream end failed: {e}")
        # rawText = 未標準化全文；確定性標準化（別名→正名）在 Node 端 streamingEnd 做
        self._write(200, json.dumps({"success": True, "finalText": final, "rawText": final}))

    # -- /v1/chat/completions → Azure OpenAI deployment route --
    def _handle_chat(self):
        try:
            body = json.loads(self._read_body() or b"{}")
        except Exception:
            return self._err(400, "invalid JSON body")
        deployment = body.pop("model", None) or CHAT_DEPLOYMENT
        if not deployment:
            return self._err(400, "no chat deployment (set request 'model' or AZURE_CHAT_DEPLOYMENT)")
        try:
            token = get_access_token()
        except Exception as e:
            return self._err(502, f"auth: {e}")
        url = f"{ENDPOINT}/openai/deployments/{deployment}/chat/completions?api-version={CHAT_API_VER}"
        try:
            r = _http.post(
                url,
                headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
                json=body,
                timeout=120,
            )
            self._write(r.status_code, r.content, r.headers.get("Content-Type", "application/json"))
        except Exception as e:
            self._err(502, str(e))

    # -- /v1/audio/transcriptions → Azure Speech Fast Transcription --
    # Inbound contract (SpeakSlow → sidecar): raw audio/wav body. Optional
    # ?locales=zh-TW,zh-CN overrides the configured locales for this call.
    def _handle_transcription(self):
        audio = self._read_body()
        if not audio:
            return self._err(400, "empty audio body")
        # per-request locale override
        locales = ASR_LOCALES
        if "?" in self.path:
            from urllib.parse import parse_qs
            q = parse_qs(self.path.split("?", 1)[1])
            if q.get("locales"):
                locales = [x for x in q["locales"][0].split(",") if x]
        try:
            token = get_access_token()
        except Exception as e:
            return self._err(502, f"auth: {e}")
        definition = build_transcription_definition(ASR_MODE, locales, ASR_MODEL, PHRASE_LIST)
        # debug：輸出 request payload（definition）但「絕不」含 token / secret。
        if os.environ.get("SIDECAR_DEBUG"):
            safe = dict(definition)
            pl = (safe.get("phraseList") or {}).get("phrases")
            if pl is not None:
                safe["phraseList"] = {"phrases_count": len(pl)}
            print(f"[sidecar] transcribe mode={ASR_MODE} definition={json.dumps(safe, ensure_ascii=False)}", flush=True)
        url = f"{ENDPOINT}/speechtotext/transcriptions:transcribe?api-version={ASR_API_VER}"
        files = {
            "audio": ("audio.wav", audio, "audio/wav"),
            "definition": (None, json.dumps(definition), "application/json"),
        }
        # Fast Transcription 偶發 429（節流）/500/503：尊重 Retry-After 退避重試，最多 3 次。
        # files 用 bytes（非串流），可安全重送。
        r = None
        for attempt in range(3):
            try:
                r = _http.post(url, headers={"Authorization": f"Bearer {token}"}, files=files, timeout=120)
            except Exception as e:
                if attempt == 2:
                    return self._err(502, str(e))
                time.sleep(1.0 * (attempt + 1))
                continue
            if r.status_code in (429, 500, 503) and attempt < 2:
                try:
                    wait = float(r.headers.get("Retry-After", ""))
                except (TypeError, ValueError):
                    wait = 1.5 * (attempt + 1)
                time.sleep(min(max(wait, 0.5), 8))
                continue
            break
        if r.status_code >= 400:
            # 給前端好懂、可行動的訊息（保留原始 HTTP status 供除錯）。
            hint = {
                401: "Azure 認證失敗，請到設定重新登入。",
                403: "權限不足：登入身分缺 Cognitive Services Speech User 角色。",
                422: "音訊無法辨識（可能太短、靜音或格式問題），請重講一次。",
                429: "Azure 語音服務忙碌中（節流），已重試仍失敗，稍候幾秒再試。",
            }.get(r.status_code)
            if hint:
                return self._write(r.status_code, json.dumps({"error": {"message": f"{hint}（HTTP {r.status_code}）"}}), "application/json")
            return self._write(r.status_code, r.content, r.headers.get("Content-Type", "application/json"))
        try:
            data = r.json()
        except Exception:
            return self._err(502, "speech response not JSON")
        combined = data.get("combinedPhrases") or []
        text = combined[0].get("text", "") if combined else ""
        # Map phrases[] timing → segments so SpeakSlow's 停頓斷行/SRT can survive.
        segments = []
        for p in data.get("phrases", []) or []:
            off = p.get("offsetMilliseconds", 0) / 1000.0
            dur = p.get("durationMilliseconds", 0) / 1000.0
            segments.append({"start": off, "end": off + dur, "text": p.get("text", "")})
        out = {
            "text": text,
            "segments": segments or None,
            "raw_text": text,
            "confidence": (data.get("phrases", [{}])[0].get("confidence") if data.get("phrases") else None),
            "language": (locales[0] if locales else "auto"),
            "model": ASR_MODEL,
        }
        self._write(200, json.dumps(out))


def main():
    if not (TENANT_ID and CLIENT_ID):
        print("[sidecar] WARN AZURE_TENANT_ID / AZURE_CLIENT_ID not set", flush=True)
    httpd = ThreadingHTTPServer((HOST, PORT), Handler)
    actual_port = httpd.server_address[1]
    # Electron reads this line from stdout to learn the chosen port.
    print(f"SIDECAR_READY host={HOST} port={actual_port} endpoint={ENDPOINT} asr_mode={ASR_MODE} asr_model={ASR_MODEL} speech_region={SPEECH_REGION} auth_flow={AUTH_FLOW} phrases={len(PHRASE_LIST)}", flush=True)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
