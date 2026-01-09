export const config = {
  PORT: Number(process.env.PORT || 7079),

  // Frontend origin for dev (vite on 7078). In prod same-origin, still fine.
  CORS_ORIGIN: process.env.CORS_ORIGIN || "http://127.0.0.1:7078",

  GROQ_API_KEY: process.env.GROQ_API_KEY || "",
  DEEPGRAM_API_KEY: process.env.DEEPGRAM_API_KEY || "",

  // Google TTS uses ADC (GOOGLE_APPLICATION_CREDENTIALS) or workload identity
  // No key needed here if ADC is configured.

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
