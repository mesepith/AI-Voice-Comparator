export default function TalkPage({
  audioRef,
  headerLine,
  dgReq,
  error,
  statsLine,
  last4,
  onStop,

  bargeInMode,
  pttActive,
  setPttActive,
}) {
  return (
    <div className="container">
      <div className="header">
        <h1>Live Conversation</h1>
        <div className="mono muted">{headerLine}</div>
      </div>

      <div className="topRow">
        <div className="pill">DG req: {dgReq || "—"}</div>
        <button className="btn danger" onClick={onStop}>■ Stop</button>
      </div>

      {error ? <div className="error">{error}</div> : null}

      <div className="card bigCenter">
        <div className="pulseCircle" />
        <div className="mono muted" style={{ marginTop: 16 }}>
          Metrics: {statsLine}
        </div>

        {bargeInMode === "push_to_talk" ? (
          <div style={{ marginTop: 18 }}>
            <div className="muted">
              Push-to-Talk enabled: Hold the button (or hold Space) to speak.
            </div>
            <button
              className={`btn ${pttActive ? "primary" : ""}`}
              onMouseDown={() => setPttActive(true)}
              onMouseUp={() => setPttActive(false)}
              onMouseLeave={() => setPttActive(false)}
              onTouchStart={() => setPttActive(true)}
              onTouchEnd={() => setPttActive(false)}
              style={{ marginTop: 10 }}
            >
              {pttActive ? "🎙️ Talking..." : "🎙️ Hold to Talk"}
            </button>
          </div>
        ) : null}
      </div>

      <audio ref={audioRef} />

      <div className="card">
        <h2>Last 4 messages</h2>
        <div className="msgList">
          {last4.map((m) => (
            <div key={m.id} className={`msg ${m.role}`}>
              <div className="msgHeader">
                <div className="role">{m.role === "assistant" ? "AI" : "User"}</div>
                {m.role === "assistant" && m.metrics ? (
                  <div className="mono muted">
                    STT {m.metrics?.stt?.clientMs ?? "—"} ms • LLM {m.metrics?.llm?.clientMs ?? "—"} ms • TTS {m.metrics?.tts?.clientMs ?? "—"} ms
                  </div>
                ) : (
                  <div className="mono muted">
                    {m.metrics?.stt?.clientMs ? `STT ${m.metrics.stt.clientMs} ms` : ""}
                  </div>
                )}
              </div>
              <div className="text">{m.text}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
