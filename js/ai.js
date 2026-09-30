// Optional on-device AI. Chrome (desktop, recent versions) ships a small model that runs locally;
// text never leaves the device. When it isn't there, the app uses its own statistical summaries.

export async function summarizerStatus() {
  try {
    if (!("Summarizer" in self)) return "unavailable";
    return await self.Summarizer.availability(); // "available" | "downloadable" | "downloading" | "unavailable"
  } catch { return "unavailable"; }
}
export async function promptStatus() {
  try {
    if (!("LanguageModel" in self)) return "unavailable";
    return await self.LanguageModel.availability();
  } catch { return "unavailable"; }
}

export async function aiSummarize(text, context = "", onProgress) {
  const s = await self.Summarizer.create({
    type: "key-points", format: "markdown", length: "medium",
    sharedContext: "Work knowledge-transfer notes written by a business analyst.",
    monitor(m) { m.addEventListener("downloadprogress", e => onProgress?.(e.loaded)); },
  });
  try { return await s.summarize(text.slice(0, 12000), { context }); } finally { s.destroy?.(); }
}

export async function aiAnswer(question, passages, onProgress) {
  const session = await self.LanguageModel.create({
    initialPrompts: [{ role: "system", content: "Answer only from the user's notes provided. Be brief. If the notes don't say, reply that the notes don't cover it." }],
    monitor(m) { m.addEventListener("downloadprogress", e => onProgress?.(e.loaded)); },
  });
  try { return await session.prompt(`NOTES:\n${passages.slice(0, 8000)}\n\nQUESTION: ${question}`); } finally { session.destroy?.(); }
}
