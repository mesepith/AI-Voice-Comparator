import { useEffect, useMemo, useRef, useState } from "react";

/** Helpers */
function wsUrl(pathAndQuery) {
  const proto = window.location.protocol === "https:" ? "wss" : "ws";
  return `${proto}://${window.location.host}${pathAndQuery}`;
}

function clampText(s, max = 5000) {
  const t = String(s ?? "");
  return t.length <= max ? t : t.slice(0, max) + "…";
}

function nowMs() {
  return performance.now();
}

function prettyMs(n) {
  if (n == null || Number.isNaN(n)) return "—";
  return `${Math.round(n)} ms`;
}

function voiceTypePretty(t) {
  if (t === "CHIRP_HD") return "Chirp 3: HD";
  if (t === "WAVENET") return "WaveNet";
  if (t === "NEURAL2") return "Neural2";
  if (t === "STUDIO") return "Studio";
  if (t === "STANDARD") return "Standard";
  if (t === "POLYGLOT") return "Polyglot";
  return t || "Other";
}

function formatUsd(n) {
  if (n == null || Number.isNaN(n)) return "—";
  if (n === 0) return "$0";
  if (n < 0.0001) return `$${n.toExponential(2)}`;
  return `$${n.toFixed(6)}`;
}

function nowPerfMs() {
  return performance.now();
}

function rms16(int16) {
  let sum = 0;
  for (let i = 0; i < int16.length; i++) {
    const v = int16[i] / 32768;
    sum += v * v;
  }
  return Math.sqrt(sum / int16.length);
}

function isAbortError(e) {
  return e?.name === "AbortError";
}

/**
 * App states:
 *  - setup: choose model + tts + prompt
 *  - talk: live conversation
 *  - logs: full logs
 */
