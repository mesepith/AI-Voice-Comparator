// CRLF-safe SSE reader. Calls onEvent(eventName, dataObj)
export async function readSSE(response, onEvent) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buf = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;

    buf += decoder.decode(value, { stream: true });
    buf = buf.replace(/\r\n/g, "\n");

    let idx;
    while ((idx = buf.indexOf("\n\n")) !== -1) {
      const raw = buf.slice(0, idx);
      buf = buf.slice(idx + 2);

      let event = "message";
      const dataLines = [];

      for (const line of raw.split("\n")) {
        if (line.startsWith(":")) continue;
        if (line.startsWith("event:")) event = line.slice(6).trim();
        if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
      }

      const dataStr = dataLines.join("\n");
      let dataObj = null;
      try {
        dataObj = JSON.parse(dataStr);
      } catch {
        dataObj = { raw: dataStr };
      }

      onEvent(event, dataObj);
    }
  }
}
