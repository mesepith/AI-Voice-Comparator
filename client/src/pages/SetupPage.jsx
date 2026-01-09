import { BARGE_IN_PROFILES } from "../lib/utils";

export default function SetupPage(props) {
  const {
    loading,
    bootError,

    models,
    model,
    setModel,

    // TTS
    voices,
    languages,
    voiceTypes,
    language,
    setLanguage,
    voiceType,
    setVoiceType,
    voiceName,
    setVoiceName,
    audioEncoding,
    setAudioEncoding,
    inputType,
    setInputType,
    speakingRate,
    setSpeakingRate,
    pitch,
    setPitch,
    volumeGainDb,
    setVolumeGainDb,

    // prompt
    systemPrompt,
    setSystemPrompt,
    onUploadPrompt,

    // barge-in
    bargeInMode,
    setBargeInMode,

    canStart,
    onStart,
  } = props;

  return (
    <div className="container">
      <div className="header">
        <h1>AI Voice Demo (Latency Benchmark)</h1>
        <p className="muted">
          Choose your Groq LLM + Google TTS voice. STT is Deepgram Nova-3 (multi).
          Click <b>Start</b> to begin. During conversation, speaking near your mic interrupts AI (“barge-in”).
          If you are in a noisy room, use <b>Push-to-Talk</b>.
        </p>
      </div>

      {bootError ? <div className="error">Boot error: {bootError}</div> : null}

      <div className="card">
        <h2>LLM (Groq)</h2>
        <div className="row">
          <label>Model</label>
          <select value={model} onChange={(e) => setModel(e.target.value)}>
            {models.map((m) => (
              <option key={m} value={m}>{m}</option>
            ))}
          </select>
        </div>
      </div>

      <div className="card">
        <h2>TTS (Google)</h2>

        <div className="row">
          <label>Language</label>
          <select value={language} onChange={(e) => setLanguage(e.target.value)}>
            {languages.map((l) => <option key={l} value={l}>{l}</option>)}
          </select>
        </div>

        <div className="row">
          <label>Voice type</label>
          <select value={voiceType} onChange={(e) => setVoiceType(e.target.value)}>
            {voiceTypes.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
        </div>

        <div className="row">
          <label>Voice name</label>
          <select value={voiceName} onChange={(e) => setVoiceName(e.target.value)}>
            {voices
              .filter((v) => (voiceType ? v.voiceType === voiceType : true))
              .filter((v) => (language ? (v.languageCodes || []).includes(language) : true))
              .map((v) => (
                <option key={v.name} value={v.name}>
                  {v.name}
                </option>
              ))}
          </select>
        </div>

        <div className="row">
          <label>Audio encoding (faster payload = lower latency)</label>
          <select value={audioEncoding} onChange={(e) => setAudioEncoding(e.target.value)}>
            <option value="OGG_OPUS">OGG_OPUS (recommended)</option>
            <option value="MP3">MP3</option>
            <option value="LINEAR16">LINEAR16</option>
            <option value="MULAW">MULAW</option>
          </select>
        </div>

        <div className="row">
          <label>Input type</label>
          <select value={inputType} onChange={(e) => setInputType(e.target.value)}>
            <option value="text">text</option>
            <option value="ssml">ssml</option>
          </select>
        </div>

        <div className="row">
          <label>Volume gain (dB)</label>
          <input
            type="number"
            step="1"
            value={volumeGainDb}
            onChange={(e) => setVolumeGainDb(e.target.value)}
          />
        </div>

        <div className="row">
          <label>Speaking rate (ignored for Chirp HD)</label>
          <input
            type="number"
            step="0.05"
            value={speakingRate}
            onChange={(e) => setSpeakingRate(e.target.value)}
          />
        </div>

        <div className="row">
          <label>Pitch (ignored for Chirp HD)</label>
          <input
            type="number"
            step="1"
            value={pitch}
            onChange={(e) => setPitch(e.target.value)}
          />
        </div>
      </div>

      <div className="card">
        <h2>Prompt</h2>
        <p className="muted">
          Supported upload: <b>.txt</b> only (fast + safe). Paste below or upload.
        </p>

        <div className="row">
          <label>Upload (.txt)</label>
          <input type="file" accept=".txt,text/plain" onChange={onUploadPrompt} />
        </div>

        <textarea
          rows={12}
          value={systemPrompt}
          onChange={(e) => setSystemPrompt(e.target.value)}
          placeholder="Paste your system prompt here..."
        />
      </div>

      <div className="card">
        <h2>Interrupt behavior (Barge-in)</h2>
        <div className="row">
          <label>Mode</label>
          <select value={bargeInMode} onChange={(e) => setBargeInMode(e.target.value)}>
            {Object.entries(BARGE_IN_PROFILES).map(([k, v]) => (
              <option key={k} value={k}>{v.label}</option>
            ))}
          </select>
        </div>
        <p className="muted">
          If background people are talking and AI stops, choose <b>Strict</b>.
          If it still happens, choose <b>Push-to-Talk</b> (only interrupts when you press/hold).
        </p>
      </div>

      <div className="actions">
        <button className="btn primary" disabled={!canStart || loading} onClick={onStart}>
          🎤 Start
        </button>
      </div>
    </div>
  );
}
