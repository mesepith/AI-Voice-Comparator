export function createOrderedAudioQueue({ audioOutRef, setError }) {
  const state = {
    isPlaying: false,
    currentUrl: null,
    // queue of items ready to play in order
    playQueue: [],
    // map of completed items waiting for their turn
    readyBySeq: new Map(),
    nextSeq: 0,
  };

  function revokeUrl(url) {
    try { if (url) URL.revokeObjectURL(url); } catch {}
  }

  function reset() {
    // stop audio
    const a = audioOutRef.current;
    if (a) {
      try { a.pause(); a.currentTime = 0; } catch {}
    }

    state.isPlaying = false;
    revokeUrl(state.currentUrl);
    state.currentUrl = null;

    // revoke queued urls
    for (const it of state.playQueue) revokeUrl(it.url);
    state.playQueue = [];

    for (const it of state.readyBySeq.values()) revokeUrl(it.url);
    state.readyBySeq = new Map();

    state.nextSeq = 0;
  }

  function addReadyItem(item) {
    // item: { seq, url, mime, metrics }
    state.readyBySeq.set(item.seq, item);
  }

  function flushToPlayQueue() {
    while (true) {
      const item = state.readyBySeq.get(state.nextSeq);
      if (!item) break;
      state.readyBySeq.delete(state.nextSeq);
      state.playQueue.push(item);
      state.nextSeq += 1;
    }
  }

  async function playNextIfNeeded() {
    if (state.isPlaying) return;

    const a = audioOutRef.current;
    if (!a) return;

    const next = state.playQueue.shift();
    if (!next) return;

    state.isPlaying = true;

    // switch source
    revokeUrl(state.currentUrl);
    state.currentUrl = next.url;

    a.src = next.url;
    a.load();

    try {
      await a.play();
    } catch {
      setError("Audio playback blocked by browser. Click once anywhere, then press Start again.");
      state.isPlaying = false;
      return;
    }

    await new Promise((resolve) => {
      const done = () => {
        a.removeEventListener("ended", done);
        a.removeEventListener("pause", done);
        resolve();
      };
      a.addEventListener("ended", done);
      a.addEventListener("pause", done);
    });

    // finished this one
    state.isPlaying = false;
    revokeUrl(next.url);

    // continue
    await playNextIfNeeded();
  }

  async function onItemCompleted(item) {
    addReadyItem(item);
    flushToPlayQueue();
    await playNextIfNeeded();
  }

  return {
    reset,
    onItemCompleted,
    getState: () => ({
      isPlaying: state.isPlaying,
      nextSeq: state.nextSeq,
      queued: state.playQueue.length,
      waiting: state.readyBySeq.size,
    }),
  };
}
