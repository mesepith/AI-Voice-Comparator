function decodeWarningsHeader(h) {
  try {
    const v = h?.get("x-tts-warnings");
    if (!v) return [];
    const decoded = decodeURIComponent(v);
    return decoded ? decoded.split(" | ").filter(Boolean) : [];
  } catch {
    return [];
  }
}

export function createTtsAggregator(encoding) {
  return {
    encoding,
    chunkCount: 0,

    // first chunk (time-to-first-audio)
    firstServerMs: null,
    firstDownloadMs: null,

    // totals across all chunks
    totalServerMs: 0,
    totalDownloadMs: 0,
    totalChars: 0,
    totalCostUsd: 0,

    warnings: new Set(),
  };
}

export async function synthesizeChunkBinary({ text, cfg, abortSet, ttsAgg }) {
  const controller = new AbortController();
  abortSet.add(controller);

  const t0 = performance.now();

  const payload = {
    inputType: cfg.inputType,
    text,
    voiceName: cfg.voiceName,
    languageCode: cfg.language,
    audioEncoding: cfg.audioEncoding,
    volumeGainDb: Number(cfg.volumeGainDb),
    ...(cfg.isChirp ? {} : { speakingRate: Number(cfg.speakingRate), pitch: Number(cfg.pitch) }),
  };

  const res = await fetch("/api/synthesize", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
    signal: controller.signal,
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    abortSet.delete(controller);
    throw new Error(err?.details || err?.error || "TTS failed");
  }

  const ct = res.headers.get("content-type") || "audio/ogg";
  const ab = await res.arrayBuffer();
  const t1 = performance.now();

  abortSet.delete(controller);

  const downloadMs = Math.round(t1 - t0);
  const serverTtsMs = Number(res.headers.get("x-tts-tts-ms")) || null;
  const charCount = Number(res.headers.get("x-tts-char-count")) || null;
  const estCostUsd = Number(res.headers.get("x-tts-est-cost-usd")) || null;
  const encoding = res.headers.get("x-tts-encoding") || cfg.audioEncoding;
  const warnings = decodeWarningsHeader(res.headers);

  // ---- aggregate ----
  ttsAgg.chunkCount += 1;
  if (ttsAgg.firstServerMs == null) ttsAgg.firstServerMs = serverTtsMs;
  if (ttsAgg.firstDownloadMs == null) ttsAgg.firstDownloadMs = downloadMs;

  if (serverTtsMs != null) ttsAgg.totalServerMs += serverTtsMs;
  ttsAgg.totalDownloadMs += downloadMs;

  if (charCount != null) ttsAgg.totalChars += charCount;
  if (estCostUsd != null) ttsAgg.totalCostUsd += estCostUsd;

  for (const w of warnings) ttsAgg.warnings.add(w);

  // ---- binary blob ----
  const blob = new Blob([ab], { type: ct });
  const url = URL.createObjectURL(blob);

  return {
    url,
    mime: ct,
    metrics: {
      // per chunk metrics (useful debugging)
      downloadMs,
      serverTtsMs,
      charCount,
      estCostUsd,
      encoding,
      warnings,
    },
  };
}
