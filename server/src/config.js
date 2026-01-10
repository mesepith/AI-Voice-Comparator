export const config = {
  PORT: Number(process.env.PORT || 7079),

  // Frontend origin for dev (vite on 7078). In prod same-origin, still fine.
  CORS_ORIGIN: process.env.CORS_ORIGIN || "http://127.0.0.1:7078",

  GROQ_API_KEY: process.env.GROQ_API_KEY || "",
  DEEPGRAM_API_KEY: process.env.DEEPGRAM_API_KEY || "",

  // ✅ Default LLM model (may be discontinued in future; we fallback safely)
  DEFAULT_LLM: (process.env.DEFAULT_LLM || "").trim(),

  // Optional defaults for TTS (not required, but useful later)
  DEFAULT_TTS_LANGUAGE: (process.env.DEFAULT_TTS_LANGUAGE || "").trim(),
  DEFAULT_TTS_VOICE_TYPE: (process.env.DEFAULT_TTS_VOICE_TYPE || "").trim(),
  DEFAULT_TTS_ENCODING: (process.env.DEFAULT_TTS_ENCODING || "").trim(),

  // Expose these so the browser can read them (CORS)
  EXPOSE_HEADERS: [
    "X-TTS-Voice-Name",
    "X-TTS-Voice-Type",
    "X-TTS-Encoding",
    "X-TTS-Mime",
    "X-TTS-Char-Count",
    "X-TTS-Est-Cost-Usd",
    "X-TTS-Tts-Ms",
    "X-TTS-Total-Ms",
    "X-TTS-Warnings",
  ],
};
