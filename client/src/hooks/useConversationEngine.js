import { useCallback, useMemo, useRef, useState } from "react";
import {
  BARGE_IN_PROFILES,
  clampText,
  formatUsd,
  isAbortError,
  nowPerfMs,
  rms16,
  wsUrl,
} from "../lib/utils";

import { readSSE } from "../engine/sse";
import { extractSpeakChunk } from "../engine/chunker";
import { createOrderedAudioQueue } from "../engine/audioQueue";
import { createTtsAggregator, synthesizeChunkBinary } from "../engine/tts";

export function useConversationEngine() {
  // Audio output element (mounted in App.jsx)
  const audioOutRef = useRef(null);

  // Abort controllers
  const llmStreamAbortRef = useRef(null);
  const ttsAbortSetRef = useRef(new Set());

  // Mic/STT
  const wsRef = useRef(null);
  const streamRef = useRef(null);
  const audioCtxRef = useRef(null);
  const workletRef = useRef(null);
  const sourceRef = useRef(null);
  const muteGainRef = useRef(null);

  // STT utterance timing
  const utterRef = useRef({
    active: false,
    startedAt: null,
    firstResultAt: null,
    textFinalParts: [],
  });

  // Barge-in gate
  const aiSpeakingRef = useRef(false);
  const gateRef = useRef({
    floor: 0,
    isSpeech: false,
    onsetFrames: 0,
    lastSpeechAt: 0,
  });
  const aggRef = useRef({ buf: new Int16Array(320), off: 0 });
  const preRollRef = useRef([]);

  // PTT
  const [pttActive, _setPttActive] = useState(false);
  const pttActiveRef = useRef(false);

  const setPttActive = useCallback((v) => {
    const on = Boolean(v);
    pttActiveRef.current = on;
    _setPttActive(on);

    if (on && aiSpeakingRef.current) stopAudioOutput();
    if (on) startNewUtteranceIfNeeded();
  }, []);

  // UI state
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

  const [messages, setMessages] = useState([]);
  const last4 = useMemo(() => messages.slice(-4), [messages]);

  const runningCfgRef = useRef(null);

  // Ordered audio queue
  const audioQueueRef = useRef(null);
  if (!audioQueueRef.current) {
    audioQueueRef.current = createOrderedAudioQueue({ audioOutRef, setError });
  }

  function pushMessage(msg) {
    setMessages((prev) => [...prev, msg]);
  }

  function patchMessage(id, patch) {
    setMessages((prev) => prev.map((m) => (m.id === id ? { ...m, ...patch } : m)));
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

    utterRef.current = { active: false, startedAt: null, firstResultAt: null, textFinalParts: [] };

    gateRef.current = { floor: 0, isSpeech: false, onsetFrames: 0, lastSpeechAt: 0 };
    aggRef.current = { buf: new Int16Array(320), off: 0 };
    preRollRef.current = [];

    audioQueueRef.current.reset();

    pttActiveRef.current = false;
    _setPttActive(false);
  }

  function stopAudioOutput() {
    // stop audio playback + clear queued urls
    audioQueueRef.current.reset();
    aiSpeakingRef.current = false;

    // abort LLM stream
    try { llmStreamAbortRef.current?.abort(); } catch {}
    llmStreamAbortRef.current = null;

    // abort all TTS inflight
    for (const c of ttsAbortSetRef.current) {
      try { c.abort(); } catch {}
    }
    ttsAbortSetRef.current.clear();

    gateRef.current.isSpeech = false;
    gateRef.current.onsetFrames = 0;
    preRollRef.current.length = 0;
  }

  function stopEverything() {
    stopAudioOutput();

    // Close STT WS
    try {
      const ws = wsRef.current;
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "CloseStream" }));
        ws.close();
      }
    } catch {}
    wsRef.current = null;

    // Stop mic pipeline
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

    utterRef.current = { active: false, startedAt: null, firstResultAt: null, textFinalParts: [] };
  }

  function startNewUtteranceIfNeeded() {
    if (utterRef.current.active) return;
    utterRef.current.active = true;
    utterRef.current.startedAt = performance.now();
    utterRef.current.firstResultAt = null;
    utterRef.current.textFinalParts = [];
  }

  function endUtterance() {
    utterRef.current.active = false;
  }

  async function connectWs({ sttModel, sttLanguage }) {
    const ws = new WebSocket(wsUrl(`/ws?model=${encodeURIComponent(sttModel)}&language=${encodeURIComponent(sttLanguage)}`));
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

        if (!utterRef.current.firstResultAt) utterRef.current.firstResultAt = performance.now();
        if (msg.is_final) utterRef.current.textFinalParts.push(text);

        if (msg.speech_final) {
          const full = utterRef.current.textFinalParts.join(" ").trim();
          const startedAt = utterRef.current.startedAt ?? performance.now();
          const firstAt = utterRef.current.firstResultAt ?? null;
          const finishedAt = performance.now();

          endUtterance();

          const sttMetrics = {
            clientMs: Math.round(finishedAt - startedAt),
            firstResultMs: firstAt ? Math.round(firstAt - startedAt) : null,
          };

          pushMessage({
            id: crypto.randomUUID(),
            role: "user",
            text: full,
            createdAtMs: Date.now(),
            metrics: { stt: sttMetrics },
          });

          try {
            await runAssistantTurnStreamed({ userText: full, sttMetrics });
          } catch (e) {
            if (!isAbortError(e)) setError(String(e?.message || e));
          }
        }
      }
    };

    ws.onerror = () => setError("WebSocket error. Check backend logs.");

    return new Promise((resolve, reject) => {
      ws.onopen = () => resolve();
      ws.onclose = () => reject(new Error("WS closed before open"));
    });
  }

  async function startAudioPipeline() {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
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
      if (ws.bufferedAmount > 1_500_000) return;

      const cfg = runningCfgRef.current;
      if (!cfg) return;

      const mode = cfg.bargeInMode;
      const profile = BARGE_IN_PROFILES[mode] || BARGE_IN_PROFILES.strict;

      const in16 = new Int16Array(e.data);
      let { buf, off } = aggRef.current;

      let i = 0;
      while (i < in16.length) {
        const take = Math.min(buf.length - off, in16.length - i);
        buf.set(in16.subarray(i, i + take), off);
        off += take;
        i += take;

        if (off === buf.length) {
          const frame = buf.slice(0);
          const frameAb = frame.buffer;

          // Push-to-talk
          if (mode === "push_to_talk") {
            if (pttActiveRef.current) ws.send(frameAb);
            off = 0;
            continue;
          }

          const rms = rms16(frame);
          const s = gateRef.current;
          const t = nowPerfMs();

          if (aiSpeakingRef.current && !s.isSpeech) {
            s.floor = s.floor === 0 ? rms : (0.97 * s.floor + 0.03 * rms);
          }

          const ON = Math.max(profile.absOn, s.floor * profile.multOn);
          const OFF = Math.max(profile.absOff, s.floor * profile.multOff);

          if (!s.isSpeech) {
            s.onsetFrames = rms >= ON ? s.onsetFrames + 1 : 0;

            if (s.onsetFrames >= profile.minOnFrames) {
              s.isSpeech = true;
              s.lastSpeechAt = t;
              s.onsetFrames = 0;

              startNewUtteranceIfNeeded();

              if (aiSpeakingRef.current) {
                stopAudioOutput();
                for (const pr of preRollRef.current) ws.send(pr);
                preRollRef.current.length = 0;
              }
            }
          } else {
            if (rms >= OFF) s.lastSpeechAt = t;
            if (t - s.lastSpeechAt > profile.hangMs) s.isSpeech = false;
          }

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

  async function runAssistantTurnStreamed({ userText, sttMetrics }) {
    setError("");
    const cfg = runningCfgRef.current;
    if (!cfg) return;

    // audio element must exist
    const a = audioOutRef.current;
    if (!a) {
      setError("Audio element not ready. Reload page and try again.");
      return;
    }
    a.preload = "auto";
    a.muted = false;

    // mark speaking while audio playing
    aiSpeakingRef.current = false;

    // LLM messages: system + last 10 + user
    const history = messages.slice(-10).map((m) => ({ role: m.role, content: m.text }));
    const llmMessages = [
      { role: "system", content: cfg.systemPrompt },
      ...history,
      { role: "user", content: clampText(userText, 5000) },
    ];

    const assistantMsgId = crypto.randomUUID();
    pushMessage({
      id: assistantMsgId,
      role: "assistant",
      text: "",
      createdAtMs: Date.now(),
      metrics: { stt: sttMetrics || null, llm: null, tts: null, combined: null },
    });

    // reset audio queue for this turn
    audioQueueRef.current.reset();
    aiSpeakingRef.current = false;

    // aggregated TTS metrics across chunks
    const ttsAgg = createTtsAggregator(cfg.audioEncoding);

    const llmAbort = new AbortController();
    llmStreamAbortRef.current = llmAbort;

    const llmStart = performance.now();
    let llmTTFT = null;
    let llmDone = false;
    let llmTotal = null;
    let llmRequestId = null; // may stay null

    let fullText = "";
    let buffer = "";
    let lastUiUpdate = 0;

    const MAX_TTS_IN_FLIGHT = 2;
    let inFlight = 0;
    let seqCounter = 0;

    // pending text chunks {seq, text}
    const pendingTextChunks = [];

    const kickTtsPump = async () => {
      while (inFlight < MAX_TTS_IN_FLIGHT && pendingTextChunks.length > 0) {
        const { seq, text } = pendingTextChunks.shift();
        inFlight += 1;

        (async () => {
          try {
            const tts = await synthesizeChunkBinary({
              text,
              cfg,
              abortSet: ttsAbortSetRef.current,
              ttsAgg,
            });

            const item = {
              seq,
              url: tts.url,
              mime: tts.mime,
              metrics: tts.metrics,
            };

            // when first chunk is available, AI starts speaking soon
            aiSpeakingRef.current = true;
            await audioQueueRef.current.onItemCompleted(item);
          } catch (e) {
            if (!isAbortError(e)) setError(String(e?.message || e));
          } finally {
            inFlight -= 1;
            kickTtsPump();
          }
        })();
      }
    };

    const res = await fetch("/api/chat/stream", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "accept": "text/event-stream",
      },
      cache: "no-store",
      body: JSON.stringify({ model: cfg.model, messages: llmMessages, temperature: 0.4 }),
      signal: llmAbort.signal,
    });

    if (!res.ok) {
      const err = await res.text().catch(() => "");
      throw new Error(`LLM stream failed (${res.status}): ${err}`);
    }

    await readSSE(res, (event, data) => {
      if (event === "meta") {
        // If server emits request_id later, capture it
        if (data?.request_id) llmRequestId = data.request_id;
        return;
      }

      if (event === "delta") {
        const d = String(data?.text || "");
        if (!d) return;

        if (llmTTFT == null) llmTTFT = Math.round(performance.now() - llmStart);

        fullText += d;
        buffer += d;

        const now = performance.now();
        if (now - lastUiUpdate > 80) {
          lastUiUpdate = now;
          patchMessage(assistantMsgId, { text: fullText });
        }

        while (true) {
          const { chunk, rest } = extractSpeakChunk(buffer);
          if (!chunk) break;

          buffer = rest;
          const seq = seqCounter++;
          pendingTextChunks.push({ seq, text: chunk });
          kickTtsPump();
        }
      }

      if (event === "done") {
        llmDone = true;
        llmTotal = Math.round(performance.now() - llmStart);
      }

      if (event === "error") {
        setError(`LLM stream error: ${data?.details || data?.message || "Unknown"}`);
        llmDone = true;
        llmTotal = Math.round(performance.now() - llmStart);
      }
    });

    // flush leftover buffer after stream ends
    const leftover = buffer.trim();
    if (leftover) {
      pendingTextChunks.push({ seq: seqCounter++, text: leftover });
      kickTtsPump();
    }

    // wait until everything is synthesized & played
    const waitUntilIdle = async () => {
      for (let i = 0; i < 600; i++) {
        if (!llmStreamAbortRef.current) break;

        const qState = audioQueueRef.current.getState();
        const donePlaying = !qState.isPlaying && qState.queued === 0 && qState.waiting === 0;

        if (llmDone && inFlight === 0 && pendingTextChunks.length === 0 && donePlaying) return;
        await new Promise((r) => setTimeout(r, 50));
      }
    };
    await waitUntilIdle();

    patchMessage(assistantMsgId, { text: fullText });

    // ✅ Fill metrics for Logs page (no more blanks)
    const combinedToFirstAudioMs =
      (sttMetrics?.clientMs ?? 0) +
      (llmTTFT ?? 0) +
      (ttsAgg.firstDownloadMs ?? 0);

    const combinedPipelineTotalMs =
      (sttMetrics?.clientMs ?? 0) +
      (llmTotal ?? 0) +
      (ttsAgg.totalDownloadMs ?? 0);

    patchMessage(assistantMsgId, {
      metrics: {
        stt: sttMetrics || null,

        llm: {
          ttftMs: llmTTFT,
          clientMs: llmTotal,
          requestId: llmRequestId, // may be null
        },

        // For compatibility with your current TalkPage + LogsPage:
        tts: {
          // TalkPage expects these:
          serverTtsMs: ttsAgg.firstServerMs,
          clientMs: ttsAgg.firstDownloadMs,

          // LogsPage expects these:
          encoding: ttsAgg.encoding,
          charCount: ttsAgg.totalChars,
          estCostUsd: ttsAgg.totalCostUsd,
          warnings: Array.from(ttsAgg.warnings),

          // Extra useful totals:
          firstServerMs: ttsAgg.firstServerMs,
          firstDownloadMs: ttsAgg.firstDownloadMs,
          totalServerMs: ttsAgg.totalServerMs,
          totalDownloadMs: ttsAgg.totalDownloadMs,
          chunkCount: ttsAgg.chunkCount,
        },

        // LogsPage currently looks for combinedMs – we’ll set it to “time to first audio”
        combinedMs: Math.round(combinedToFirstAudioMs),

        // Extra (if you want later in UI):
        combined: {
          toFirstAudioMs: Math.round(combinedToFirstAudioMs),
          pipelineTotalMs: Math.round(combinedPipelineTotalMs),
        },
      },
    });

    // done
    llmStreamAbortRef.current = null;
    aiSpeakingRef.current = false;
  }

  const start = useCallback(async (cfg) => {
    resetRuntimeState();
    runningCfgRef.current = cfg;

    setIsRunning(true);
    setError("");

    try {
      await connectWs({ sttModel: cfg.sttModel, sttLanguage: cfg.sttLanguage });
      await startAudioPipeline();

      await runAssistantTurnStreamed({
        userText: cfg.kickoffUserText || "Start the conversation.",
        sttMetrics: null,
      });
    } catch (e) {
      setError(String(e?.message || e));
    }
  }, [messages]);

  const stop = useCallback(() => {
    stopEverything();
    setIsRunning(false);
  }, []);

  const buildSummaryRows = useCallback(() => {
    const cfg = runningCfgRef.current;
    return {
      sessionId: "-",
      started: "-",
      stt: cfg ? `Deepgram ${cfg.sttModel} (${cfg.sttLanguage})` : "-",
      llm: cfg?.model || "-",
      tts: cfg ? `${cfg.voiceName} (${cfg.audioEncoding})` : "-",
      dg_request_id: stats.dg_request_id || "-",
      audio_seconds: `${Number(stats.audio_seconds || 0).toFixed(2)} s`,
      stt_est_cost: `${formatUsd(stats.est_cost_usd)} (price/min $${Number(stats.price_per_min_usd || 0).toFixed(6)})`,
      dg_ttfb: stats.dg_ttfb_ms != null ? `${stats.dg_ttfb_ms} ms` : "-",
      overall_ttfb: stats.overall_ttfb_ms != null ? `${stats.overall_ttfb_ms} ms` : "-",
    };
  }, [stats]);

  return {
    audioOutRef,
    isRunning,
    error,
    stats,
    messages,
    last4,
    start,
    stop,
    buildSummaryRows,
    pttActive,
    setPttActive,
  };
}
