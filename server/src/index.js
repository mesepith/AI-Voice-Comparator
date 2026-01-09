import "dotenv/config";
import http from "http";
import express from "express";
import cors from "cors";
import { WebSocketServer } from "ws";

import { config } from "./config.js";
import { ttsRouter } from "./routes/tts.js";
import { groqRouter } from "./routes/groq.js";
import { setupDeepgramProxy } from "./ws/deepgramProxy.js";

const app = express();

// If you already have bigger limits, keep them
app.use(express.json({ limit: "2mb" }));

app.use(
  cors({
    origin: config.CORS_ORIGIN,
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
    exposedHeaders: config.EXPOSE_HEADERS,
  })
);

app.get("/api/health", (req, res) => res.json({ ok: true }));

app.use(ttsRouter);
app.use(groqRouter);

const server = http.createServer(app);

// WS: /ws (same path you already use)
const wss = new WebSocketServer({ server, path: "/ws" });
setupDeepgramProxy(wss, config);

server.listen(config.PORT, "127.0.0.1", () => {
  console.log(`✅ ai-voice-demo backend listening on http://127.0.0.1:${config.PORT}`);
  console.log(`   REST:  http://127.0.0.1:${config.PORT}/api/health`);
  console.log(`   WS:    ws://127.0.0.1:${config.PORT}/ws`);
});
