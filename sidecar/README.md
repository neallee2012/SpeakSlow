# SpeakSlow Azure sidecar

Local OpenAI-compatible proxy that fronts Azure (Foundry chat + Speech Fast
Transcription) with Microsoft Entra ID auth. Bundled+spawned by Electron like
`sherpa_server`; runs on `127.0.0.1`. See
`../docs/AZURE_FOUNDRY_OPENCLAW_INTEGRATION_SPEC.md`.

## Run (dev smoke test)

```bash
python -m venv .venv && . .venv/Scripts/activate   # Windows Git Bash
pip install -r requirements.txt

export AZURE_ENDPOINT="https://foundryweus2.cognitiveservices.azure.com"
export AZURE_TENANT_ID="16b3c013-d300-468d-ac64-7eda0820b6d3"
export AZURE_CLIENT_ID="4441a9d4-c9fe-400a-9873-ed18beef03c1"
export AZURE_CHAT_DEPLOYMENT="FW-MiniMax-M2.5"
export AZURE_ASR_MODEL="mai-transcribe-1"
export AZURE_ASR_LOCALES="[]"            # multilingual; or ["zh-TW"] / ["zh-CN"]
export AZURE_AUTH_FLOW="interactive"     # or device_code
export SIDECAR_PORT="53120"
export SIDECAR_SECRET="dev-local-secret"

python aoai_proxy.py
# → prints: SIDECAR_READY host=127.0.0.1 port=53120 ...
```

First `/v1/...` call (or POST `/v1/auth/login`) pops a browser (interactive) or
prints a device code. Token then cached + auto-refreshed; the
AuthenticationRecord persists silent login across restarts.

## Smoke tests

```bash
# health
curl http://127.0.0.1:53120/healthz

# trigger Entra login + check status
curl -X POST -H "Authorization: Bearer dev-local-secret" http://127.0.0.1:53120/v1/auth/login

# chat (needs AZURE_CHAT_DEPLOYMENT; "model" in body overrides it)
curl -X POST http://127.0.0.1:53120/v1/chat/completions \
  -H "Authorization: Bearer dev-local-secret" -H "Content-Type: application/json" \
  -d '{"model":"FW-MiniMax-M2.5","messages":[{"role":"user","content":"說「測試成功」"}],"max_tokens":20}'

# ASR — raw WAV body (16k mono is what SpeakSlow produces, but Fast Transcription accepts standard WAV)
curl -X POST "http://127.0.0.1:53120/v1/audio/transcriptions" \
  -H "Authorization: Bearer dev-local-secret" -H "Content-Type: audio/wav" \
  --data-binary @sample-zh.wav
# → {"text":"...","segments":[...],"language":"auto","model":"mai-transcribe-1"}
```

## Notes
- `/v1/audio/transcriptions` inbound contract is **raw `audio/wav` body** (not
  multipart) — both ends are ours, so this avoids inbound multipart parsing. The
  sidecar builds the outbound Speech multipart itself.
- Optional `?locales=zh-TW` query overrides locales per call.
- Local-only: every `/v1/*` request must carry `Authorization: Bearer
  <SIDECAR_SECRET>`. Binds `127.0.0.1` only.
