# AI Voice Comparator (STT + LLM + TTS Latency Benchmark)

A local **React (Vite) + Node/Express** app to benchmark end‑to‑end voice latency:

- **STT:** Deepgram Live (streaming) via a backend WebSocket proxy (`/ws`)
- **LLM:** Groq Chat Completions (**SSE streaming**) via `/api/chat/stream`
- **TTS:** Google Cloud Text‑to‑Speech (**binary audio response**) via `/api/synthesize`
- **Barge‑in:** user speech interrupts AI audio (plus optional **Push‑to‑Talk** mode)

This repo is built to help you compare and optimize:
- **STT TTFB**
- **LLM TTFT**
- **TTS synth time + download time**
- overall “user stops speaking → AI starts speaking” latency

---

## Repo structure

```
.
├── client/
│   ├── vite.config.js
│   └── src/ (engine, pages, hooks, audio worklet)
├── server/
│   └── src/ (routes + Deepgram WS proxy)
├── google-stt-tts.json            # local GCP service account key (DON'T COMMIT)
├── code_dump_*.txt/html           # generated dumps
└── dump-code.sh
```

---

## Ports (dev)

- **Client (Vite):** `http://localhost:7078`
- **Server (Express):** `http://127.0.0.1:7079`
- **WebSocket (Deepgram proxy):** `ws://127.0.0.1:7079/ws` (proxied by Vite)

Your `client/vite.config.js` proxies:
- `/api` → `http://127.0.0.1:7079`
- `/ws`  → `ws://127.0.0.1:7079` (with `ws: true`)

---

## Prerequisites

- Node.js 18+
- Accounts / API Keys:
  - Groq API key
  - Deepgram API key
- Google Cloud:
  - Billing enabled
  - **Text‑to‑Speech API** enabled
  - Service account JSON key file

> ⚠️ Keep credentials private: do **not** commit `google-stt-tts.json` or `server/.env`.

---

## Setup

### 1) Backend (server)

```bash
cd server
npm install
```

Create `server/.env` (example matching your current setup):

```env
# Server port
PORT=7079

# Local dev: allow Vite dev server
CORS_ORIGIN=http://localhost:7078

# --- Keys ---
GROQ_API_KEY=xxxx
DEEPGRAM_API_KEY=xxxx

# Google Cloud Text-to-Speech:
# IMPORTANT: Billing must be enabled on your GCP project.
# Point this to your service account JSON key file.
GOOGLE_APPLICATION_CREDENTIALS=../google-stt-tts.json

# --- Deepgram STT defaults ---
DG_MODEL=nova-3
DG_LANGUAGE=multi

# --- LLM defaults ---
DEFAULT_LLM=meta-llama/llama-4-scout-17b-16e-instruct

# Deepgram price estimate (override if your plan differs)
DG_PRICE_PER_MIN_MULTI=0.0052

# Voices cache TTL (seconds)
VOICES_CACHE_TTL_SEC=3600
```

Run the server:

```bash
npm run dev
```

---

### 2) Frontend (client)

```bash
cd client
npm install
npm run dev
```

Open:

- `http://localhost:7078`

---

## How it works (high level)

1. **Mic audio capture** in the browser
2. Audio is processed in an **AudioWorklet** and converted to **PCM16 @ 16kHz**
3. Browser streams audio frames to backend `WS /ws`
4. Backend forwards frames to **Deepgram Live** and returns transcripts + stats
5. When a user utterance finalizes:
   - client calls **Groq SSE** (`/api/chat/stream`) and receives token deltas
6. The client “chunks” streaming text into speakable pieces and calls **Google TTS**
7. Client plays returned audio sequentially and records timing stats
8. **Barge-in:** if the user starts speaking while AI audio is playing, playback stops and mic streaming continues immediately

---

## API / endpoints

### REST
- `GET /api/health`
- `GET /api/models`  
  Returns available Groq model IDs; `DEFAULT_LLM` is preferred if present.
- `POST /api/chat`  
  Non-streaming response (legacy/compat).
- `POST /api/chat/stream` (**SSE**)  
  Streams `meta`, then repeated `delta` events, ending with `done`.
- `GET /api/voices`  
  Lists Google voices (cached) and helper metadata for UI selection.
- `POST /api/synthesize`  
  Returns **binary audio** and headers like:
  - `X-TTS-Tts-Ms`, `X-TTS-Total-Ms`, `X-TTS-Char-Count`, `X-TTS-Est-Cost-Usd`, etc.

### WebSocket
- `WS /ws?model=...&language=...`  
  Deepgram Live proxy. If omitted, defaults are typically `nova-3` and `multi`.

---

## Notes on localhost vs 127.0.0.1 (CORS)

Your server `.env` uses:

- `CORS_ORIGIN=http://localhost:7078`

If you ever access the client as `http://127.0.0.1:7078` *without* the Vite proxy pattern, CORS may block requests.
Recommended:
- Use `http://localhost:7078` in the browser during dev, and keep using the Vite proxy.

---

## Troubleshooting

### Google TTS: `PERMISSION_DENIED` / billing / API disabled
- Enable billing on your GCP project
- Enable **Text-to-Speech API**
- Confirm `GOOGLE_APPLICATION_CREDENTIALS` path is correct (relative to `server/` when running)

### `/api/*` returns 404 in the browser
- Ensure **both** servers are running:
  - client on `7078`
  - server on `7079`
- Confirm Vite proxy is present in `client/vite.config.js`

### WebSocket fails / closes immediately
- Confirm `DEEPGRAM_API_KEY` is set
- Confirm backend is reachable at `127.0.0.1:7079`

---

## Recommended `.gitignore` entries

Add these to avoid leaking secrets:

```
server/.env
google-stt-tts.json
*.pem
*.key
```

---

## Dev commands

**Server**
```bash
cd server
npm run dev
```

**Client**
```bash
cd client
npm run dev
```
