import { formatUsd } from "../lib/utils";

export default function TalkPage({
  audioRef,
  headerLine,
  dgReq,
  error,
  stats,
  last4,
  onStop,
  bargeInMode,
  pttActive,
  setPttActive,
}) {
  const statsLine = `DG TTFB ${stats.dg_ttfb_ms ?? "—"} ms • Overall TTFB ${stats.overall_ttfb_ms ?? "—"} ms • Audio streamed ${Number(stats.audio_seconds || 0).toFixed(2)} s • STT est cost ${formatUsd(stats.est_cost_usd || 0)}`;

  return (
    <div className="container">
      <div style={{ fontSize: 28, fontWeight: 900, marginBottom: 10 }}>Live Conversation</div>
      <div className="mono small" style={{ marginBottom: 10 }}>{headerLine}</div>

      <div className="hstack" style={{ justifyContent: "space-between", marginBottom: 12 }}>
        <span className="badge">DG req: <span className="mono">{dgReq || "—"}</span></span>
        <button className="danger" onClick={onStop}>■ Stop</button>
      </div>

      {error ? (
        <div className="card" style={{ marginBottom: 12 }}>
          <div className="error"><b>{error}</b></div>
        </div>
      ) : null}

      <div className="card">
        {/* ✅ Heartbeat circle (matches your app.css) */}
        <div className="heartbeatWrap">
          <div className="heart" aria-label="heartbeat animation" />
        </div>

        <div className="mono small">{statsLine}</div>

        {bargeInMode === "push_to_talk" ? (
          <div style={{ marginTop: 12 }}>
            <div className="small">Push-to-Talk enabled: hold the button to speak.</div>
            <button
              className="secondary"
              onMouseDown={() => setPttActive(true)}
              onMouseUp={() => setPttActive(false)}
              onMouseLeave={() => setPttActive(false)}
              onTouchStart={() => setPttActive(true)}
              onTouchEnd={() => setPttActive(false)}
              style={{ marginTop: 8 }}
            >
              {pttActive ? "🎙️ Talking..." : "🎙️ Hold to Talk"}
            </button>
          </div>
        ) : null}
      </div>

      <audio ref={audioRef} />

      <div className="card" style={{ marginTop: 14 }}>
        <div style={{ fontSize: 22, fontWeight: 900, marginBottom: 10 }}>Last 4 messages</div>
        <div className="msgList">
          {last4.map((m) => (
            <div className="msg" key={m.id}>
              <div className="msgHeader">
                <div className={m.role === "assistant" ? "roleAi" : "roleUser"}>
                  {m.role === "assistant" ? "AI" : "User"}
                </div>

                {m.role === "assistant" ? (
                  <div className="mono small">
                    STT {m.metrics?.stt?.clientMs ?? "—"} ms •
                    LLM {m.metrics?.llm?.clientMs ?? "—"} ms •
                    TTS server {m.metrics?.tts?.serverTtsMs ?? "—"} ms •
                    TTS download {m.metrics?.tts?.clientMs ?? "—"} ms
                  </div>
                ) : (
                  <div className="mono small">
                    STT {m.metrics?.stt?.clientMs ?? "—"} ms
                  </div>
                )}
              </div>

              <div className="msgText">{m.text}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
