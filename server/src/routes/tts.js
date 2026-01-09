import express from "express";
import { z } from "zod";
import textToSpeech from "@google-cloud/text-to-speech";
import { config } from "../config.js";

export const ttsRouter = express.Router();

const ttsClient = new textToSpeech.TextToSpeechClient();

// ---- Voice caching (same idea as your existing code) ----
const VOICES_CACHE_TTL_SEC = 6 * 60 * 60;
const voicesCache = { atMs: 0, voices: [] };

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
    naturalSampleRateHertz: v.naturalSampleRateHertz || 24000,
    // Google uses "voiceType" only for some; keep what your UI expects
    voiceType: v.voiceType || "OTHER",
  }));

  voicesCache.atMs = now;
  voicesCache.voices = voices;
  return voices;
}

function uniqSorted(arr) {
  return [...new Set(arr)].sort();
}

// ---- Pricing (same approach as before) ----
function estimateCostUsd(voiceType, charCount) {
  // Keep your existing numbers if you had them; using your screenshot’s rate style.
  // Adjust these to your actual pricing table.
  // (This is only an estimate shown in UI.)
  const perMillion =
    voiceType === "CHIRP_HD" ? 16.0 :
    voiceType === "WAVENET" ? 16.0 :
    voiceType === "NEURAL2" ? 16.0 :
    voiceType === "STANDARD" ? 4.0 :
    4.0;

  return (perMillion / 1_000_000) * charCount;
}

function encodingToMime(enc) {
  if (enc === "MP3") return "audio/mpeg";
  if (enc === "OGG_OPUS") return "audio/ogg";
  if (enc === "LINEAR16") return "audio/wav";
  if (enc === "MULAW") return "audio/basic";
  return "application/octet-stream";
}

ttsRouter.get("/api/voices", async (req, res) => {
  try {
    const voices = await listVoicesCached();
    const languages = uniqSorted(voices.flatMap((v) => v.languageCodes || []));
    const voiceTypes = uniqSorted(voices.map((v) => v.voiceType || "OTHER"));

    res.json({
      voices,
      languages,
      voiceTypes,
      cache: {
        ttlSec: VOICES_CACHE_TTL_SEC,
        cachedAt: voicesCache.atMs ? new Date(voicesCache.atMs).toISOString() : null,
        count: voices.length,
      },
    });
  } catch (e) {
    console.error(e);
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
  const startedAt = process.hrtime.bigint();

  try {
    const parsed = SynthesizeSchema.parse(req.body);
    const voices = await listVoicesCached();
    const voice = voices.find((v) => v.name === parsed.voiceName);

    if (!voice) {
      return res.status(400).json({ error: "Unknown voiceName. Fetch /api/voices and pick one from the list." });
    }

    const voiceType = voice.voiceType;
    const warnings = [];

    let inputType = parsed.inputType;
    let speakingRate = parsed.speakingRate;
    let pitch = parsed.pitch;

    // Chirp limitations (kept like your previous logic)
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
    if (!audioContent) {
      return res.status(500).json({ error: "No audioContent returned by Google TTS." });
    }

    const audioBuf = Buffer.isBuffer(audioContent) ? audioContent : Buffer.from(audioContent);

    const ttsMs = Number(t1 - t0) / 1e6;
    const totalMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
    const estCostUsd = estimateCostUsd(voiceType, charCount);
    const mime = encodingToMime(parsed.audioEncoding);

    // ---- IMPORTANT: Binary response + metrics in headers ----
    res.setHeader("Content-Type", mime);
    res.setHeader("Content-Length", String(audioBuf.length));
    res.setHeader("Cache-Control", "no-store");

    // Expose headers for CORS
    res.setHeader("Access-Control-Expose-Headers", config.EXPOSE_HEADERS.join(", "));

    res.setHeader("X-TTS-Voice-Name", parsed.voiceName);
    res.setHeader("X-TTS-Voice-Type", voiceType);
    res.setHeader("X-TTS-Encoding", parsed.audioEncoding);
    res.setHeader("X-TTS-Mime", mime);
    res.setHeader("X-TTS-Char-Count", String(charCount));
    res.setHeader("X-TTS-Est-Cost-Usd", String(estCostUsd));
    res.setHeader("X-TTS-Tts-Ms", String(Math.round(ttsMs)));
    res.setHeader("X-TTS-Total-Ms", String(Math.round(totalMs)));
    res.setHeader("X-TTS-Warnings", encodeURIComponent(warnings.join(" | ")));

    return res.status(200).end(audioBuf);
  } catch (e) {
    console.error(e);
    return res.status(400).json({ error: "TTS failed", details: String(e?.message || e) });
  }
});
