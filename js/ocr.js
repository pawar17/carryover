// On-device handwriting/print recognition with Tesseract (runs in your browser via WebAssembly).
// All files are served from this site; the page never contacts another server.

let workerP = null;

function loadScript(src) {
  return new Promise((res, rej) => {
    if (window.Tesseract) return res();
    const s = document.createElement("script"); s.src = src; s.onload = res; s.onerror = () => rej(new Error("ocr_load_failed"));
    document.head.appendChild(s);
  });
}

async function getWorker(onProgress) {
  if (!workerP) {
    workerP = (async () => {
      await loadScript("vendor/tesseract/tesseract.min.js");
      const base = new URL("vendor/tesseract/", location.href).href;
      return window.Tesseract.createWorker("eng", 1, {
        workerPath: base + "worker.min.js",
        corePath: base + "core",
        langPath: base + "lang",
        gzip: true,
        workerBlobURL: false,
        cacheMethod: "none",
        logger: m => onProgress?.(m),
      });
    })().catch(e => { workerP = null; throw e; });
  }
  return workerP;
}

// Load a photo, fix size, rotate, and boost contrast (helps pencil and faint ink).
export async function prepareImage(file, rotate = 0) {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image(); img.decoding = "async";
    await new Promise((r, j) => { img.onload = r; img.onerror = () => j(new Error("image_unreadable")); img.src = url; });
    const long = Math.max(img.naturalWidth, img.naturalHeight);
    const scale = Math.min(2200 / long, long < 1200 ? 1.6 : 1);
    const w = Math.round(img.naturalWidth * scale), h = Math.round(img.naturalHeight * scale);
    const swap = rotate % 180 !== 0;
    const c = document.createElement("canvas"); c.width = swap ? h : w; c.height = swap ? w : h;
    const g = c.getContext("2d");
    g.translate(c.width / 2, c.height / 2); g.rotate(rotate * Math.PI / 180); g.drawImage(img, -w / 2, -h / 2, w, h);
    // keep a colour copy (for you to read) and a cleaned grayscale copy (for the recognizer)
    const photo = c.toDataURL("image/jpeg", 0.72);
    const d = g.getImageData(0, 0, c.width, c.height), px = d.data;
    const hist = new Uint32Array(256);
    for (let i = 0; i < px.length; i += 4) { const y = (px[i] * 0.299 + px[i + 1] * 0.587 + px[i + 2] * 0.114) | 0; px[i] = y; hist[y]++; }
    const total = px.length / 4; let lo = 0, hi = 255, acc = 0;
    for (let i = 0; i < 256; i++) { acc += hist[i]; if (acc > total * 0.02) { lo = i; break; } }
    acc = 0; for (let i = 255; i >= 0; i--) { acc += hist[i]; if (acc > total * 0.02) { hi = i; break; } }
    const span = Math.max(1, hi - lo);
    for (let i = 0; i < px.length; i += 4) { const v = Math.max(0, Math.min(255, ((px[i] - lo) * 255) / span)); px[i] = px[i + 1] = px[i + 2] = v; }
    g.setTransform(1, 0, 0, 1, 0, 0); g.putImageData(d, 0, 0);
    const cleaned = await new Promise(r => c.toBlob(r, "image/png"));
    return { photo, cleaned };
  } finally { URL.revokeObjectURL(url); }
}

// Returns text with low-confidence words wrapped as ⟦word⟧ so you can check them.
export async function recognize(blob, onProgress, threshold = 62) {
  const worker = await getWorker(onProgress);
  const { data } = await worker.recognize(blob, {}, { blocks: true, text: true });
  const lines = [];
  let words = 0, unsure = 0;
  for (const b of data.blocks || []) {
    for (const p of b.paragraphs || []) {
      for (const l of p.lines || []) {
        const ws = (l.words || []).map(w => { words++; if (w.confidence < threshold) { unsure++; return `⟦${w.text}⟧`; } return w.text; });
        if (ws.length) lines.push(ws.join(" "));
      }
    }
    lines.push("");
  }
  const text = (lines.length ? lines.join("\n") : data.text || "").replace(/\n{3,}/g, "\n\n").trim();
  return { text, confidence: Math.round(data.confidence || 0), words, unsure };
}

export async function terminate() { if (workerP) { try { (await workerP).terminate(); } catch {} workerP = null; } }
