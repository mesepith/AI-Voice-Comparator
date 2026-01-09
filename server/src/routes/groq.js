import express from "express";
import { z } from "zod";
import Groq from "groq-sdk";
import { config } from "../config.js";

export const groqRouter = express.Router();

const groq = new Groq({ apiKey: config.GROQ_API_KEY });

groqRouter.get("/api/models", async (req, res) => {
  try {
    // If you already have a static list, you can keep it.
    // Here we use list endpoint if available; else fallback.
    let models = [];
    try {
      const list = await groq.models.list();
      models = (list?.data || []).map((m) => m.id).filter(Boolean);
    } catch {
      models = [
        "meta-llama/llama-4-scout-17b-16e-instruct",
        "llama-3.1-8b-instant",
      ];
    }
    res.json({ models });
  } catch (e) {
    res.status(500).json({ error: "Failed to fetch models", details: String(e?.message || e) });
  }
});

const ChatSchema = z.object({
  model: z.string().min(1),
  messages: z.array(
    z.object({
      role: z.enum(["system", "user", "assistant"]),
      content: z.string(),
    })
  ),
  temperature: z.number().min(0).max(2).optional(),
});

groqRouter.post("/api/chat", async (req, res) => {
  const started = process.hrtime.bigint();
  try {
    const parsed = ChatSchema.parse(req.body);

    const resp = await groq.chat.completions.create({
      model: parsed.model,
      messages: parsed.messages,
      temperature: parsed.temperature ?? 0.4,
    });

    const ended = process.hrtime.bigint();
    const wallTimeMs = Number(ended - started) / 1e6;

    const text = resp?.choices?.[0]?.message?.content ?? "";
    const requestId = resp?.id ?? null;
    const usage = resp?.usage ?? null;

    res.json({ text, wallTimeMs, requestId, usage });
  } catch (e) {
    res.status(400).json({ error: "LLM failed", details: String(e?.message || e) });
  }
});
