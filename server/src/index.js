import http from "http";
import express from "express";
import cors from "cors";
import compression from "compression";
import dotenv from "dotenv";
import { performance } from "perf_hooks";
import Groq from "groq-sdk";
import textToSpeech from "@google-cloud/text-to-speech";
import { z } from "zod";
import WebSocket, { WebSocketServer } from "ws";

dotenv.config();

const PORT = Number(process.env.PORT || 7079);
const CORS_ORIGIN = process.env.CORS_ORIGIN || "http://localhost:7078";

const GROQ_API_KEY = process.env.GROQ_API_KEY;
const DEEPGRAM_API_KEY = process.env.DEEPGRAM_API_KEY;

const DG_MODEL = process.env.DG_MODEL || "nova-3";
const DG_LANGUAGE = process.env.DG_LANGUAGE || "multi";
const DG_PRICE_PER_MIN_MULTI = Number(process.env.DG_PRICE_PER_MIN_MULTI || 0.0052);

const VOICES_CACHE_TTL_SEC = Number(process.env.VOICES_CACHE_TTL_SEC || 3600);

// ---- App ----
const app = express();
app.disable("x-powered-by");
app.use(compression());
app.use(express.json({ limit: "512kb" }));

// CORS only matters for local dev (7078 -> 7079). In production, Apache serves same-origin.
app.use(
  cors({
    origin: CORS_ORIGIN,
    credentials: false,
  })
);

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, service: "ai-voice-demo", time: new Date().toISOString() });
});

// ---- Groq ----
if (!GROQ_API_KEY) {
  console.warn("⚠️ GROQ_API_KEY not set. /api/models and /api/chat will fail until you configure it.");
}
const groq = new Groq({ apiKey: GROQ_API_KEY || "missing" });

app.get("/api/models", async (_req, res) => {
  try {
    const models = await groq.models.list();
    const ids = (models?.data || []).map((m) => m.id).sort();
    res.json({ models: ids });
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch Groq models", details: err?.message || String(err) });
  }
});

const ChatSchema = z.object({
  model: z.string().min(1),
  messages: z
    .array(
      z.object({
        role: z.enum(["system", "user", "assistant"]),
        content: z.string().min(1),
      })
    )
    .min(1),
  temperature: z.number().min(0).max(2).optional(),
});

app.post("/api/chat", async (req, res) => {
  const t0 = performance.now();
  try {
    const parsed = ChatSchema.parse(req.body);

    const completion = await groq.chat.completions.create({
      model: parsed.model,
      messages: parsed.messages,
      temperature: parsed.temperature ?? 0.4,
    });

    const t1 = performance.now();
    const text = completion?.choices?.[0]?.message?.content ?? "";
    const usage = completion?.usage ?? null;
    const requestId = completion?.x_groq?.id ?? null;

    res.json({
      model: completion?.model || parsed.model,
      text,
      wallTimeMs: Math.round(t1 - t0),
      usage,
      requestId,
    });
  } catch (err) {
    res.status(400).json({ error: "Bad request", details: err?.message || String(err) });
  }
});

// ---- Google TTS ----
// Uses ADC (GOOGLE_APPLICATION_CREDENTIALS). Billing must be enabled on the project.
const ttsClient = new textToSpeech.TextToSpeechClient();

// Pricing estimates (USD per 1M chars). Update if your plan differs.
const PRICE_PER_1M_USD = {
  STANDARD: 4,
  WAVENET: 4,
  NEURAL2: 16,
  STUDIO: 160,
  CHIRP_HD: 30,
  POLYGLOT: 16,
  OTHER: 16,
};

function voiceTypeFromName(voiceName = "") {
  const n = String(voiceName);
  if (n.includes("-Studio-")) return "STUDIO";
  if (n.includes("-Neural2-")) return "NEURAL2";
  if (n.includes("-Wavenet-") || n.includes("-WaveNet-")) return "WAVENET";
  if (n.includes("-Standard-")) return "STANDARD";
  if (n.includes("Chirp3-HD") || n.includes("Chirp-HD") || n.includes("-Chirp-")) return "CHIRP_HD";
  if (n.includes("-Polyglot-")) return "POLYGLOT";
  return "OTHER";
}

