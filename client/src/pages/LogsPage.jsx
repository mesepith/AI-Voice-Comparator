import { formatUsd } from "../lib/utils";

export default function LogsPage({ summary, messages, onExit }) {
  return (
    <div className="container">
      <div className="headerRow">
        <div>
          <h1>Timing Logs</h1>
          <div className="muted">Oldest message is at the top. AI messages include STT/LLM/TTS timings.</div>
        </div>
        <button className="btn" onClick={onExit}>← Exit</button>
      </div>

      <div className="card">
        <h2>Session summary</h2>
        <div className="kv mono">
          <div>Session ID</div><div>{summary.sessionId}</div>
          <div>Started</div><div>{summary.started}</div>
          <div>STT</div><div>{summary.stt}</div>
          <div>LLM</div><div>{summary.llm}</div>
          <div>TTS</div><div>{summary.tts}</div>
          <div>DG request id</div><div>{summary.dg_request_id}</div>
          <div>Audio streamed</div><div>{summary.audio_seconds}</div>
          <div>STT est cost</div><div>{summary.stt_est_cost}</div>
          <div>DG TTFB</div><div>{summary.dg_ttfb}</div>
          <div>Overall TTFB</div><div>{summary.overall_ttfb}</div>
        </div>
      </div>

      <div className="card">
        <h2>Conversation log</h2>
        <div className="msgList">
          {messages.map((m) => (
            <div key={m.id} className={`msg ${m.role}`}>
              <div className="msgHeader">
                <div className="role">{m.role === "assistant" ? "AI" : "User"}</div>
                <div className="mono muted">{new Date(m.createdAtMs).toLocaleString()}</div>
              </div>

              <div className="text">{m.text}</div>

              {m.role === "assistant" && m.metrics ? (
                <div className="mono muted" style={{ marginTop: 10 }}>
                  <div>STT {m.metrics?.stt?.clientMs ?? "—"} ms {m.metrics?.stt?.firstResultMs != null ? `(first ${m.metrics.stt.firstResultMs} ms)` : ""}</div>
                  <div>LLM {m.metrics?.llm?.clientMs ?? "—"} ms {m.metrics?.llm?.serverWallMs != null ? `(server ${Math.round(m.metrics.llm.serverWallMs)} ms)` : ""}</div>
                  <div>TTS {m.metrics?.tts?.clientMs ?? "—"} ms {m.metrics?.tts?.serverTtsMs != null ? `(server ${m.metrics.tts.serverTtsMs} ms)` : ""}</div>
                  <div>STT + LLM + TTS {m.metrics?.combinedMs ?? "—"} ms</div>
                  <div>LLM request id {m.metrics?.llm?.requestId ?? "—"}</div>
                  <div>TTS chars / cost {m.metrics?.tts?.charCount ?? "—"} chars • {formatUsd(m.metrics?.tts?.estCostUsd)}</div>
                  <div>TTS encoding {m.metrics?.tts?.encoding ?? "—"}</div>
                  {m.metrics?.tts?.warnings?.length ? (
                    <div>Warnings: {m.metrics.tts.warnings.join(" | ")}</div>
                  ) : null}
                </div>
              ) : null}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
