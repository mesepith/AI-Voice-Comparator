import express from "express";
import { z } from "zod";
import textToSpeech from "@google-cloud/text-to-speech";

export const ttsRouter = express.Router();

const ttsClient = new textToSpeech.TextToSpeechClient();

const VOICES_CACHE_TTL_SEC = 6 * 60 * 60;
let voicesCache = { atMs: 0, voices: [] };

// Pricing estimates (USD per 1M chars). Update if you want.
const PRICE_PER_1M_USD = {
  STANDARD: 4,
  WAVENET: 4,
  NEURAL2: 16,
  STUDIO: 160,
  CHIRP_HD: 30,
  POLYGLOT: 16,
  OTHER: 16,
};

// IMPORTANT: infer voice type from name (this is what your earlier working server did)
function voiceTypeFromName(voiceName = "") {
  const n = String(voiceName);

  if (n.includes("-Studio-")) return "STUDIO";
  if (n.includes("-Neural2-") || n.includes("Neural2")) return "NEURAL2";
  if (n.includes("-Wavenet-") || n.includes("-WaveNet-") || n.includes("Wavenet") || n.includes("WaveNet")) return "WAVENET";
  if (n.includes("-Standard-") || n.includes("Standard")) return "STANDARD";
  if (n.includes("Chirp3-HD") || n.includes("Chirp-HD") || n.includes("-Chirp-") || n.includes("Chirp")) return "CHIRP_HD";
  if (n.includes("-Polyglot-") || n.includes("Polyglot")) return "POLYGLOT";

  return "OTHER";
}

// Estimate cost based on voice type and character count
function estimateTtsCostUsd(voiceType, charCount) {
  const per1m = PRICE_PER_1M_USD[voiceType] ?? PRICE_PER_1M_USD.OTHER;
  return (per1m / 1_000_000) * charCount;
}

function encodingToMime(enc) {
  if (enc === "MP3") return "audio/mpeg";
  if (enc === "OGG_OPUS") return "audio/ogg";
  if (enc === "LINEAR16") return "audio/wav";
  if (enc === "MULAW") return "audio/basic";
  return "application/octet-stream";
}

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

ttsRouter.get("/api/voices", async (_req, res) => {
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
        note: "Estimates only.",
      },
    });
  } catch (e) {
    res.status(500).json({ error: "Failed to list voices", details: String(e?.message || e) });
  }
});

const SynthesizeSchema = z.object({
  inputType: z.enum(["text", "ssml"]).default("text"),
  text: z.string().min(1).max(4000),
  voiceName: z.string().min(1),
  languageCode: z.string().optional(),
  audioEncoding: z.enum(["MP3", "OGG_OPUS", "LINEAR16", "MULAW"]).default("OGG_OPUS"),
  speakingRate: z.number().min(0.25).max(4.0).optional(),
  pitch: z.number().min(-20).max(20).optional(),
  volumeGainDb: z.number().min(-96.0).max(16.0).optional(),
});

ttsRouter.post("/api/synthesize", async (req, res) => {
  const startedAtHr = process.hrtime.bigint();

  try {
    const parsed = SynthesizeSchema.parse(req.body);
    const voices = await listVoicesCached();
    const voice = voices.find((v) => v.name === parsed.voiceName);
    if (!voice) return res.status(400).json({ error: "Unknown voiceName. Fetch /api/voices and pick one from the list." });

    const voiceType = voice.voiceType;
    const warnings = [];

    // Chirp 3: HD limitations (same logic you had earlier)
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

    const audioContent = response.audioContent;
    if (!audioContent) return res.status(500).json({ error: "No audioContent returned by Google TTS." });

    const audioBuf = Buffer.isBuffer(audioContent) ? audioContent : Buffer.from(audioContent);

    const serverTtsMs = Math.round(Number(t1 - t0) / 1e6);
    const serverTotalMs = Math.round(Number(process.hrtime.bigint() - startedAtHr) / 1e6);
    const estCostUsd = estimateTtsCostUsd(voiceType, charCount);
    const mime = encodingToMime(parsed.audioEncoding);

    // ✅ Binary audio (faster than base64 JSON)
    res.setHeader("Content-Type", mime);
    res.setHeader("Content-Length", String(audioBuf.length));
    res.setHeader("Cache-Control", "no-store");

    // ✅ Important server timing headers
    res.setHeader("Access-Control-Expose-Headers", [
      "X-TTS-Tts-Ms",
      "X-TTS-Total-Ms",
      "X-TTS-Char-Count",
      "X-TTS-Est-Cost-Usd",
      "X-TTS-Encoding",
      "X-TTS-Voice-Type",
      "X-TTS-Warnings",
    ].join(", "));

    res.setHeader("X-TTS-Tts-Ms", String(serverTtsMs));           // <-- Google call time (server-side)
    res.setHeader("X-TTS-Total-Ms", String(serverTotalMs));       // <-- server end-to-end for this endpoint
    res.setHeader("X-TTS-Char-Count", String(charCount));
    res.setHeader("X-TTS-Est-Cost-Usd", String(estCostUsd));
    res.setHeader("X-TTS-Encoding", parsed.audioEncoding);
    res.setHeader("X-TTS-Voice-Type", voiceType);
    res.setHeader("X-TTS-Warnings", encodeURIComponent(warnings.join(" | ")));

    return res.status(200).end(audioBuf);
  } catch (e) {
    return res.status(400).json({ error: "TTS failed", details: String(e?.message || e) });
  }
});