function estimateTtsCostUsd(voiceType, charCount) {
  const per1m = PRICE_PER_1M_USD[voiceType] ?? PRICE_PER_1M_USD.OTHER;
  return (per1m / 1_000_000) * charCount;
}

let voicesCache = { atMs: 0, voices: [] };

async function listVoicesCached() {
  const now = Date.now();
  if (voicesCache.voices.length && now - voicesCache.atMs < VOICES_CACHE_TTL_SEC * 1000) {
    return voicesCache.voices;
  }
  const [resp] = await ttsClient.listVoices({});
  const voices = (resp.voices || []).map((v) => ({
    name: v.name,
    languageCodes: v.languageCodes || [],
    ssmlGender: v.ssmlGender || "SSML_VOICE_GENDER_UNSPECIFIED",
    naturalSampleRateHertz: v.naturalSampleRateHertz || null,
    voiceType: voiceTypeFromName(v.name),
  }));
  voicesCache = { atMs: now, voices };
  return voices;
}

app.get("/api/voices", async (_req, res) => {
  try {
    const voices = await listVoicesCached();
    const languages = Array.from(new Set(voices.flatMap((v) => v.languageCodes))).sort();
    const voiceTypes = Array.from(new Set(voices.map((v) => v.voiceType))).sort();

    res.json({
      voices,
      languages,
      voiceTypes,
      cache: {
        ttlSec: VOICES_CACHE_TTL_SEC,
        cachedAt: voicesCache.atMs ? new Date(voicesCache.atMs).toISOString() : null,
        count: voices.length,
      },
      pricing: {
        currency: "USD",
        per1MCharacters: PRICE_PER_1M_USD,
        note: "Estimates only. Verify pricing in your Google Cloud console.",
      },
    });
  } catch (err) {
    res.status(500).json({ error: "Failed to list voices", details: err?.message || String(err) });
  }
});

const SynthesizeSchema = z.object({
  inputType: z.enum(["text", "ssml"]).default("text"),
  text: z.string().min(1).max(4000),
  voiceName: z.string().min(1),
  languageCode: z.string().optional(),
  audioEncoding: z.enum(["MP3", "OGG_OPUS", "LINEAR16", "MULAW"]).default("MP3"),
  speakingRate: z.number().min(0.25).max(4.0).optional(),
  pitch: z.number().min(-20).max(20).optional(),
  volumeGainDb: z.number().min(-96.0).max(16.0).optional(),
});

