import { useEffect, useMemo, useState } from "react";
import "./app.css";

import SetupPage from "./pages/SetupPage";
import TalkPage from "./pages/TalkPage";
import LogsPage from "./pages/LogsPage";
import { useConversationEngine } from "./hooks/useConversationEngine";

export default function App() {
  const engine = useConversationEngine();

  const [page, setPage] = useState("setup"); // setup | talk | logs
  const [loading, setLoading] = useState(false);
  const [bootError, setBootError] = useState("");

  const [models, setModels] = useState([]);
  const [model, setModel] = useState("");

  const [voices, setVoices] = useState([]);
  const [languages, setLanguages] = useState([]);
  const [voiceTypes, setVoiceTypes] = useState([]);

  const [language, setLanguage] = useState("en-US");
  const [voiceType, setVoiceType] = useState("NEURAL2");
  const [voiceName, setVoiceName] = useState("");

  const [audioEncoding, setAudioEncoding] = useState("OGG_OPUS");
  const [inputType, setInputType] = useState("text");
  const [speakingRate, setSpeakingRate] = useState(1.0);
  const [pitch, setPitch] = useState(0);
  const [volumeGainDb, setVolumeGainDb] = useState(0);

  const [systemPrompt, setSystemPrompt] = useState("");
  const [bargeInMode, setBargeInMode] = useState("strict");

  // Boot: models + voices + prompt
  useEffect(() => {
    (async () => {
      try {
        setBootError("");
        setLoading(true);

        const [mRes, vRes, pRes] = await Promise.all([
          fetch("/api/models"),
          fetch("/api/voices"),
          fetch("/prompts/ai-prompt.txt").catch(() => null),
        ]);

        if (mRes.ok) {
          const md = await mRes.json();
          const list = md?.models || [];
          setModels(list);
          setModel(list[0] || "");
        } else {
          setBootError(`Failed to load Groq models (${mRes.status})`);
        }

        if (vRes.ok) {
          const vd = await vRes.json();
          setVoices(vd.voices || []);
          setLanguages(vd.languages || []);
          setVoiceTypes(vd.voiceTypes || []);

          const defaultLang = (vd.languages || []).includes("en-US") ? "en-US" : (vd.languages || [])[0];
          setLanguage(defaultLang || "en-US");

          const types = vd.voiceTypes || [];
          const preferred =
            types.includes("NEURAL2") ? "NEURAL2" :
            types.includes("WAVENET") ? "WAVENET" :
            (types[0] || "OTHER");
          setVoiceType(preferred);
        } else {
          setBootError(`Failed to load Google voices (${vRes.status})`);
        }

        // Default prompt
        if (pRes && pRes.ok) {
          const ct = pRes.headers.get("content-type") || "";
          const txt = await pRes.text();

          // If SPA fallback returns HTML, ignore it.
          if (!ct.includes("text/html") && txt.trim()) {
            setSystemPrompt(txt);
          }
        }
      } catch (e) {
        setBootError(String(e?.message || e));
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  // Auto-pick voiceName when language/type changes
  useEffect(() => {
    const candidates = voices
      .filter((v) => (voiceType ? v.voiceType === voiceType : true))
      .filter((v) => (language ? (v.languageCodes || []).includes(language) : true));

    if (candidates.length && (!voiceName || !candidates.some((v) => v.name === voiceName))) {
      setVoiceName(candidates[0].name);
    }
  }, [voices, language, voiceType]); // eslint-disable-line

  const canStart = useMemo(() => {
    return Boolean(model && voiceName && systemPrompt.trim() && !loading);
  }, [model, voiceName, systemPrompt, loading]);

  function onUploadPrompt(e) {
    const f = e.target.files?.[0];
    if (!f) return;
    if (!f.name.toLowerCase().endsWith(".txt")) {
      alert("Only .txt is supported.");
      return;
    }
    f.text().then((t) => setSystemPrompt(String(t || "")));
  }

  async function onStart() {
    if (!canStart) return;
    setPage("talk");

    await engine.start({
      sttModel: "nova-3",
      sttLanguage: "multi",

      model,
      systemPrompt,

      language,
      voiceType,
      voiceName,

      audioEncoding,
      inputType,
      speakingRate,
      pitch,
      volumeGainDb,

      bargeInMode,
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

  // ✅ Mount ONE audio element always (prevents ref switching/new Audio issues)
  return (
    <>
      <audio ref={engine.audioOutRef} style={{ display: "none" }} />

      {page === "setup" ? (
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
      ) : page === "talk" ? (
        <TalkPage
          headerLine={headerLine}
          dgReq={engine.stats.dg_request_id}
          error={engine.error}
          stats={engine.stats}
          last4={engine.last4}
          onStop={onStop}
          bargeInMode={bargeInMode}
          pttActive={engine.pttActive}
          setPttActive={engine.setPttActive}
        />
      ) : (
        <LogsPage summary={engine.buildSummaryRows()} messages={engine.messages} onExit={onExit} />
      )}
    </>
  );
}
