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
  AZURE_AUTH_FLOW           interactive | device_code   (default interactive)
  SIDECAR_HOST              127.0.0.1
  SIDECAR_PORT              0 = pick a free port and print it
  SIDECAR_SECRET            shared local bearer secret
  SIDECAR_RECORD_PATH       where to persist the Entra AuthenticationRecord
"""
import json
import os
import sys
import threading
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

# ---- Entra ID credential ------------------------------------------------
_cred = None
_record = None
_auth_lock = threading.Lock()
_device_code_msg = {"value": None}   # latest device-code prompt, surfaced via /v1/auth/status


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

    azure-identity caches and refreshes; serialized across calls so we never pop
    two browser windows at once.
    """
    global _record
    with _auth_lock:
        cred = _ensure_credential()
        # azure_cli/default 不需要 authenticate()/record（直接拿 az session 的 token）
        if AUTH_FLOW not in ("azure_cli", "default") and _record is None:
            # First login for this machine — interactive (browser) or device code.
            _record = cred.authenticate(scopes=[SCOPE])
            _save_record(_record)
            _device_code_msg["value"] = None
        return cred.get_token(SCOPE).token


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

        return self._err(404, "not found")

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
            r = requests.post(
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
        if ASR_MODE == "mai-transcribe":
            # MAI-Transcribe 多語：locales=[] 自動偵測；輸出簡體（node 端再 OpenCC 轉繁）
            definition = {
                "locales": locales,
                "enhancedMode": {"enabled": True, "model": ASR_MODEL},
                "profanityFilterMode": "None",
            }
        else:
            # zh-tw-stt（預設）：經典 STT，zh-TW 原生繁體；加 en-US 給中英混用（片語級辨識）。
            # locales 空時用 ["zh-TW","en-US"]；設定可覆寫（例如只要 ["zh-TW"]）。
            definition = {
                "locales": locales if locales else ["zh-TW", "en-US"],
                "profanityFilterMode": "None",
            }
        url = f"{ENDPOINT}/speechtotext/transcriptions:transcribe?api-version={ASR_API_VER}"
        files = {
            "audio": ("audio.wav", audio, "audio/wav"),
            "definition": (None, json.dumps(definition), "application/json"),
        }
        try:
            r = requests.post(url, headers={"Authorization": f"Bearer {token}"}, files=files, timeout=120)
        except Exception as e:
            return self._err(502, str(e))
        if r.status_code >= 400:
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
    print(f"SIDECAR_READY host={HOST} port={actual_port} endpoint={ENDPOINT} asr_mode={ASR_MODE} asr_model={ASR_MODEL} auth_flow={AUTH_FLOW}", flush=True)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
