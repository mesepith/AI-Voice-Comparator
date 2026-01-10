// Decide when to cut a "speakable chunk" from streaming LLM text.
export function extractSpeakChunk(buffer) {
  const text = buffer.trim();
  if (!text) return { chunk: null, rest: buffer };

  // Prefer sentence endings first
  const sentenceEnd = /[.!?]|[।]/g;
  let lastEnd = -1;
  let m;
  while ((m = sentenceEnd.exec(text)) !== null) lastEnd = m.index;

  // If we have a sentence boundary and enough text, speak up to it.
  if (lastEnd >= 20) {
    const cutPos = lastEnd + 1;
    return {
      chunk: text.slice(0, cutPos).trim(),
      rest: text.slice(cutPos).trimStart(),
    };
  }

  // Else speak when long enough (phrase chunk)
  const TARGET_CHARS = 90;
  if (text.length >= TARGET_CHARS) {
    const soft = Math.max(text.lastIndexOf(","), text.lastIndexOf(";"));
    if (soft > 40) {
      const cutPos = soft + 1;
      return { chunk: text.slice(0, cutPos).trim(), rest: text.slice(cutPos).trimStart() };
    }
    const sp = text.lastIndexOf(" ");
    if (sp > 50) {
      return { chunk: text.slice(0, sp).trim(), rest: text.slice(sp).trimStart() };
    }
    return { chunk: text.trim(), rest: "" };
  }

  return { chunk: null, rest: buffer };
}
