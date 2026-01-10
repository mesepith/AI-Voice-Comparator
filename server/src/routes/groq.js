import express from "express";
import { z } from "zod";
import { performance } from "perf_hooks";
import Groq from "groq-sdk";
import { config } from "../config.js";

export const groqRouter = express.Router();

const groq = new Groq({ apiKey: config.GROQ_API_KEY });

// ---------- Models ----------
groqRouter.get("/api/models", async (_req, res) => {
  try {
    const models = await groq.models.list();
    const ids = (models?.data || []).map((m) => m.id).filter(Boolean).sort();
    res.json({ models: ids });
  } catch (e) {
    res.status(500).json({ error: "Failed to fetch Groq models", details: String(e?.message || e) });
  }
});

const ChatSchema = z.object({
  model: z.string().min(1),
  messages: z.array(
    z.object({
      role: z.enum(["system", "user", "assistant"]),
      content: z.string(),
    })
  ).min(1),
  temperature: z.number().min(0).max(2).optional(),
});

// ---------- Non-streaming (kept) ----------
groqRouter.post("/api/chat", async (req, res) => {
  const t0 = performance.now();
  try {
    const parsed = ChatSchema.parse(req.body);

    const completion = await groq.chat.completions.create({
      model: parsed.model,
      messages: parsed.messages,
      temperature: parsed.temperature ?? 0.4,
    });

    const t1 = performance.now();

    res.json({
      model: completion?.model || parsed.model,
      text: completion?.choices?.[0]?.message?.content ?? "",
      wallTimeMs: Math.round(t1 - t0),
      usage: completion?.usage ?? null,
      requestId: completion?.id ?? null,
    });
  } catch (e) {
    res.status(400).json({ error: "LLM failed", details: String(e?.message || e) });
  }
});

// ---------- Streaming SSE (FIXED disconnect logic) ----------
groqRouter.post("/api/chat/stream", async (req, res) => {
  // ✅ Correct way to detect client disconnect for SSE
  let clientGone = false;
  req.on("aborted", () => { clientGone = true; });
  res.on("close", () => { clientGone = true; });

  // SSE headers
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");      // nginx
  res.setHeader("Content-Encoding", "identity"); // avoid compression
  res.flushHeaders?.();

  const send = (event, dataObj) => {
    if (clientGone || res.writableEnded) return;
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(dataObj)}\n\n`);
  };

  // Keepalive (helps some proxies not buffer)
  const keepAlive = setInterval(() => {
    if (!clientGone && !res.writableEnded) res.write(`: keepalive\n\n`);
  }, 15000);

  const serverStart = performance.now();
  let serverFirstDeltaMs = null;

  try {
    const parsed = ChatSchema.parse(req.body);

    // Send meta immediately
    send("meta", { model: parsed.model });

    const upstream = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${config.GROQ_API_KEY}`,
        "Content-Type": "application/json",
        "Accept": "text/event-stream",
      },
      body: JSON.stringify({
        model: parsed.model,
        messages: parsed.messages,
        temperature: parsed.temperature ?? 0.4,
        stream: true,
      }),
    });

    if (!upstream.ok) {
      const txt = await upstream.text().catch(() => "");
      send("error", { message: "Upstream Groq stream failed", status: upstream.status, details: txt });
      clearInterval(keepAlive);
      res.end();
      return;
    }

    if (!upstream.body) {
      send("error", { message: "Upstream response had no body (cannot stream)" });
      clearInterval(keepAlive);
      res.end();
      return;
    }

    // Parse upstream SSE
    const reader = upstream.body.getReader();
    const decoder = new TextDecoder("utf-8");
    let buf = "";

    while (!clientGone) {
      const { value, done } = await reader.read();
      if (done) break;

      buf += decoder.decode(value, { stream: true });
      buf = buf.replace(/\r\n/g, "\n");

      let idx;
      while ((idx = buf.indexOf("\n\n")) !== -1) {
        const raw = buf.slice(0, idx);
        buf = buf.slice(idx + 2);

        const dataLines = [];
        for (const line of raw.split("\n")) {
          if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
        }
        if (!dataLines.length) continue;

        const dataStr = dataLines.join("\n");

        if (dataStr === "[DONE]") {
          const totalMs = performance.now() - serverStart;
          send("done", {
            server_total_ms: Math.round(totalMs),
            server_ttft_ms: serverFirstDeltaMs == null ? null : Math.round(serverFirstDeltaMs),
          });
          clearInterval(keepAlive);
          res.end();
          return;
        }

        let json;
        try { json = JSON.parse(dataStr); } catch { continue; }

        const delta =
          json?.choices?.[0]?.delta?.content ??
          json?.choices?.[0]?.delta?.text ??
          "";

        if (!delta) continue;

        if (serverFirstDeltaMs == null) {
          serverFirstDeltaMs = performance.now() - serverStart;
          send("meta", { server_ttft_ms: Math.round(serverFirstDeltaMs) });
        }

        send("delta", { text: delta });
      }
    }

    // Stream ended without [DONE]
    const totalMs = performance.now() - serverStart;
    send("done", {
      server_total_ms: Math.round(totalMs),
      server_ttft_ms: serverFirstDeltaMs == null ? null : Math.round(serverFirstDeltaMs),
    });
    clearInterval(keepAlive);
    res.end();
  } catch (e) {
    send("error", { message: "LLM stream failed", details: String(e?.message || e) });
    clearInterval(keepAlive);
    res.end();
  }
});
