export function wsUrl(pathAndQuery) {
  const proto = window.location.protocol === "https:" ? "wss" : "ws";
  return `${proto}://${window.location.host}${pathAndQuery}`;
}

export function clampText(s, max) {
  const str = String(s ?? "");
  return str.length > max ? str.slice(0, max) : str;
}

export function nowPerfMs() {
  return performance.now();
}

export function nowMs() {
  return Date.now();
}

export function isAbortError(e) {
  return e?.name === "AbortError";
}

export function rms16(int16) {
  // returns 0..~1
  let sum = 0;
  for (let i = 0; i < int16.length; i++) {
    const v = int16[i] / 32768;
    sum += v * v;
  }
  return Math.sqrt(sum / Math.max(1, int16.length));
}

export function voiceTypePretty(t) {
  if (t === "CHIRP_HD") return "Chirp 3: HD";
  if (t === "WAVENET") return "WaveNet";
  if (t === "NEURAL2") return "Neural2";
  if (t === "STUDIO") return "Studio";
  if (t === "STANDARD") return "Standard";
  if (t === "POLYGLOT") return "Polyglot";
  return t || "Other";
}

export function formatUsd(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return "-";
  if (x === 0) return "$0";
  if (x < 0.0001) return `$${x.toExponential(2)}`;
  return `$${x.toFixed(6)}`;
}

// IMPORTANT: stricter VAD profiles to avoid background interruptions.
// Strict is default (best for AirPods + background noise).
export const BARGE_IN_PROFILES = {
  strict: {
    label: "Strict (ignore background best)",
    absOn: 0.06,
    absOff: 0.045,
    multOn: 7.0,
    multOff: 4.0,
    minOnFrames: 8,      // 8 * 20ms = 160ms sustained
    hangMs: 280,
    preRollFrames: 14,   // ~280ms
  },
  balanced: {
    label: "Balanced",
    absOn: 0.045,
    absOff: 0.03,
    multOn: 5.5,
    multOff: 3.5,
    minOnFrames: 6,
    hangMs: 250,
    preRollFrames: 14,
  },
  fast: {
    label: "Fast (lowest latency, more false barge-in)",
    absOn: 0.035,
    absOff: 0.025,
    multOn: 4.5,
    multOff: 3.0,
    minOnFrames: 4,
    hangMs: 220,
    preRollFrames: 12,
  },
  push_to_talk: {
    label: "Push-to-Talk (guaranteed in noisy place)",
  },
};
