import { useEffect, useMemo, useState } from "react";
import "./App.css";

import SetupPage from "./pages/SetupPage";
import TalkPage from "./pages/TalkPage";
import LogsPage from "./pages/LogsPage";
import { useConversationEngine } from "./hooks/useConversationEngine";
import { BARGE_IN_PROFILES } from "./lib/utils";

export default function App() {
  const engine = useConversationEngine();

  const [page, setPage] = useState("setup"); // setup | talk | logs
  const [loading, setLoading] = useState(false);
  const [bootError, setBootError] = useState("");

  const [models, setModels] = useState([]);
  const [model, setModel] = useState("");

  // TTS boot data
  const [voices, setVoices] = useState([]);
  const [languages, setLanguages] = useState([]);
  const [voiceTypes, setVoiceTypes] = useState([]);

  // TTS selections
  const [language, setLanguage] = useState("en-US");
  const [voiceType, setVoiceType] = useState("CHIRP_HD");
  const [voiceName, setVoiceName] = useState("");

  const [audioEncoding, setAudioEncoding] = useState("OGG_OPUS");
  const [inputType, setInputType] = useState("text");
  const [speakingRate, setSpeakingRate] = useState(1.0);
  const [pitch, setPitch] = useState(0);
  const [volumeGainDb, setVolumeGainDb] = useState(0);

  // Prompt
  const [systemPrompt, setSystemPrompt] = useState("");

  // Barge-in
  const [bargeInMode, setBargeInMode] = useState("strict");

  const isChirp = voiceType === "CHIRP_HD";

  // boot: fetch models + voices + default prompt text
  useEffect(() => {
    (async () => {
      try {
        setBootError("");
        setLoading(true);

        const [mRes, vRes, pRes] = await Promise.all([
          fetch("/api/models"),
          fetch("/api/voices"),
          fetch("/ai-prompt.txt").catch(() => null),
        ]);

        if (mRes.ok) {
          const md = await mRes.json();
          const list = md?.models || [];
          setModels(list);
          setModel(list[0] || "");
        }

        if (vRes.ok) {
          const vd = await vRes.json();
          setVoices(vd.voices || []);
          setLanguages(vd.languages || []);
          setVoiceTypes(vd.voiceTypes || []);

          const defaultLang = (vd.languages || []).includes("en-US") ? "en-US" : (vd.languages || [])[0];
          setLanguage(defaultLang || "en-US");

          const hasChirp = (vd.voices || []).some((v) => v.voiceType === "CHIRP_HD");
          const defaultType = hasChirp ? "CHIRP_HD" : ((vd.voiceTypes || []).includes("NEURAL2") ? "NEURAL2" : (vd.voiceTypes || [])[0]);
          setVoiceType(defaultType || "CHIRP_HD");
        }

        if (pRes && pRes.ok) {
          const txt = await pRes.text();
          if (txt?.trim()) setSystemPrompt(txt);
        }
      } catch (e) {
        setBootError(String(e?.message || e));
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  // auto-pick default voiceName when language/type changes
  useEffect(() => {
    const candidates = voices
      .filter((v) => (voiceType ? v.voiceType === voiceType : true))
      .filter((v) => (language ? (v.languageCodes || []).includes(language) : true));
    if (candidates.length && (!voiceName || !candidates.some((v) => v.name === voiceName))) {
      setVoiceName(candidates[0].name);
    }
  }, [voices, language, voiceType]); // eslint-disable-line

  const canStart = useMemo(() => {
    return Boolean(model && voiceName && systemPrompt.trim());
  }, [model, voiceName, systemPrompt]);

  function onUploadPrompt(e) {
    const f = e.target.files?.[0];
    if (!f) return;
    if (!f.name.toLowerCase().endsWith(".txt")) {
      alert("Only .txt is supported.");
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      setSystemPrompt(String(reader.result || ""));
    };
    reader.readAsText(f);
  }

  async function onStart() {
    if (!canStart) return;

    // IMPORTANT: start requires a user gesture, so audio play is allowed
    setPage("talk");

    await engine.start({
      // STT fixed
      sttModel: "nova-3",
      sttLanguage: "multi",

      // LLM
      model,

      // Prompt
      systemPrompt,

      // TTS
      language,
      voiceType,
      voiceName,
      audioEncoding,
      inputType,
      speakingRate,
      pitch,
      volumeGainDb,
      isChirp,

      // Interrupt mode
      bargeInMode,

      // Kickoff – you can make this stricter later, but this matches your requirement
      kickoffUserText: "Begin the conversation and greet the user.",
    });
  }

  function onStop() {
    engine.stop();
    setPage("logs");
  }

  function onExit() {
    setPage("setup");
  }

  const headerLine = `STT: Deepgram nova-3 (multi) • LLM: ${model || "-"} • TTS: ${voiceName || "-"}`;
  const statsLine = `DG TTFB ${engine.stats.dg_ttfb_ms ?? "—"} ms • Overall TTFB ${engine.stats.overall_ttfb_ms ?? "—"} ms • Audio streamed ${Number(engine.stats.audio_seconds || 0).toFixed(2)} s • STT est cost ${engine.stats.est_cost_usd ?? 0}`;

  if (page === "setup") {
    return (
      <SetupPage
        loading={loading}
        bootError={bootError}
        models={models}
        model={model}
        setModel={setModel}
        voices={voices}
        languages={languages}
        voiceTypes={voiceTypes}
        language={language}
        setLanguage={setLanguage}
        voiceType={voiceType}
        setVoiceType={setVoiceType}
        voiceName={voiceName}
        setVoiceName={setVoiceName}
        audioEncoding={audioEncoding}
        setAudioEncoding={setAudioEncoding}
        inputType={inputType}
        setInputType={setInputType}
        speakingRate={speakingRate}
        setSpeakingRate={setSpeakingRate}
        pitch={pitch}
        setPitch={setPitch}
        volumeGainDb={volumeGainDb}
        setVolumeGainDb={setVolumeGainDb}
        systemPrompt={systemPrompt}
        setSystemPrompt={setSystemPrompt}
        onUploadPrompt={onUploadPrompt}
        bargeInMode={bargeInMode}
        setBargeInMode={setBargeInMode}
        canStart={canStart}
        onStart={onStart}
      />
    );
  }

  if (page === "talk") {
    return (
      <TalkPage
        audioRef={engine.audioOutRef}
        headerLine={headerLine}
        dgReq={engine.stats.dg_request_id}
        error={engine.error}
        statsLine={statsLine}
        last4={engine.last4}
        onStop={onStop}
        bargeInMode={bargeInMode}
        pttActive={engine.pttActive}
        setPttActive={engine.setPttActive}
      />
    );
  }

  const summary = engine.buildSummaryRows();

  return (
    <LogsPage
      summary={summary}
      messages={engine.messages}
      onExit={onExit}
    />
  );
}