app.post("/api/synthesize", async (req, res) => {
  const startedAtHr = process.hrtime.bigint();
  const startedAtIso = new Date().toISOString();

  try {
    const parsed = SynthesizeSchema.parse(req.body);
    const voices = await listVoicesCached();
    const voice = voices.find((v) => v.name === parsed.voiceName);
    if (!voice) return res.status(400).json({ error: "Unknown voiceName. Fetch /api/voices and pick one from the list." });

    const voiceType = voice.voiceType;
    const warnings = [];

    // Chirp 3: HD limitations (mirrors your earlier demo)
    let inputType = parsed.inputType;
    let speakingRate = parsed.speakingRate;
    let pitch = parsed.pitch;

    if (voiceType === "CHIRP_HD") {
      if (inputType === "ssml") {
        warnings.push("Chirp 3: HD voices do not support SSML. Falling back to plain text.");
        inputType = "text";
      }
      if (speakingRate !== undefined) {
        warnings.push("Chirp 3: HD voices do not support speakingRate. Ignoring.");
        speakingRate = undefined;
      }
      if (pitch !== undefined) {
        warnings.push("Chirp 3: HD voices do not support pitch. Ignoring.");
        pitch = undefined;
      }
    }

    const charCount = parsed.text.length;

    const request = {
      input: inputType === "ssml" ? { ssml: parsed.text } : { text: parsed.text },
      voice: {
        name: parsed.voiceName,
        languageCode: parsed.languageCode || (voice.languageCodes?.[0] ?? undefined),
      },
      audioConfig: {
        audioEncoding: parsed.audioEncoding,
        ...(speakingRate !== undefined ? { speakingRate } : {}),
        ...(pitch !== undefined ? { pitch } : {}),
        ...(parsed.volumeGainDb !== undefined ? { volumeGainDb: parsed.volumeGainDb } : {}),
      },
    };

    const t0 = process.hrtime.bigint();
    const [response] = await ttsClient.synthesizeSpeech(request);
    const t1 = process.hrtime.bigint();

    const audioContent = response.audioContent?.toString("base64") ?? "";
    if (!audioContent) return res.status(500).json({ error: "No audioContent returned by Google TTS." });

    const ttsMs = Number(t1 - t0) / 1e6;
    const totalMs = Number(process.hrtime.bigint() - startedAtHr) / 1e6;
    const estimatedCostUsd = estimateTtsCostUsd(voiceType, charCount);

    const mimeType =
      parsed.audioEncoding === "MP3"
        ? "audio/mpeg"
        : parsed.audioEncoding === "OGG_OPUS"
          ? "audio/ogg"
          : parsed.audioEncoding === "LINEAR16"
            ? "audio/wav"
            : "audio/basic";

    res.json({
      audio: {
        base64: audioContent,
        mimeType,
        encoding: parsed.audioEncoding,
      },
      voice: {
        name: voice.name,
        voiceType,
        ssmlGender: voice.ssmlGender,
        languageCodes: voice.languageCodes,
        naturalSampleRateHertz: voice.naturalSampleRateHertz,
      },
      metrics: {
        server: {
          ttsMs: Math.round(ttsMs),
          totalMs: Math.round(totalMs),
          startedAtIso,
        },
        input: {
          charCount,
          inputType,
        },
        billingEstimate: {
          currency: "USD",
          estimatedCostUsd,
          per1MCharactersUsd: PRICE_PER_1M_USD[voiceType] ?? PRICE_PER_1M_USD.OTHER,
        },
      },
      warnings,
    });
  } catch (err) {
    res.status(400).json({ error: "Bad request", details: err?.message || String(err) });
  }
});

// ---- Deepgram WS proxy (/ws) ----
/**
 * Browser connects to /ws (same origin).
 * We open Deepgram wss://api.deepgram.com/v1/listen with server-side Authorization header.
 * Browser sends PCM16 16k mono frames (ArrayBuffer). We forward to Deepgram.
 * Deepgram sends JSON; we forward to browser.
 */
function buildDeepgramUrl({ model, language }) {
  const u = new URL("wss://api.deepgram.com/v1/listen");
  u.searchParams.set("model", model || "nova-3");
  u.searchParams.set("language", language || "multi");

  u.searchParams.set("encoding", "linear16");
  u.searchParams.set("sample_rate", "16000");
  u.searchParams.set("interim_results", "true");
  u.searchParams.set("smart_format", "true");

  u.searchParams.set("vad_events", "true");
  u.searchParams.set("endpointing", "100");
  u.searchParams.set("utterance_end_ms", "1000"); // <- match working

  return u.toString();
}


const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });

