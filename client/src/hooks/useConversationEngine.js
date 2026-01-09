import { useCallback, useMemo, useRef, useState } from "react";
import {
  BARGE_IN_PROFILES,
  clampText,
  formatUsd,
  isAbortError,
  nowMs,
  nowPerfMs,
  rms16,
  wsUrl,
} from "../lib/utils";

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

export function useConversationEngine() {
  const audioOutRef = useRef(null);

  const wsRef = useRef(null);
  const streamRef = useRef(null);
  const audioCtxRef = useRef(null);
  const workletRef = useRef(null);
  const sourceRef = useRef(null);
  const muteGainRef = useRef(null);

  const llmAbortRef = useRef(null);
  const ttsAbortRef = useRef(null);

  const aiSpeakingRef = useRef(false);
  const audioUrlRef = useRef(null);

  // for DG utterance timing
  const utterRef = useRef({
    active: false,
    startedAt: null,
    firstResultAt: null,
    textFinalParts: [],
    lastFinalAt: null,
  });

  const gateRef = useRef({
    floor: 0,
    isSpeech: false,
    onsetFrames: 0,
    lastSpeechAt: 0,
  });

  const aggRef = useRef({
    buf: new Int16Array(320), // 20ms @16k
    off: 0,
  });

  const preRollRef = useRef([]);

  const runningCfgRef = useRef(null);

  const [isRunning, setIsRunning] = useState(false);
  const [error, setError] = useState("");

  const [stats, setStats] = useState({
    audio_seconds: 0,
    est_cost_usd: 0,
    price_per_min_usd: 0.0052,
    dg_request_id: null,
    dg_ttfb_ms: null,
    overall_ttfb_ms: null,
  });

  const [messages, setMessages] = useState([]); // full log (oldest -> newest)
  const last4 = useMemo(() => messages.slice(-4), [messages]);

  const [session, setSession] = useState(null);

  // Push-to-talk state
  const [pttActive, _setPttActive] = useState(false);
  const pttActiveRef = useRef(false);

  const setPttActive = useCallback((v) => {
    const on = Boolean(v);
    pttActiveRef.current = on;
    _setPttActive(on);

    // If user starts PTT while AI speaking, stop immediately
    if (on && aiSpeakingRef.current) {
      stopAudioOutput("ptt");
    }

    // Start utter timing when user begins PTT
    if (on) startNewUtteranceIfNeeded();
  }, []);

  function pushMessage(msg) {
    setMessages((prev) => [...prev, msg]);
  }

  function resetRuntimeState() {
    setError("");
    setStats({
      audio_seconds: 0,
      est_cost_usd: 0,
      price_per_min_usd: 0.0052,
      dg_request_id: null,
      dg_ttfb_ms: null,
      overall_ttfb_ms: null,
    });
    setMessages([]);
    setSession(null);

    aiSpeakingRef.current = false;

    utterRef.current = {
      active: false,
      startedAt: null,
      firstResultAt: null,
      textFinalParts: [],
      lastFinalAt: null,
    };

    gateRef.current = { floor: 0, isSpeech: false, onsetFrames: 0, lastSpeechAt: 0 };
    aggRef.current = { buf: new Int16Array(320), off: 0 };
    preRollRef.current = [];

    pttActiveRef.current = false;
    _setPttActive(false);
  }

  function stopAudioOutput() {
    const a = audioOutRef.current;
    if (a) {
      try { a.pause(); a.currentTime = 0; } catch {}
    }

    // abort in-flight LLM/TTS so the assistant turn stops
    try { llmAbortRef.current?.abort(); } catch {}
    try { ttsAbortRef.current?.abort(); } catch {}
    llmAbortRef.current = null;
    ttsAbortRef.current = null;

    aiSpeakingRef.current = false;

    // free blob URL
    try {
      if (audioUrlRef.current) URL.revokeObjectURL(audioUrlRef.current);
    } catch {}
    audioUrlRef.current = null;

    // reset gate state so it doesn’t “stick”
    gateRef.current.isSpeech = false;
    gateRef.current.onsetFrames = 0;
    preRollRef.current.length = 0;
  }

  function stopEverything() {
    // Stop assistant output & pending requests
    stopAudioOutput();

    // Close WS
    try {
      const ws = wsRef.current;
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "CloseStream" }));
        ws.close();
      }
    } catch {}
    wsRef.current = null;

    // Stop mic
    try { workletRef.current?.disconnect(); } catch {}
    try { sourceRef.current?.disconnect(); } catch {}
    try { muteGainRef.current?.disconnect(); } catch {}

    workletRef.current = null;
    sourceRef.current = null;
    muteGainRef.current = null;

    try { streamRef.current?.getTracks()?.forEach((t) => t.stop()); } catch {}
    streamRef.current = null;

    try { audioCtxRef.current?.close(); } catch {}
    audioCtxRef.current = null;

    utterRef.current = { active: false, startedAt: null, firstResultAt: null, textFinalParts: [], lastFinalAt: null };
  }

  function startNewUtteranceIfNeeded() {
    if (utterRef.current.active) return;
    utterRef.current.active = true;
    utterRef.current.startedAt = nowMs();
    utterRef.current.firstResultAt = null;
    utterRef.current.textFinalParts = [];
    utterRef.current.lastFinalAt = null;
  }

  function endUtterance() {
    utterRef.current.active = false;
  }

  async function connectWs({ sttModel, sttLanguage }) {
    const ws = new WebSocket(
      wsUrl(`/ws?model=${encodeURIComponent(sttModel)}&language=${encodeURIComponent(sttLanguage)}`)
    );
    wsRef.current = ws;

    ws.onmessage = async (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }

      if (msg.type === "stats") {
        setStats((prev) => ({ ...prev, ...msg }));
        return;
      }

      if (msg.type === "dg_open") {
        setStats((prev) => ({ ...prev, dg_request_id: msg.dg_request_id || prev.dg_request_id }));
        return;
      }

      if (msg.type === "proxy_error") {
        setError(`Error: ${msg.message || "Deepgram error"}${msg.dg_error ? " | " + msg.dg_error : ""}`);
        return;
      }

      if (msg.type === "transcript") {
        const text = String(msg.text || "").trim();
        if (!text) return;

        // first token timing
        if (!utterRef.current.firstResultAt) {
          utterRef.current.firstResultAt = nowMs();
        }

        if (msg.is_final) {
          utterRef.current.textFinalParts.push(text);
          utterRef.current.lastFinalAt = nowMs();
        }

        if (msg.speech_final) {
          const full = utterRef.current.textFinalParts.join(" ").trim();
          const startedAt = utterRef.current.startedAt ?? nowMs();
          const firstAt = utterRef.current.firstResultAt ?? null;
          const finishedAt = nowMs();

          const sttMetrics = {
            clientMs: finishedAt - startedAt,
            firstResultMs: firstAt ? firstAt - startedAt : null,
          };

          endUtterance();

          // push user message in log
          pushMessage({
            id: crypto.randomUUID(),
            role: "user",
            text: full,
            createdAtMs: Date.now(),
            metrics: { stt: sttMetrics },
          });

          // run assistant
          try {
            await runAssistantTurn({ userText: full, sttMetrics, isKickoff: false });
          } catch (e) {
            if (!isAbortError(e)) setError(String(e?.message || e));
          }
        }
      }
    };

    ws.onerror = () => {
      setError("WebSocket error. Check Apache WS proxy and backend logs.");
    };

    return new Promise((resolve, reject) => {
      ws.onopen = () => resolve();
      ws.onclose = () => reject(new Error("WS closed before open"));
    });
  }

  async function startAudioPipeline() {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
    streamRef.current = stream;

    const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    audioCtxRef.current = audioCtx;

    await audioCtx.audioWorklet.addModule(new URL("../audio/pcm16-worklet.js", import.meta.url));

    const source = audioCtx.createMediaStreamSource(stream);
    sourceRef.current = source;

    const worklet = new AudioWorkletNode(audioCtx, "pcm16-worklet", {
      processorOptions: { targetSampleRate: 16000 },
    });
    workletRef.current = worklet;

    const mute = audioCtx.createGain();
    mute.gain.value = 0;
    muteGainRef.current = mute;

    source.connect(worklet);
    worklet.connect(mute);
    mute.connect(audioCtx.destination);

    worklet.port.onmessage = (e) => {
      const ws = wsRef.current;
      if (!ws || ws.readyState !== WebSocket.OPEN) return;

      // Backpressure drop (latency first)
      if (ws.bufferedAmount > 1_500_000) return;

      const in16 = new Int16Array(e.data);
      let { buf, off } = aggRef.current;

      const cfg = runningCfgRef.current;
      if (!cfg) return;

      const mode = cfg.bargeInMode;
      const profile = BARGE_IN_PROFILES[mode] || BARGE_IN_PROFILES.strict;

      let i = 0;
      while (i < in16.length) {
        const take = Math.min(buf.length - off, in16.length - i);
        buf.set(in16.subarray(i, i + take), off);
        off += take;
        i += take;

        if (off === buf.length) {
          const frame = buf.slice(0);
          const frameAb = frame.buffer;

          // PTT mode: ONLY send when PTT is pressed.
          if (mode === "push_to_talk") {
            if (pttActiveRef.current) ws.send(frameAb);
            off = 0;
            continue;
          }

          // ---- Auto barge-in VAD (STRICTER to avoid background) ----
          const rms = rms16(frame);
          const s = gateRef.current;
          const t = nowPerfMs();

          // update floor when AI speaking and we are NOT in confirmed speech
          if (aiSpeakingRef.current && !s.isSpeech) {
            s.floor = s.floor === 0 ? rms : (0.97 * s.floor + 0.03 * rms);
          }

          const ON = Math.max(profile.absOn, s.floor * profile.multOn);
          const OFF = Math.max(profile.absOff, s.floor * profile.multOff);
          const HANG_MS = profile.hangMs;

          // Confirm speech only after sustained frames >= minOnFrames
          if (!s.isSpeech) {
            if (rms >= ON) s.onsetFrames += 1;
            else s.onsetFrames = 0;

            if (s.onsetFrames >= profile.minOnFrames) {
              s.isSpeech = true;
              s.lastSpeechAt = t;
              s.onsetFrames = 0;

              startNewUtteranceIfNeeded();

              // ONLY stop TTS when we have confirmed speech
              if (aiSpeakingRef.current) {
                stopAudioOutput();

                // flush pre-roll so we don’t lose first syllable
                for (const pr of preRollRef.current) ws.send(pr);
                preRollRef.current.length = 0;
              }
            }
          } else {
            if (rms >= OFF) s.lastSpeechAt = t;
            if (t - s.lastSpeechAt > HANG_MS) s.isSpeech = false;
          }

          // Gate: while AI speaking and user NOT speaking => don’t send to DG (pre-roll only)
          if (aiSpeakingRef.current && !s.isSpeech) {
            preRollRef.current.push(frameAb);
            if (preRollRef.current.length > profile.preRollFrames) preRollRef.current.shift();
          } else {
            ws.send(frameAb);
          }

          off = 0;
        }
      }

      aggRef.current.off = off;
    };
  }

  async function runAssistantTurn({ userText, sttMetrics, isKickoff }) {
    setError("");

    const cfg = runningCfgRef.current;
    if (!cfg) return;

    const turnId = crypto.randomUUID();

    // Build chat history (system + last 10 turns)
    const history = (isKickoff ? [] : messages)
      .slice(-10)
      .map((m) => ({ role: m.role, content: m.text }));

    const llmMessages = [
      { role: "system", content: cfg.systemPrompt },
      ...history,
      { role: "user", content: clampText(userText, 5000) },
    ];

    // ---- LLM ----
    const llmAbort = new AbortController();
    llmAbortRef.current = llmAbort;

    const llmT0 = nowMs();
    let llmRes;
    try {
      llmRes = await fetch("/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        signal: llmAbort.signal,
        body: JSON.stringify({ model: cfg.model, messages: llmMessages, temperature: 0.4 }),
      });
    } catch (e) {
      if (isAbortError(e)) return;
      throw e;
    }

    const llmT1 = nowMs();
    const llmData = await llmRes.json();
    if (!llmRes.ok) throw new Error(llmData?.details || llmData?.error || "LLM failed");

    const assistantText = String(llmData?.text || "").trim();
    const llmMetrics = {
      clientMs: llmT1 - llmT0,
      serverWallMs: llmData?.wallTimeMs ?? null,
      requestId: llmData?.requestId ?? null,
      usage: llmData?.usage ?? null,
    };

    // ---- TTS (BINARY) ----
    const ttsAbort = new AbortController();
    ttsAbortRef.current = ttsAbort;

    const ttsPayload = {
      inputType: cfg.inputType,
      text: assistantText || "(empty response)",
      voiceName: cfg.voiceName,
      languageCode: cfg.language,
      audioEncoding: cfg.audioEncoding, // recommend OGG_OPUS for lower payload
      volumeGainDb: Number(cfg.volumeGainDb),
      ...(cfg.isChirp ? {} : { speakingRate: Number(cfg.speakingRate), pitch: Number(cfg.pitch) }),
    };

    const ttsT0 = nowMs();
    let ttsRes;
    try {
      ttsRes = await fetch("/api/synthesize", {
        method: "POST",
        headers: { "content-type": "application/json" },
        signal: ttsAbort.signal,
        body: JSON.stringify(ttsPayload),
      });
    } catch (e) {
      if (isAbortError(e)) return;
      throw e;
    }

    // If server returns error JSON, show it
    const ct = ttsRes.headers.get("content-type") || "";
    if (!ttsRes.ok || !ct.startsWith("audio/")) {
      const errJson = await ttsRes.json().catch(() => ({}));
      throw new Error(errJson?.details || errJson?.error || "TTS failed");
    }

    const audioBuf = await ttsRes.arrayBuffer();
    const ttsT1 = nowMs();

    const serverTtsMs = Number(ttsRes.headers.get("x-tts-tts-ms")) || null;
    const serverTotalMs = Number(ttsRes.headers.get("x-tts-total-ms")) || null;
    const charCount = Number(ttsRes.headers.get("x-tts-char-count")) || null;
    const estCostUsd = Number(ttsRes.headers.get("x-tts-est-cost-usd")) || null;
    const warnings = decodeWarningsHeader(ttsRes.headers);

    const ttsMetrics = {
      clientMs: ttsT1 - ttsT0,       // includes network + download
      serverTtsMs,
      serverTotalMs,
      charCount,
      estCostUsd,
      encoding: ttsRes.headers.get("x-tts-encoding") || cfg.audioEncoding,
      warnings,
    };

    // Play audio
    const a = audioOutRef.current;
    if (a) {
      // free previous URL
      try {
        if (audioUrlRef.current) URL.revokeObjectURL(audioUrlRef.current);
      } catch {}

      const blob = new Blob([audioBuf], { type: ct });
      const url = URL.createObjectURL(blob);
      audioUrlRef.current = url;

      a.src = url;

      aiSpeakingRef.current = true;

      try {
        await a.play();
      } catch (e) {
        aiSpeakingRef.current = false;
        throw e;
      }

      // wait until it ends (or gets paused by barge-in/stop)
      await new Promise((resolve) => {
        const done = () => {
          a.removeEventListener("ended", done);
          a.removeEventListener("pause", done);
          resolve();
        };
        a.addEventListener("ended", done);
        a.addEventListener("pause", done);
      });

      aiSpeakingRef.current = false;
    }

    // Log assistant message + timings
    pushMessage({
      id: turnId,
      role: "assistant",
      text: assistantText,
      createdAtMs: Date.now(),
      metrics: {
        stt: sttMetrics || null,
        llm: llmMetrics,
        tts: ttsMetrics,
        combinedMs:
          (sttMetrics?.clientMs ?? 0) +
          (llmMetrics?.clientMs ?? 0) +
          (ttsMetrics?.clientMs ?? 0),
      },
    });
  }

  const start = useCallback(async (cfg) => {
    resetRuntimeState();
    runningCfgRef.current = cfg;

    setSession({
      id: crypto.randomUUID(),
      startedAtIso: new Date().toISOString(),
      sttLabel: `Deepgram ${cfg.sttModel} (${cfg.sttLanguage})`,
      llmLabel: cfg.model,
      ttsLabel: cfg.voiceName,
      dg_request_id: null,
    });

    setIsRunning(true);
    setError("");

    try {
      await connectWs({ sttModel: cfg.sttModel, sttLanguage: cfg.sttLanguage });
      await startAudioPipeline();

      // Kickoff assistant message immediately
      await runAssistantTurn({ userText: cfg.kickoffUserText || "Start the conversation.", sttMetrics: null, isKickoff: true });
    } catch (e) {
      setError(String(e?.message || e));
    }
  }, []);

  const stop = useCallback(() => {
    stopEverything();
    setIsRunning(false);

    setSession((s) => {
      if (!s) return s;
      return {
        ...s,
        dg_request_id: stats.dg_request_id || s.dg_request_id,
        audio_seconds: stats.audio_seconds,
        stt_est_cost_usd: stats.est_cost_usd,
        dg_ttfb_ms: stats.dg_ttfb_ms,
        overall_ttfb_ms: stats.overall_ttfb_ms,
      };
    });
  }, [stats]);

  const buildSummaryRows = useCallback(() => {
    const s = session;
    const cfg = runningCfgRef.current;

    return {
      sessionId: s?.id || "-",
      started: s?.startedAtIso || "-",
      stt: cfg ? `Deepgram ${cfg.sttModel} (${cfg.sttLanguage})` : "-",
      llm: cfg?.model || "-",
      tts: cfg ? `${cfg.voiceName} (${cfg.audioEncoding})` : "-",
      dg_request_id: stats.dg_request_id || "-",
      audio_seconds: `${Number(stats.audio_seconds || 0).toFixed(2)} s`,
      stt_est_cost: `${formatUsd(stats.est_cost_usd)} (price/min $${Number(stats.price_per_min_usd || 0).toFixed(6)})`,
      dg_ttfb: stats.dg_ttfb_ms != null ? `${stats.dg_ttfb_ms} ms` : "-",
      overall_ttfb: stats.overall_ttfb_ms != null ? `${stats.overall_ttfb_ms} ms` : "-",
    };
  }, [session, stats]);

  return {
    audioOutRef,
    isRunning,
    error,
    stats,
    messages,
    last4,
    session,
    start,
    stop,
    buildSummaryRows,

    // PTT
    pttActive,
    setPttActive,
  };
}