export default function App() {
  const [page, setPage] = useState("setup");

  const [bootError, setBootError] = useState("");
  const [error, setError] = useState("");

  // Groq models
  const [models, setModels] = useState([]);
  const [model, setModel] = useState("");

  // Prompt
  const [systemPrompt, setSystemPrompt] = useState("");
  const [promptSource, setPromptSource] = useState("custom"); // custom | default | upload

  // TTS (Google)
  const [voices, setVoices] = useState([]);
  const [languages, setLanguages] = useState([]);
  const [voiceTypes, setVoiceTypes] = useState([]);
  const [language, setLanguage] = useState("en-US");
  const [voiceType, setVoiceType] = useState("CHIRP_HD");
  const [voiceName, setVoiceName] = useState("");
  const [audioEncoding, setAudioEncoding] = useState("MP3");
  const [inputType, setInputType] = useState("text");
  const [speakingRate, setSpeakingRate] = useState(1.0);
  const [pitch, setPitch] = useState(0);
  const [volumeGainDb, setVolumeGainDb] = useState(0);

  // STT (Deepgram) fixed defaults
  const sttModel = "nova-3";
  const sttLanguage = "multi";

  // Conversation
  const [session, setSession] = useState(null);
  const [messages, setMessages] = useState([]);
  const [liveLast4, setLiveLast4] = useState([]);

  // Session-level STT stats
  const [dgRequestId, setDgRequestId] = useState(null);
  const [dgTtfb, setDgTtfb] = useState(null);
  const [overallTtfb, setOverallTtfb] = useState(null);
  const [audioSeconds, setAudioSeconds] = useState(0);
  const [sttEstCost, setSttEstCost] = useState(0);
  const [sttPricePerMin, setSttPricePerMin] = useState(0);

  // Refs for live I/O
  const wsRef = useRef(null);
  const streamRef = useRef(null);
  const audioCtxRef = useRef(null);
  const workletRef = useRef(null);
  const sourceRef = useRef(null);
  const muteGainRef = useRef(null);

  const audioOutRef = useRef(null);

  // For interrupt + aborts
  const llmAbortRef = useRef(null);
  const ttsAbortRef = useRef(null);

  // For STT utterance tracking
  const utterRef = useRef({
    active: false,
    startedAt: null,
    firstResultAt: null,
    textFinalParts: [],
    lastFinalAt: null,
  });

  // AI speaking state (so we can gate STT)
  const aiSpeakingRef = useRef(false);

  /**
   * Local gate/VAD state.
   * We will only consider "user speaking" if RMS stays above threshold for MIN_ON_FRAMES.
   * This avoids claps/clicks from interrupting TTS.
   */
  const gateRef = useRef({
    floor: 0,        // echo/noise floor while AI speaking
    isSpeech: false, // confirmed speech
    lastSpeechAt: 0,
    onsetFrames: 0,  // consecutive frames above ON
  });

  // Pre-roll frames kept while gated (so we don’t lose first syllable)
  const preRollRef = useRef([]); // ArrayBuffer[]

  // Aggregate tiny worklet chunks into 20ms frames (320 samples @ 16kHz)
  const aggRef = useRef({ buf: new Int16Array(320), off: 0 });

  const isChirp = voiceType === "CHIRP_HD";

  // === Tuning knobs (latency vs false-interrupt) ===
  // 20ms frames -> 4 frames = 80ms (good low-latency, ignores claps)
  // If claps still interrupt, increase to 5 or 6.
  const MIN_ON_FRAMES = 5; // 100ms
  const HANG_MS = 250;     // how quickly we drop speech state after silence

  /** Boot: load models + voices, also load default prompt */
  useEffect(() => {
    (async () => {
      try {
        setBootError("");
        setError("");

        const [mRes, vRes, pRes] = await Promise.all([
          fetch("/api/models"),
          fetch("/api/voices"),
          fetch("/prompts/ai-prompt.txt"),
        ]);

        if (!mRes.ok) throw new Error(`Groq models failed (${mRes.status})`);
        const mData = await mRes.json();
        const list = mData?.models || [];
        setModels(list);
        setModel(list[0] || "");

        if (!vRes.ok) throw new Error(`Google voices failed (${vRes.status})`);
        const vData = await vRes.json();
        setVoices(vData.voices || []);
        setLanguages(vData.languages || []);
        setVoiceTypes(vData.voiceTypes || []);

        // Pick defaults
        const defaultLang = (vData.languages || []).includes("en-US") ? "en-US" : (vData.languages || [])[0];
        setLanguage(defaultLang || "en-US");

        const hasChirp = (vData.voices || []).some((v) => v.voiceType === "CHIRP_HD");
        const defaultType = hasChirp
          ? "CHIRP_HD"
          : ((vData.voiceTypes || []).includes("NEURAL2") ? "NEURAL2" : (vData.voiceTypes || [])[0]);
        setVoiceType(defaultType || "NEURAL2");

        // Default prompt
        const pText = pRes.ok ? await pRes.text() : "";
        if (pText.trim()) {
          setSystemPrompt(pText);
          setPromptSource("default");
        } else {
          setSystemPrompt("You are a helpful voice assistant.");
          setPromptSource("custom");
        }
      } catch (e) {
        setBootError(String(e?.message || e));
      }
    })();
  }, []);

  const filteredVoices = useMemo(() => {
    return voices
      .filter((v) => (language ? (v.languageCodes || []).includes(language) : true))
      .filter((v) => (voiceType ? v.voiceType === voiceType : true))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [voices, language, voiceType]);

  useEffect(() => {
    if (!filteredVoices.length) return;
    const exists = filteredVoices.some((v) => v.name === voiceName);
    if (!exists) setVoiceName(filteredVoices[0].name);
  }, [filteredVoices, voiceName]);

  useEffect(() => {
    if (isChirp) {
      setInputType("text");
      setSpeakingRate(1.0);
      setPitch(0);
    }
  }, [isChirp]);

  const canStart = useMemo(() => {
    return !!(model && voiceName && systemPrompt.trim() && !bootError);
  }, [model, voiceName, systemPrompt, bootError]);

  function pushMessage(entry) {
    setMessages((prev) => {
      const next = [...prev, entry];
      setLiveLast4(next.slice(-4));
      return next;
    });
  }

  async function loadDefaultPrompt() {
    setError("");
    try {
      const res = await fetch("/prompts/ai-prompt.txt");
      const t = await res.text();
      setSystemPrompt(t);
      setPromptSource("default");
    } catch {
      setError("Failed to load default prompt file.");
    }
  }

  async function handlePromptUpload(file) {
    setError("");
    try {
      const text = await file.text();
      setSystemPrompt(text);
      setPromptSource("upload");
    } catch {
      setError("Failed to read uploaded file.");
    }
  }

  function startNewUtteranceIfNeeded() {
    if (utterRef.current.active) return;
    utterRef.current.active = true;
    utterRef.current.startedAt = nowMs();
    utterRef.current.firstResultAt = null;
    utterRef.current.textFinalParts = [];
    utterRef.current.lastFinalAt = null;
  }

  /** Start conversation session */
  async function startSession() {
    setError("");
    setMessages([]);
    setLiveLast4([]);
    setDgRequestId(null);
    setDgTtfb(null);
    setOverallTtfb(null);
    setAudioSeconds(0);
    setSttEstCost(0);
    setSttPricePerMin(0);

    utterRef.current = { active: false, startedAt: null, firstResultAt: null, textFinalParts: [], lastFinalAt: null };

    // reset gate state
    gateRef.current.floor = 0;
    gateRef.current.isSpeech = false;
    gateRef.current.lastSpeechAt = 0;
    gateRef.current.onsetFrames = 0;
    preRollRef.current.length = 0;

    // Create audio output element
    if (!audioOutRef.current) audioOutRef.current = new Audio();
    const a = audioOutRef.current;
    a.preload = "auto";

    if (!a.__wired) {
      a.addEventListener("playing", () => {
        aiSpeakingRef.current = true;
        // reset echo/noise floor at the start of TTS
        gateRef.current.floor = 0;
        // also reset onset so claps right after start don’t trip
        gateRef.current.onsetFrames = 0;
      });
      const markStop = () => {
        aiSpeakingRef.current = false;
        preRollRef.current.length = 0;
        gateRef.current.onsetFrames = 0;
        gateRef.current.isSpeech = false;
      };
      a.addEventListener("ended", markStop);
      a.addEventListener("pause", markStop);
      a.__wired = true;
    }

    const s = {
      id: crypto.randomUUID(),
      createdAtIso: new Date().toISOString(),
      settings: {
        stt: { provider: "Deepgram", model: sttModel, language: sttLanguage },
        llm: { provider: "Groq", model },
        tts: {
          provider: "Google TTS",
          language,
          voiceType,
          voiceName,
          audioEncoding,
          inputType,
          speakingRate: isChirp ? undefined : Number(speakingRate),
          pitch: isChirp ? undefined : Number(pitch),
          volumeGainDb: Number(volumeGainDb),
        },
        systemPrompt,
        promptSource,
      },
    };
    setSession(s);
    setPage("talk");

    // Connect STT WS + mic
    await connectSttWsAndMic();

    // Kickoff: AI speaks first
    try {
      await runAssistantTurn({
        userText: "Start the conversation now. Speak to the user based on the system instructions.",
        sttMetrics: null,
        isKickoff: true,
      });
    } catch (e) {
      if (!isAbortError(e)) throw e;
    }
  }

  /** Connect to /ws and start streaming mic audio */
  async function connectSttWsAndMic() {
    const url = wsUrl(`/ws?model=${encodeURIComponent(sttModel)}&language=${encodeURIComponent(sttLanguage)}`);
    const ws = new WebSocket(url);
    ws.binaryType = "arraybuffer";
    wsRef.current = ws;

    ws.onopen = async () => {
      try {
        await startAudioPipeline();
      } catch (e) {
        setError(`Mic error: ${String(e?.message || e)}`);
      }
    };

    ws.onmessage = (ev) => {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }

      // Lifecycle + stats
      if (msg.type === "proxy_error") {
        const extra = msg.body ? `\n\nDeepgram: ${msg.body}` : "";
        setError(`${msg.message}${msg.dg_error ? ` | ${msg.dg_error}` : ""}${extra}`);
        stopEverything();
        return;
      }

      if (msg.type === "dg_open") {
        setDgRequestId(msg.dg_request_id || null);
        return;
      }
      if (msg.type === "metric") {
        if (msg.name === "dg_ttfb_ms") setDgTtfb(msg.value);
        if (msg.name === "overall_ttfb_ms") setOverallTtfb(msg.value);
        return;
      }
      if (msg.type === "stats") {
        setAudioSeconds(msg.audio_seconds || 0);
        setSttEstCost(msg.est_cost_usd || 0);
        setSttPricePerMin(msg.price_per_min_usd || 0);
        if (msg.dg_request_id) setDgRequestId(msg.dg_request_id);
        return;
      }

      /**
       * Deepgram SpeechStarted can be noisy in real environments.
       * We do NOT use it to barge-in by itself.
       * We only barge-in when our local gate confirms sustained speech.
       */
      if (msg.type === "SpeechStarted") {
        // ignore for barge-in; local gate controls interruption
        return;
      }

      if (msg.type === "Results") {
        const alt = msg?.channel?.alternatives?.[0];
        const t = (alt?.transcript || "").trim();
        if (!t) return;

        const isFinal = !!msg.is_final;
        const speechFinal = !!msg.speech_final;

        if (!utterRef.current.active) startNewUtteranceIfNeeded();
        if (utterRef.current.firstResultAt == null) utterRef.current.firstResultAt = nowMs();

        if (isFinal) {
          utterRef.current.textFinalParts.push(t);
          utterRef.current.lastFinalAt = nowMs();
        }

        if (isFinal && speechFinal) {
          const full = utterRef.current.textFinalParts.join(" ").trim();
          const startedAt = utterRef.current.startedAt ?? nowMs();
          const firstResultAt = utterRef.current.firstResultAt ?? nowMs();
          const endedAt = nowMs();

          const sttMetrics = {
            sttMs: endedAt - startedAt,
            sttFirstResultMs: firstResultAt - startedAt,
          };

          utterRef.current = { active: false, startedAt: null, firstResultAt: null, textFinalParts: [], lastFinalAt: null };

          if (!full) return;

          runAssistantTurn({ userText: full, sttMetrics, isKickoff: false }).catch((e) => {
            if (!isAbortError(e)) setError(String(e?.message || e));
          });
        }
      }
    };

    ws.onclose = () => {};
    ws.onerror = () => {
      setError("WebSocket error. Check Apache WS proxy and backend logs.");
    };
  }

  async function startAudioPipeline() {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    streamRef.current = stream;

    const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    audioCtxRef.current = audioCtx;

    await audioCtx.audioWorklet.addModule(new URL("./audio/pcm16-worklet.js", import.meta.url));

    const source = audioCtx.createMediaStreamSource(stream);
    sourceRef.current = source;

    const worklet = new AudioWorkletNode(audioCtx, "pcm16-worklet", {
      processorOptions: { targetSampleRate: 16000 },
    });
    workletRef.current = worklet;

    // connect through muted gain so the graph runs everywhere
    const mute = audioCtx.createGain();
    mute.gain.value = 0;
    muteGainRef.current = mute;

    source.connect(worklet);
    worklet.connect(mute);
    mute.connect(audioCtx.destination);

    worklet.port.onmessage = (e) => {
      const ws = wsRef.current;
      if (!ws || ws.readyState !== WebSocket.OPEN) return;

      // Backpressure guard
      if (ws.bufferedAmount > 2_000_000) return;

      const in16 = new Int16Array(e.data);

      // Aggregate to 20ms frames (320 samples @ 16k)
      let { buf, off } = aggRef.current;
      let i = 0;

      while (i < in16.length) {
        const take = Math.min(buf.length - off, in16.length - i);
        buf.set(in16.subarray(i, i + take), off);
        off += take;
        i += take;

        if (off === buf.length) {
          // one 20ms frame
          const frame = buf.slice(0);
          const frameAb = frame.buffer;

          const rms = rms16(frame);
          const s = gateRef.current;
          const t = nowPerfMs();

          // Update echo/noise floor while AI is speaking and we’re NOT in confirmed speech
          if (aiSpeakingRef.current && !s.isSpeech) {
            s.floor = s.floor === 0 ? rms : (0.95 * s.floor + 0.05 * rms);
          }

          // Dynamic thresholds
          const ON = Math.max(0.02, s.floor * 3.0);
          const OFF = Math.max(0.015, s.floor * 2.0);

          // --- SPEECH ONSET DEBOUNCE (fixes clap) ---
          if (!s.isSpeech) {
            if (rms >= ON) {
              s.onsetFrames += 1;
            } else {
              s.onsetFrames = 0;
            }

            // Confirm speech only after sustained frames
            if (s.onsetFrames >= MIN_ON_FRAMES) {
              s.isSpeech = true;
              s.lastSpeechAt = t;
              s.onsetFrames = 0;

              startNewUtteranceIfNeeded();

              // If AI is speaking, this is real barge-in: stop TTS now
              if (aiSpeakingRef.current) {
                stopAudioOutput("barge-in");

                // flush pre-roll so we don’t lose first syllable
                for (const pr of preRollRef.current) ws.send(pr);
                preRollRef.current.length = 0;
              }
            }
          } else {
            // Speech hangover
            if (rms >= OFF) s.lastSpeechAt = t;
            if (t - s.lastSpeechAt > HANG_MS) s.isSpeech = false;
          }

          // Gate: while AI speaking and user NOT speaking => don’t send to Deepgram
          if (aiSpeakingRef.current && !s.isSpeech) {
            preRollRef.current.push(frameAb);
            if (preRollRef.current.length > 13) preRollRef.current.shift(); // ~260ms
          } else {
            ws.send(frameAb);
          }

          off = 0;
        }
      }

      aggRef.current.off = off;
    };
  }

  function stopAudioOutput() {
    const a = audioOutRef.current;
    if (!a) return;
    try {
      a.pause();
      a.currentTime = 0;
    } catch {}

    // Abort pending assistant turn so user can barge in
    try { llmAbortRef.current?.abort(); } catch {}
    try { ttsAbortRef.current?.abort(); } catch {}
    llmAbortRef.current = null;
    ttsAbortRef.current = null;

    aiSpeakingRef.current = false;
    preRollRef.current.length = 0;

    gateRef.current.isSpeech = false;
    gateRef.current.onsetFrames = 0;
  }

  function stopEverything() {
    try { llmAbortRef.current?.abort(); } catch {}
    try { ttsAbortRef.current?.abort(); } catch {}
    llmAbortRef.current = null;
    ttsAbortRef.current = null;

    stopAudioOutput();

    try {
      const ws = wsRef.current;
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "CloseStream" }));
        ws.close();
      }
    } catch {}
    wsRef.current = null;

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

  async function runAssistantTurn({ userText, sttMetrics, isKickoff }) {
    setError("");

    const turnId = crypto.randomUUID();
    const userMsg = {
      id: crypto.randomUUID(),
      role: "user",
      text: clampText(userText, 5000),
      createdAtMs: Date.now(),
      metrics: sttMetrics ? { stt: sttMetrics } : null,
    };

    if (!isKickoff) pushMessage(userMsg);

    const history = (isKickoff ? [] : [...messages, userMsg]).slice(-10).map((m) => ({
      role: m.role,
      content: m.text,
    }));

    const llmMessages = [
      { role: "system", content: systemPrompt },
      ...history,
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
        body: JSON.stringify({ model, messages: llmMessages, temperature: 0.4 }),
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

    // ---- TTS ----
    const ttsAbort = new AbortController();
    ttsAbortRef.current = ttsAbort;

    const ttsPayload = {
      inputType,
      text: assistantText || "(empty response)",
      voiceName,
      languageCode: language,
      audioEncoding,
      volumeGainDb: Number(volumeGainDb),
      ...(isChirp ? {} : { speakingRate: Number(speakingRate), pitch: Number(pitch) }),
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
    const ttsT1 = nowMs();

    const ttsData = await ttsRes.json();
    if (!ttsRes.ok) throw new Error(ttsData?.details || ttsData?.error || "TTS failed");

    const ttsMetrics = {
      clientMs: ttsT1 - ttsT0,
      serverTtsMs: ttsData?.metrics?.server?.ttsMs ?? null,
      serverTotalMs: ttsData?.metrics?.server?.totalMs ?? null,
      charCount: ttsData?.metrics?.input?.charCount ?? null,
      estCostUsd: ttsData?.metrics?.billingEstimate?.estimatedCostUsd ?? null,
      warnings: ttsData?.warnings ?? [],
      encoding: ttsData?.audio?.encoding ?? null,
      mimeType: ttsData?.audio?.mimeType ?? null,
    };

    // ---- Audio playback (interruptable) ----
    const a = audioOutRef.current;
    const audioSrc = `data:${ttsData.audio.mimeType};base64,${ttsData.audio.base64}`;

    const playbackStartAt = nowMs();
    let playStartedAt = null;

    a.src = audioSrc;
    a.load();

    try {
      await a.play();
      playStartedAt = nowMs();
    } catch {
      playStartedAt = null;
    }

    const endToEndMs =
      sttMetrics?.sttMs != null && sttMetrics?.sttMs >= 0 && playStartedAt != null
        ? (sttMetrics.sttMs + llmMetrics.clientMs + ttsMetrics.clientMs)
        : null;

    const assistantMsg = {
      id: crypto.randomUUID(),
      role: "assistant",
      text: clampText(assistantText, 5000),
      createdAtMs: Date.now(),
      metrics: {
        turnId,
        stt: sttMetrics,
        llm: llmMetrics,
        tts: ttsMetrics,
        totals: {
          pipelineMs: (sttMetrics?.sttMs ?? 0) + llmMetrics.clientMs + ttsMetrics.clientMs,
          endToEndMs,
          audioPlayAttemptMs: playStartedAt ? (playStartedAt - playbackStartAt) : null,
        },
      },
    };

    pushMessage(assistantMsg);

    llmAbortRef.current = null;
    ttsAbortRef.current = null;
  }

  /** Stop -> logs screen */
  function stopAndShowLogs() {
    stopEverything();
    setPage("logs");
  }

  /** Exit logs -> setup screen */
  function exitToSetup() {
    setError("");
    setMessages([]);
    setLiveLast4([]);
    setSession(null);
    setPage("setup");
  }

  // ---------- UI ----------
  if (page === "setup") {
    return (
      <div className="container">
        <div className="hstack" style={{ justifyContent: "space-between" }}>
          <div>
            <div style={{ fontSize: 22, fontWeight: 900 }}>AI Voice Demo</div>
            <div className="small">
              Choose a Groq LLM + Google TTS voice and run a live voice conversation using Deepgram Nova-3 (multilingual).
              <span className="badge" style={{ marginLeft: 10 }}>Priority: low latency + speed</span>
            </div>
          </div>
          <div className="badge">Domain: <span className="mono">ai-voice-demo.zahiralam.com</span></div>
        </div>

        <div className="card" style={{ marginTop: 14 }}>
          <div style={{ fontWeight: 900, marginBottom: 6 }}>How to use</div>
          <ol className="small" style={{ margin: 0, paddingLeft: 18, lineHeight: 1.6 }}>
            <li>Pick an <b>LLM model</b> (Groq).</li>
            <li>Pick a <b>TTS voice</b> + encoding (Google TTS).</li>
            <li>Paste or upload your <b>system prompt</b> (default prompt is available).</li>
            <li>Click <b>Start</b>, let the AI speak first, then talk back. You can <b>interrupt</b> the AI any time.</li>
            <li>Click <b>Stop</b> to view detailed timing logs (STT / LLM / TTS per turn).</li>
          </ol>
          <div className="small" style={{ marginTop: 10, opacity: 0.9 }}>
            Tip: Use <b>headphones</b> for best results so the mic doesn’t pick up the AI’s own voice.
          </div>
        </div>

        {bootError ? (
          <div className="card" style={{ marginTop: 14 }}>
            <div className="error"><b>Backend not reachable.</b> {bootError}</div>
            <div className="small" style={{ marginTop: 8 }}>
              Make sure backend is running on <span className="mono">127.0.0.1:7079</span> and your API keys/billing are configured.
            </div>
          </div>
        ) : null}

        {error ? (
          <div className="card" style={{ marginTop: 14 }}>
            <div className="error"><b>Error:</b> {error}</div>
          </div>
        ) : null}

        <div className="card" style={{ marginTop: 14 }}>
          <div className="row cols2">
            <div>
              <div style={{ fontWeight: 900, marginBottom: 8 }}>LLM (Groq)</div>
              <label>Model</label>
              <select value={model} onChange={(e) => setModel(e.target.value)} disabled={!models.length}>
                {models.map((m) => (
                  <option key={m} value={m}>{m}</option>
                ))}
              </select>
              <div className="small" style={{ marginTop: 8 }}>
                Models are loaded from <span className="mono">/api/models</span>.
              </div>
            </div>

            <div>
              <div style={{ fontWeight: 900, marginBottom: 8 }}>STT (Deepgram)</div>
              <table className="table">
                <tbody>
                  <tr><td>Model</td><td className="mono">{sttModel}</td></tr>
                  <tr><td>Language</td><td className="mono">{sttLanguage}</td></tr>
                  <tr><td>Mode</td><td className="mono">Live streaming (WS)</td></tr>
                </tbody>
              </table>
              <div className="small">This demo uses the default STT you mentioned.</div>
            </div>
          </div>

          <hr />

          <div style={{ fontWeight: 900, marginBottom: 8 }}>TTS (Google)</div>
          <div className="row cols3">
            <div>
              <label>Language</label>
              <select value={language} onChange={(e) => setLanguage(e.target.value)}>
                {languages.map((l) => (<option key={l} value={l}>{l}</option>))}
              </select>
            </div>
            <div>
              <label>Voice type (model)</label>
              <select value={voiceType} onChange={(e) => setVoiceType(e.target.value)}>
                {voiceTypes.map((t) => (<option key={t} value={t}>{voiceTypePretty(t)}</option>))}
              </select>
              {isChirp && <div className="small">Chirp 3: HD disables SSML / rate / pitch.</div>}
            </div>
            <div>
              <label>Voice</label>
              <select value={voiceName} onChange={(e) => setVoiceName(e.target.value)}>
                {filteredVoices.map((v) => (
                  <option key={v.name} value={v.name}>
                    {v.name} ({v.ssmlGender})
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="row cols3" style={{ marginTop: 12 }}>
            <div>
              <label>Audio encoding</label>
              <select value={audioEncoding} onChange={(e) => setAudioEncoding(e.target.value)}>
                <option value="MP3">MP3</option>
                <option value="OGG_OPUS">OGG_OPUS</option>
                <option value="LINEAR16">LINEAR16</option>
                <option value="MULAW">MULAW</option>
              </select>
            </div>

            <div>
              <label>Input type</label>
              <select value={inputType} onChange={(e) => setInputType(e.target.value)} disabled={isChirp}>
                <option value="text">Text</option>
                <option value="ssml">SSML</option>
              </select>
            </div>

            <div>
              <label>Speaking rate / Pitch</label>
              <div className="hstack">
                <input
                  type="number"
                  step="0.05"
                  min="0.25"
                  max="4"
                  value={speakingRate}
                  disabled={isChirp}
                  onChange={(e) => setSpeakingRate(e.target.value)}
                />
                <input
                  type="number"
                  step="1"
                  min="-20"
                  max="20"
                  value={pitch}
                  disabled={isChirp}
                  onChange={(e) => setPitch(e.target.value)}
                />
              </div>
              <div className="small">{isChirp ? "Disabled for Chirp 3: HD." : "Left: rate, Right: pitch."}</div>
            </div>
          </div>

          <div className="row cols2" style={{ marginTop: 12 }}>
            <div>
              <label>Volume gain (dB)</label>
              <input
                type="number"
                step="1"
                min="-96"
                max="16"
                value={volumeGainDb}
                onChange={(e) => setVolumeGainDb(e.target.value)}
              />
              <div className="small">Optional. Can help if voice is too quiet/loud.</div>
            </div>
            <div />
          </div>

          <hr />

          <div style={{ fontWeight: 900, marginBottom: 8 }}>System prompt</div>

          <div className="hstack" style={{ marginBottom: 10 }}>
            <button className="secondary" onClick={loadDefaultPrompt}>Use default prompt</button>
            <label className="badge" style={{ cursor: "pointer" }}>
              Upload prompt
              <input
                type="file"
                accept=".txt,.md,.json"
                style={{ display: "none" }}
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) handlePromptUpload(f);
                }}
              />
            </label>
            <span className="small">
              Supported: <span className="mono">.txt .md .json</span>
            </span>
            <span className="badge">Source: <span className="mono">{promptSource}</span></span>
          </div>

          <textarea
            value={systemPrompt}
            onChange={(e) => { setSystemPrompt(e.target.value); setPromptSource("custom"); }}
            placeholder="Paste your system prompt here..."
          />

          <div className="hstack" style={{ marginTop: 12, justifyContent: "space-between" }}>
            <div className="small">
              Start appears when LLM model, TTS voice, and prompt are set.
            </div>
            <button disabled={!canStart} onClick={startSession}>
              🎤 Start
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (page === "talk") {
    return (
      <div className="container">
        <div className="hstack" style={{ justifyContent: "space-between" }}>
          <div>
            <div style={{ fontSize: 20, fontWeight: 900 }}>Live Conversation</div>
            <div className="small">
              STT: <span className="mono">Deepgram {sttModel} ({sttLanguage})</span> •
              LLM: <span className="mono">{model}</span> •
              TTS: <span className="mono">{voiceName}</span>
            </div>
          </div>

          <div className="hstack">
            <span className="badge">DG req: <span className="mono">{dgRequestId || "—"}</span></span>
            <button className="danger" onClick={stopAndShowLogs}>⏹ Stop</button>
          </div>
        </div>

        {error ? (
          <div className="card" style={{ marginTop: 14 }}>
            <div className="error"><b>Error:</b> {error}</div>
          </div>
        ) : null}

        <div className="card" style={{ marginTop: 14 }}>
          <div className="heartbeatWrap">
            <div className="heart" aria-label="heartbeat animation" />
          </div>

          <div className="small">
            Metrics: DG TTFB <span className="mono">{prettyMs(dgTtfb)}</span> • Overall TTFB <span className="mono">{prettyMs(overallTtfb)}</span> •
            Audio streamed <span className="mono">{audioSeconds.toFixed(2)} s</span> • STT est cost <span className="mono">{formatUsd(sttEstCost)}</span>
          </div>

          <div className="msgList">
            {liveLast4.map((m) => (
              <div className="msg" key={m.id}>
                <div className="msgHeader">
                  <div className={m.role === "user" ? "roleUser" : "roleAi"}>
                    {m.role === "user" ? "User" : "AI"}
                  </div>
                  {m.role === "assistant" ? (
                    <div className="small mono">
                      STT {prettyMs(m.metrics?.stt?.sttMs)} •
                      LLM {prettyMs(m.metrics?.llm?.clientMs)} •
                      TTS {prettyMs(m.metrics?.tts?.clientMs)}
                    </div>
                  ) : (
                    <div className="small mono">
                      {m.metrics?.stt ? `STT ${prettyMs(m.metrics.stt.sttMs)}` : "—"}
                    </div>
                  )}
                </div>
                <div className="msgText">{m.text}</div>
              </div>
            ))}
            {!liveLast4.length ? (
              <div className="small">Waiting for first messages… If audio doesn’t start, click once anywhere to allow autoplay.</div>
            ) : null}
          </div>
        </div>
      </div>
    );
  }

  // logs page
  return (
    <div className="container">
      <div className="hstack" style={{ justifyContent: "space-between" }}>
        <div>
          <div style={{ fontSize: 20, fontWeight: 900 }}>Timing Logs</div>
          <div className="small">
            Oldest message is at the top. AI messages include STT/LLM/TTS + combined timings.
          </div>
        </div>
        <button className="secondary" onClick={exitToSetup}>⬅ Exit</button>
      </div>

      <div className="card" style={{ marginTop: 14 }}>
        <div style={{ fontWeight: 900, marginBottom: 10 }}>Session summary</div>
        <table className="table">
          <tbody>
            <tr><td>Session ID</td><td className="mono">{session?.id || "—"}</td></tr>
            <tr><td>Started</td><td className="mono">{session?.createdAtIso || "—"}</td></tr>
            <tr><td>STT</td><td className="mono">Deepgram {sttModel} ({sttLanguage})</td></tr>
            <tr><td>LLM</td><td className="mono">{model}</td></tr>
            <tr><td>TTS</td><td className="mono">{voiceName} ({voiceTypePretty(voiceType)})</td></tr>
            <tr><td>DG request id</td><td className="mono">{dgRequestId || "—"}</td></tr>
            <tr><td>Audio streamed</td><td className="mono">{audioSeconds.toFixed(2)} s</td></tr>
            <tr><td>STT est cost</td><td className="mono">{formatUsd(sttEstCost)} (price/min {formatUsd(sttPricePerMin)})</td></tr>
            <tr><td>DG TTFB</td><td className="mono">{prettyMs(dgTtfb)}</td></tr>
            <tr><td>Overall TTFB</td><td className="mono">{prettyMs(overallTtfb)}</td></tr>
          </tbody>
        </table>
      </div>

      <div className="card" style={{ marginTop: 14 }}>
        <div style={{ fontWeight: 900, marginBottom: 10 }}>Conversation log</div>

        {messages.length ? (
          <div className="row" style={{ gap: 14 }}>
            {messages.map((m) => (
              <div className="msg" key={m.id}>
                <div className="msgHeader">
                  <div className={m.role === "user" ? "roleUser" : "roleAi"}>
                    {m.role === "user" ? "User" : "AI"}
                  </div>
                  <div className="small mono">{new Date(m.createdAtMs).toLocaleString()}</div>
                </div>

                <div className="msgText">{m.text}</div>

                {m.role === "assistant" ? (
                  <>
                    <hr />
                    <table className="table">
                      <tbody>
                        <tr><td>STT</td><td className="mono">{prettyMs(m.metrics?.stt?.sttMs)} (first result {prettyMs(m.metrics?.stt?.sttFirstResultMs)})</td></tr>
                        <tr><td>LLM</td><td className="mono">{prettyMs(m.metrics?.llm?.clientMs)} (server {prettyMs(m.metrics?.llm?.serverWallMs)})</td></tr>
                        <tr><td>TTS</td><td className="mono">{prettyMs(m.metrics?.tts?.clientMs)} (server {prettyMs(m.metrics?.tts?.serverTtsMs)})</td></tr>
                        <tr><td>STT + LLM + TTS</td><td className="mono">{prettyMs(m.metrics?.totals?.pipelineMs)}</td></tr>
                        <tr><td>End-to-end (approx)</td><td className="mono">{prettyMs(m.metrics?.totals?.endToEndMs)}</td></tr>
                        <tr><td>LLM request id</td><td className="mono">{m.metrics?.llm?.requestId || "—"}</td></tr>
                        <tr><td>TTS chars / cost</td><td className="mono">{m.metrics?.tts?.charCount ?? "—"} chars • {formatUsd(m.metrics?.tts?.estCostUsd)}</td></tr>
                        <tr><td>TTS encoding</td><td className="mono">{m.metrics?.tts?.encoding || "—"}</td></tr>
                        {(m.metrics?.tts?.warnings || []).length ? (
                          <tr><td>Warnings</td><td className="mono">{m.metrics.tts.warnings.join(" | ")}</td></tr>
                        ) : null}
                        {m.metrics?.llm?.usage?.total_time != null ? (
                          <tr>
                            <td>Groq timings</td>
                            <td className="mono">
                              total {m.metrics.llm.usage.total_time}s • queue {m.metrics.llm.usage.queue_time}s • prompt {m.metrics.llm.usage.prompt_time}s • completion {m.metrics.llm.usage.completion_time}s
                            </td>
                          </tr>
                        ) : null}
                        {m.metrics?.llm?.usage?.total_tokens != null ? (
                          <tr>
                            <td>Groq tokens</td>
                            <td className="mono">
                              prompt {m.metrics.llm.usage.prompt_tokens} • completion {m.metrics.llm.usage.completion_tokens} • total {m.metrics.llm.usage.total_tokens}
                            </td>
                          </tr>
                        ) : null}
                      </tbody>
                    </table>
                  </>
                ) : (
                  m.metrics?.stt ? (
                    <>
                      <hr />
                      <div className="small mono">
                        STT {prettyMs(m.metrics.stt.sttMs)} • first result {prettyMs(m.metrics.stt.sttFirstResultMs)}
                      </div>
                    </>
                  ) : null
                )}
              </div>
            ))}
          </div>
        ) : (
          <div className="small">No messages captured.</div>
        )}
      </div>
    </div>
  );
}