wss.on("connection", (clientWs, req) => {
  if (!DEEPGRAM_API_KEY) {
    safeSend(clientWs, { type: "proxy_error", message: "Missing DEEPGRAM_API_KEY on server" });
    clientWs.close();
    return;
  }

  const reqUrl = new URL(req.url, `http://${req.headers.host}`);
  const model = reqUrl.searchParams.get("model") || DG_MODEL;
  const language = reqUrl.searchParams.get("language") || DG_LANGUAGE;

  const dgUrl = buildDeepgramUrl({ model, language });

  let audioBytes = 0;
  let dgRequestId = null;

  const overallStartMs = Date.now();
  let dgOpenedMs = null;
  let dgFirstResultMs = null;
  let firstAudioSeenMs = null;
  let overallFirstResultMs = null;

  const dgWs = new WebSocket(dgUrl, {
    headers: { Authorization: `Token ${DEEPGRAM_API_KEY}` },
  });

  dgWs.on("upgrade", (res) => {
    dgRequestId = res.headers["dg-request-id"] || null;
  });

dgWs.on("unexpected-response", (_request, response) => {
  const dgErr = response.headers["dg-error"];
  const reqId = response.headers["dg-request-id"];

  const chunks = [];
  response.on("data", (c) => chunks.push(c));
  response.on("end", () => {
    const body = Buffer.concat(chunks).toString("utf8");

    console.error("Deepgram WS upgrade failed:", {
      statusCode: response.statusCode,
      dgErr,
      reqId,
      body,
    });

    safeSend(clientWs, {
      type: "proxy_error",
      message: "Deepgram upgrade failed",
      dg_error: dgErr || null,
      dg_request_id: reqId || null,
      body: body || null,
    });

    clientWs.close();
  });
});


  dgWs.on("open", () => {
    dgOpenedMs = Date.now();
    safeSend(clientWs, { type: "dg_open", dg_request_id: dgRequestId, model, language });
  });

  dgWs.on("message", (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString("utf8"));
    } catch {
      return;
    }

    if (msg.type === "Results" && dgFirstResultMs == null && dgOpenedMs != null) {
      dgFirstResultMs = Date.now() - dgOpenedMs;
      safeSend(clientWs, { type: "metric", name: "dg_ttfb_ms", value: dgFirstResultMs });
    }
    if (msg.type === "Results" && overallFirstResultMs == null && firstAudioSeenMs != null) {
      overallFirstResultMs = Date.now() - firstAudioSeenMs;
      safeSend(clientWs, { type: "metric", name: "overall_ttfb_ms", value: overallFirstResultMs });
    }

    safeSendRaw(clientWs, msg);
  });

  dgWs.on("close", (code, reason) => {
    safeSend(clientWs, { type: "dg_close", code, reason: reason?.toString?.() || "" });
    clientWs.close();
  });

  dgWs.on("error", (err) => {
    safeSend(clientWs, { type: "proxy_error", message: "Deepgram WS error", details: err?.message || String(err) });
    clientWs.close();
  });

  const keepAliveTimer = setInterval(() => {
    if (dgWs.readyState === WebSocket.OPEN) {
      dgWs.send(JSON.stringify({ type: "KeepAlive" }));
    }
  }, 5000);

  const statsTimer = setInterval(() => {
    const seconds = audioBytes / (2 * 16000);
    const cost = (seconds / 60) * DG_PRICE_PER_MIN_MULTI;
    safeSend(clientWs, {
      type: "stats",
      audio_seconds: Number(seconds.toFixed(2)),
      est_cost_usd: Number(cost.toFixed(6)),
      price_per_min_usd: DG_PRICE_PER_MIN_MULTI,
      dg_request_id: dgRequestId,
    });
  }, 600);

  clientWs.on("message", (data, isBinary) => {
    if (isBinary) {
      if (firstAudioSeenMs == null) firstAudioSeenMs = Date.now();
      audioBytes += data.length;
      if (dgWs.readyState === WebSocket.OPEN) dgWs.send(data);
      return;
    }

    let msg;
    try {
      msg = JSON.parse(data.toString("utf8"));
    } catch {
      return;
    }

    if (msg?.type === "CloseStream") {
      if (dgWs.readyState === WebSocket.OPEN) {
        dgWs.send(JSON.stringify({ type: "CloseStream" }));
      }
      return;
    }
  });

  clientWs.on("close", () => {
    clearInterval(keepAliveTimer);
    clearInterval(statsTimer);

    try {
      if (dgWs.readyState === WebSocket.OPEN) {
        dgWs.send(JSON.stringify({ type: "CloseStream" }));
      }
      dgWs.close();
    } catch {}

    const totalMs = Date.now() - overallStartMs;
    console.log("WS client disconnected. session_ms =", totalMs);
  });

  clientWs.on("error", () => {});
});

function safeSend(ws, obj) {
  if (ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify(obj));
}
function safeSendRaw(ws, obj) {
  if (ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify(obj));
}

server.listen(PORT, () => {
  console.log(`✅ ai-voice-demo backend listening on http://127.0.0.1:${PORT}`);
  console.log(`   REST:  http://127.0.0.1:${PORT}/api/health`);
  console.log(`   WS:    ws://127.0.0.1:${PORT}/ws`);
});
