// OCR con tesseract.js (Apache-2.0), totalmente local: crea un PDF con texto buscable invisible.
import { PDFDocument, PDFName, StandardFonts, TextRenderingMode, beginText, endText, popGraphicsState, pushGraphicsState, setCharacterSqueeze, setFontAndSize, setTextMatrix, setTextRenderingMode, showText } from "pdf-lib";
import { openJs } from "./convert";
import { safeText } from "./writeAnnots";

export interface OcrOptions {
  langs: string[]; // "spa", "eng"
  dpi: number;
  onlyWithoutText: boolean;
  onProgress?: (msg: string, pct: number) => void;
}

export async function ocrPdf(bytes: Uint8Array, o: OcrOptions): Promise<{ bytes: Uint8Array; pages: number; text: string }> {
  const { createWorker } = await import("tesseract.js");
  const base = new URL(import.meta.env.BASE_URL + "ocr/", location.href).href;
  let curPage = 0, total = 0;
  const worker = await createWorker(o.langs, 1, {
    workerPath: base + "worker.min.js",
    corePath: base + "core",
    langPath: base + "lang",
    gzip: true,
    cacheMethod: "none",
    logger: (m) => {
      if (m.status === "recognizing text") o.onProgress?.(`Reconociendo página ${curPage} de ${total}…`, ((curPage - 1 + m.progress) / total) * 100);
    },
  });
  const js = await openJs(bytes);
  const doc = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
  const font = await doc.embedFont(StandardFonts.Helvetica);
  total = js.numPages;
  let done = 0;
  const allText: string[] = [];
  try {
    for (let n = 1; n <= js.numPages; n++) {
      curPage = n;
      const jp = await js.getPage(n);
      if (o.onlyWithoutText) {
        const tc = await jp.getTextContent();
        const chars = tc.items.reduce((s, it) => s + ("str" in it ? it.str.trim().length : 0), 0);
        if (chars > 20) continue;
      }
      o.onProgress?.(`Preparando página ${n} de ${total}…`, ((n - 1) / total) * 100);
      const vp = jp.getViewport({ scale: o.dpi / 72, rotation: 0 });
      const cv = document.createElement("canvas");
      cv.width = Math.ceil(vp.width);
      cv.height = Math.ceil(vp.height);
      const ctx = cv.getContext("2d")!;
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, cv.width, cv.height);
      await jp.render({ canvas: cv, viewport: vp }).promise;
      const { data } = await worker.recognize(cv, {}, { blocks: true, text: true });
      allText.push(data.text);
      const page = doc.getPage(n - 1);
      const fontKey = page.node.newFontDictionary("FOcr", font.ref);
      const ops = [pushGraphicsState(), beginText(), setTextRenderingMode(TextRenderingMode.Invisible)];
      for (const block of data.blocks ?? []) {
        for (const para of block.paragraphs) {
          for (const line of para.lines) {
            for (const w of line.words) {
              const t = safeText(font, w.text.trim());
              if (!t || w.confidence < 30) continue;
              const [x1, y1] = vp.convertToPdfPoint(w.bbox.x0, w.bbox.y1);
              const [x2, y2] = vp.convertToPdfPoint(w.bbox.x1, w.bbox.y0);
              const h = Math.abs(y2 - y1), wd = Math.abs(x2 - x1);
              if (h < 1 || wd < 1) continue;
              const size = h;
              const natural = font.widthOfTextAtSize(t, size);
              ops.push(setFontAndSize(fontKey, size), setCharacterSqueeze(Math.max(10, Math.min(500, (wd / natural) * 100))), setTextMatrix(1, 0, 0, 1, Math.min(x1, x2), Math.min(y1, y2) + h * 0.2), showText(font.encodeText(t)));
            }
          }
        }
      }
      ops.push(endText(), popGraphicsState());
      page.pushOperators(...ops);
      done++;
    }
  } finally {
    await worker.terminate();
    await js.loadingTask.destroy();
  }
  void PDFName;
  o.onProgress?.("Guardando…", 100);
  return { bytes: await doc.save({ updateFieldAppearances: false }), pages: done, text: allText.join("\n\n") };
}
