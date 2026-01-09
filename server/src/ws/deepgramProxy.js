import WebSocket from "ws";

function safeSend(ws, obj) {
  try {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
  } catch {}
}

function buildDeepgramUrl({ model, language }) {
  const u = new URL("wss://api.deepgram.com/v1/listen");

  // Match your previously working STT params (Nova-3 + multi)
  u.searchParams.set("model", model || "nova-3");
  u.searchParams.set("language", language || "multi");

  u.searchParams.set("encoding", "linear16");
  u.searchParams.set("sample_rate", "16000");

  u.searchParams.set("interim_results", "true");
  u.searchParams.set("smart_format", "true");

  // VAD / endpointing (use the SAME style that worked for you)
  u.searchParams.set("vad_events", "true");
  u.searchParams.set("endpointing", "100");
  u.searchParams.set("utterance_end_ms", "1000");

  return u.toString();
}

export function setupDeepgramProxy(wss, config) {
  wss.on("connection", (clientWs, req) => {
    if (!config.DEEPGRAM_API_KEY) {
      safeSend(clientWs, { type: "proxy_error", message: "Missing DEEPGRAM_API_KEY on server" });
      clientWs.close();
      return;
    }

    const reqUrl = new URL(req.url, `http://${req.headers.host}`);
    const model = reqUrl.searchParams.get("model") || "nova-3";
    const language = reqUrl.searchParams.get("language") || "multi";

    const dgUrl = buildDeepgramUrl({ model, language });

    let dgRequestId = null;

    const openedAt = Date.now();
    let dgOpenedAt = null;
    let firstTranscriptAt = null;

    let audioBytesSent = 0;

    // Connect to Deepgram using ws + Authorization header (this is what worked before)
    const dgWs = new WebSocket(dgUrl, {
      headers: { Authorization: `Token ${config.DEEPGRAM_API_KEY}` },
    });

    dgWs.on("upgrade", (res) => {
      dgRequestId = res.headers["dg-request-id"] || null;
      safeSend(clientWs, { type: "dg_open", dg_request_id: dgRequestId });
    });

    dgWs.on("open", () => {
      dgOpenedAt = Date.now();
      // If upgrade didn't fire for any reason, still send open (req id may be null)
      safeSend(clientWs, { type: "dg_open", dg_request_id: dgRequestId });
    });

    // IMPORTANT: show real Deepgram error body (super useful for debugging)
    dgWs.on("unexpected-response", (_request, response) => {
      const dgErr = response.headers["dg-error"];
      const reqId = response.headers["dg-request-id"];
      const status = response.statusCode || null;

      const chunks = [];
      response.on("data", (c) => chunks.push(c));
      response.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf8");

        safeSend(clientWs, {
          type: "proxy_error",
          message: "Deepgram upgrade failed",
          status,
          dg_error: dgErr || null,
          dg_request_id: reqId || null,
          dg_url: dgUrl,
          body: body || null,
        });

        try { clientWs.close(); } catch {}
      });
    });

    dgWs.on("message", (data) => {
      let msg;
      try {
        msg = JSON.parse(data.toString("utf8"));
      } catch {
        return;
      }

      // Deepgram live WS returns { type: "Results", ... }
      if (msg.type === "Results") {
        if (!firstTranscriptAt) {
          firstTranscriptAt = Date.now();
        }

        const alt = msg?.channel?.alternatives?.[0];
        const text = (alt?.transcript || "").trim();
        if (!text) return;

        safeSend(clientWs, {
          type: "transcript",
          text,
          is_final: Boolean(msg.is_final),
          speech_final: Boolean(msg.speech_final),
        });
      }

      // Optional: forward SpeechStarted if you want to observe it (client can ignore)
      if (msg.type === "SpeechStarted") {
        safeSend(clientWs, { type: "speech_started" });
      }
    });

    dgWs.on("close", (code, reason) => {
      safeSend(clientWs, { type: "proxy_error", message: "Deepgram connection closed", dg_error: `${code} ${reason?.toString?.() || ""}` });
      try { clientWs.close(); } catch {}
    });

    dgWs.on("error", (err) => {
      safeSend(clientWs, { type: "proxy_error", message: "Deepgram socket error", dg_error: err?.message || String(err) });
      try { clientWs.close(); } catch {}
    });

    // Keepalive + stats
    const PRICE_PER_MIN_USD = 0.0052;

    const keepAliveTimer = setInterval(() => {
      if (dgWs.readyState === WebSocket.OPEN) {
        dgWs.send(JSON.stringify({ type: "KeepAlive" }));
      }
    }, 5000);

    const statsTimer = setInterval(() => {
      const audioSeconds = audioBytesSent / (2 * 16000);
      const estCostUsd = (audioSeconds / 60) * PRICE_PER_MIN_USD;

      const dgTtfbMs = (dgOpenedAt && firstTranscriptAt) ? (firstTranscriptAt - dgOpenedAt) : null;
      const overallTtfbMs = firstTranscriptAt ? (firstTranscriptAt - openedAt) : null;

      safeSend(clientWs, {
        type: "stats",
        audio_seconds: Number(audioSeconds.toFixed(2)),
        est_cost_usd: Number(estCostUsd.toFixed(6)),
        price_per_min_usd: PRICE_PER_MIN_USD,
        dg_request_id: dgRequestId,
        dg_ttfb_ms: dgTtfbMs,
        overall_ttfb_ms: overallTtfbMs,
      });
    }, 500);

    // Receive audio from browser and forward to Deepgram
    clientWs.on("message", (data, isBinary) => {
      if (isBinary) {
        // Only count bytes we actually send
        if (dgWs.readyState === WebSocket.OPEN) {
          audioBytesSent += data.length;
          dgWs.send(data);
        }
        return;
      }

      // Control messages
      try {
        const msg = JSON.parse(data.toString("utf8"));
        if (msg?.type === "CloseStream") {
          if (dgWs.readyState === WebSocket.OPEN) {
            dgWs.send(JSON.stringify({ type: "CloseStream" }));
          }
        }
      } catch {}
    });

    clientWs.on("close", () => {
      clearInterval(keepAliveTimer);
      clearInterval(statsTimer);

      try {
        if (dgWs.readyState === WebSocket.OPEN) {
          dgWs.send(JSON.stringify({ type: "CloseStream" }));
        }
        dgWs.close();
      } catch {}
    });

    clientWs.on("error", () => {});
  });
}
