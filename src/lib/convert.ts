// Conversiones: imágenes ⇄ PDF, PDF → texto/HTML/Word, compresión.
import * as pdfjs from "pdfjs-dist";
import type { PDFDocumentProxy, TextItem } from "pdfjs-dist/types/src/display/api";
import { PDFDict, PDFDocument, PDFName, PDFNumber, PDFRawStream, decodePDFRawStream } from "pdf-lib";
import { zipSync } from "fflate";
import { loadImage } from "./stamps";

const blobBytes = async (b: Blob) => new Uint8Array(await b.arrayBuffer());
const canvasBlob = (cv: HTMLCanvasElement, type: string, q?: number) => new Promise<Blob>((res) => cv.toBlob((b) => res(b!), type, q));

/** Crea un PDF con una imagen por página (tamaño de página = tamaño de la imagen a 96 ppp, máx. A3). */
export async function imagesToPdf(files: File[], fit: "image" | "a4" = "image"): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  for (const f of files) {
    let bytes = new Uint8Array(await f.arrayBuffer());
    let type = f.type;
    if (type !== "image/jpeg" && type !== "image/png") {
      const url = URL.createObjectURL(f);
      const img = await loadImage(url);
      URL.revokeObjectURL(url);
      const cv = document.createElement("canvas");
      cv.width = img.naturalWidth;
      cv.height = img.naturalHeight;
      cv.getContext("2d")!.drawImage(img, 0, 0);
      bytes = await blobBytes(await canvasBlob(cv, "image/png"));
      type = "image/png";
    }
    const img = type === "image/png" ? await doc.embedPng(bytes) : await doc.embedJpg(bytes);
    let w = img.width * 0.75, h = img.height * 0.75;
    if (fit === "a4") {
      const [pw, ph] = w > h ? [841.89, 595.28] : [595.28, 841.89];
      const k = Math.min((pw - 40) / w, (ph - 40) / h, 1);
      const page = doc.addPage([pw, ph]);
      page.drawImage(img, { x: (pw - w * k) / 2, y: (ph - h * k) / 2, width: w * k, height: h * k });
      continue;
    }
    const k = Math.min(1, 1190 / Math.max(w, h));
    w *= k;
    h *= k;
    doc.addPage([w, h]).drawImage(img, { x: 0, y: 0, width: w, height: h });
  }
  return doc.save();
}

export async function openJs(bytes: Uint8Array): Promise<PDFDocumentProxy> {
  return pdfjs.getDocument({ data: bytes.slice() }).promise;
}

/** Renderiza una página a canvas. */
export async function renderPage(doc: PDFDocumentProxy, n: number, dpi: number, background = "#ffffff"): Promise<HTMLCanvasElement> {
  const page = await doc.getPage(n);
  const vp = page.getViewport({ scale: dpi / 72 });
  const cv = document.createElement("canvas");
  cv.width = Math.ceil(vp.width);
  cv.height = Math.ceil(vp.height);
  const ctx = cv.getContext("2d")!;
  ctx.fillStyle = background;
  ctx.fillRect(0, 0, cv.width, cv.height);
  await page.render({ canvas: cv, viewport: vp }).promise;
  return cv;
}

/** Exporta las páginas como imágenes. Una sola página → archivo; varias → ZIP. */
export async function pdfToImages(bytes: Uint8Array, base: string, format: "png" | "jpeg", dpi: number, onProgress?: (i: number, n: number) => void) {
  const doc = await openJs(bytes);
  const files: Record<string, Uint8Array> = {};
  const ext = format === "png" ? "png" : "jpg";
  for (let i = 1; i <= doc.numPages; i++) {
    onProgress?.(i, doc.numPages);
    const cv = await renderPage(doc, i, dpi);
    files[`${base}_${String(i).padStart(3, "0")}.${ext}`] = await blobBytes(await canvasBlob(cv, `image/${format}`, 0.92));
  }
  await doc.loadingTask.destroy();
  const names = Object.keys(files);
  if (names.length === 1) return { name: names[0], bytes: files[names[0]], type: `image/${format}` };
  return { name: `${base}_imagenes.zip`, bytes: zipSync(files, { level: 0 }), type: "application/zip" };
}

// ---------- Reconstrucción de texto ----------

export interface Line {
  y: number;
  x: number;
  x2: number;
  size: number;
  bold: boolean;
  italic: boolean;
  text: string;
}
export interface Para {
  lines: Line[];
  text: string;
  size: number;
  bold: boolean;
  italic: boolean;
  heading: number; // 0 = párrafo, 1-3 = título
  bullet: boolean;
}

/** Agrupa el texto de una página en líneas y párrafos. */
export async function pageParagraphs(doc: PDFDocumentProxy, n: number): Promise<{ paras: Para[]; width: number; height: number }> {
  const page = await doc.getPage(n);
  const vp = page.getViewport({ scale: 1 });
  const tc = await page.getTextContent();
  const styles = tc.styles as Record<string, { fontFamily: string }>;
  const items = (tc.items.filter((i) => "str" in i) as TextItem[]).filter((i) => i.str.trim() || i.hasEOL);
  const lines: Line[] = [];
  for (const it of items) {
    if (!it.str) continue;
    const [, b, , d, e, f] = it.transform;
    const size = Math.round(Math.hypot(b, d) * 10) / 10 || it.height;
    const [x, y] = vp.convertToViewportPoint(e, f);
    const fname = `${it.fontName} ${styles[it.fontName]?.fontFamily ?? ""}`;
    const bold = /bold|black|heavy|semibold/i.test(fname);
    const italic = /italic|oblique/i.test(fname);
    const last = lines[lines.length - 1];
    if (last && Math.abs(last.y - y) < size * 0.5 && x >= last.x2 - size) {
      const gap = x - last.x2;
      last.text += (gap > size * 0.2 && !last.text.endsWith(" ") && !it.str.startsWith(" ") ? " " : "") + it.str;
      last.x2 = Math.max(last.x2, x + it.width);
      last.size = Math.max(last.size, size);
      last.bold &&= bold;
    } else {
      lines.push({ y, x, x2: x + it.width, size, bold, italic, text: it.str });
    }
  }
  lines.sort((a, b) => a.y - b.y || a.x - b.x);
  const sizes = lines.map((l) => l.size).sort((a, b) => a - b);
  const body = sizes[Math.floor(sizes.length / 2)] || 11;
  const paras: Para[] = [];
  let cur: Line[] = [];
  const flush = () => {
    if (!cur.length) return;
    const text = cur.map((l) => l.text.trim()).reduce((acc, t) => (acc.endsWith("-") ? acc.slice(0, -1) + t : acc ? acc + " " + t : t), "");
    const size = Math.max(...cur.map((l) => l.size));
    const bold = cur.every((l) => l.bold);
    const heading = size >= body * 1.6 ? 1 : size >= body * 1.3 ? 2 : size >= body * 1.12 && bold ? 3 : 0;
    const bullet = /^[•·▪●○◦\-–*]\s|^\d{1,2}[.)]\s/.test(text);
    paras.push({ lines: cur, text, size, bold, italic: cur.every((l) => l.italic), heading, bullet });
    cur = [];
  };
  for (const l of lines) {
    const prev = cur[cur.length - 1];
    if (prev) {
      const gap = l.y - prev.y;
      const newPara = gap > prev.size * 1.8 || Math.abs(l.size - prev.size) > 1.5 || /^[•·▪●○◦\-–*]\s|^\d{1,2}[.)]\s/.test(l.text.trim()) || Math.abs(l.x - prev.x) > prev.size * 3;
      if (newPara) flush();
    }
    cur.push(l);
  }
  flush();
  return { paras, width: vp.width, height: vp.height };
}

export async function pdfToText(bytes: Uint8Array): Promise<string> {
  const doc = await openJs(bytes);
  const out: string[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const { paras } = await pageParagraphs(doc, i);
    out.push(paras.map((p) => p.text).join("\n\n"));
  }
  await doc.loadingTask.destroy();
  return out.join("\n\n\f\n\n");
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

export async function pdfToHtml(bytes: Uint8Array, title: string, withImages: boolean): Promise<string> {
  const doc = await openJs(bytes);
  const parts: string[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const { paras } = await pageParagraphs(doc, i);
    parts.push(`<section class="page" id="p${i}">`);
    if (withImages) {
      const cv = await renderPage(doc, i, 110);
      parts.push(`<img class="snap" alt="Página ${i}" src="${cv.toDataURL("image/jpeg", 0.8)}">`);
    }
    let inList = false;
    for (const p of paras) {
      if (p.bullet && !inList) (parts.push("<ul>"), (inList = true));
      if (!p.bullet && inList) (parts.push("</ul>"), (inList = false));
      const t = esc(p.bullet ? p.text.replace(/^[•·▪●○◦\-–*]\s|^\d{1,2}[.)]\s/, "") : p.text);
      const inner = p.bold && !p.heading ? `<strong>${t}</strong>` : p.italic ? `<em>${t}</em>` : t;
      parts.push(p.heading ? `<h${p.heading}>${t}</h${p.heading}>` : p.bullet ? `<li>${inner}</li>` : `<p>${inner}</p>`);
    }
    if (inList) parts.push("</ul>");
    parts.push("</section>");
  }
  await doc.loadingTask.destroy();
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
<style>body{font-family:system-ui,sans-serif;max-width:820px;margin:auto;padding:24px;line-height:1.5;color:#222}.page{border-bottom:1px dashed #ccc;padding:16px 0}.snap{max-width:100%;border:1px solid #ddd;margin-bottom:12px}</style></head><body>
${parts.join("\n")}
</body></html>`;
}

/** PDF → Word (.docx) con texto editable reconstruido. */
export async function pdfToDocx(bytes: Uint8Array, withSnapshots: boolean, onProgress?: (i: number, n: number) => void): Promise<Uint8Array> {
  const { Document, Packer, Paragraph, TextRun, HeadingLevel, PageBreak, ImageRun, AlignmentType } = await import("docx");
  const doc = await openJs(bytes);
  const children: InstanceType<typeof Paragraph>[] = [];
  let pageW = 595, pageH = 842;
  for (let i = 1; i <= doc.numPages; i++) {
    onProgress?.(i, doc.numPages);
    const { paras, width, height } = await pageParagraphs(doc, i);
    if (i === 1) (pageW = width), (pageH = height);
    if (withSnapshots) {
      const cv = await renderPage(doc, i, 120);
      const data = await blobBytes(await canvasBlob(cv, "image/png"));
      const w = 600, h = Math.round((cv.height / cv.width) * 600);
      children.push(new Paragraph({ alignment: AlignmentType.CENTER, children: [new ImageRun({ type: "png", data, transformation: { width: w, height: h } })] }));
    } else {
      for (const p of paras) {
        const run = new TextRun({ text: p.text, bold: p.bold, italics: p.italic, size: Math.round(p.size * 2) });
        if (p.heading) {
          children.push(new Paragraph({ heading: [HeadingLevel.HEADING_1, HeadingLevel.HEADING_2, HeadingLevel.HEADING_3][p.heading - 1], children: [new TextRun({ text: p.text, bold: true, size: Math.round(p.size * 2) })] }));
        } else if (p.bullet) {
          children.push(new Paragraph({ bullet: { level: 0 }, children: [new TextRun({ text: p.text.replace(/^[•·▪●○◦\-–*]\s/, ""), bold: p.bold, italics: p.italic, size: Math.round(p.size * 2) })] }));
        } else {
          children.push(new Paragraph({ spacing: { after: 120 }, children: [run] }));
        }
      }
    }
    if (i < doc.numPages) children.push(new Paragraph({ children: [new PageBreak()] }));
  }
  await doc.loadingTask.destroy();
  const twip = (pt: number) => Math.round(pt * 20);
  const d = new Document({
    creator: "PDF Studio",
    sections: [{ properties: { page: { size: { width: twip(pageW), height: twip(pageH) }, margin: { top: 1000, bottom: 1000, left: 1000, right: 1000 } } }, children }],
  });
  return new Uint8Array(await (await Packer.toBlob(d)).arrayBuffer());
}

/** Word (.docx) → PDF: mammoth convierte a HTML y nuestro maquetador lo pasa a PDF. */
export async function docxToPdf(file: File): Promise<Uint8Array> {
  const mammoth = await import("mammoth");
  const { value } = await mammoth.convertToHtml({ arrayBuffer: await file.arrayBuffer() });
  const { htmlToPdf } = await import("./htmlToPdf");
  return htmlToPdf(value);
}

// ---------- Compresión ----------

export interface CompressResult {
  bytes: Uint8Array;
  images: number;
}

/** Reduce el tamaño: recomprime imágenes (JPEG) a la resolución indicada y optimiza la estructura. */
export async function compressPdf(bytes: Uint8Array, quality: number, maxDpi: number): Promise<CompressResult> {
  const doc = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
  let images = 0;
  // Tamaño máximo de página para estimar la resolución.
  const maxPagePt = Math.max(...doc.getPages().map((p) => Math.max(p.getWidth(), p.getHeight())), 842);
  const maxPx = Math.round((maxPagePt / 72) * maxDpi);
  for (const [ref, obj] of doc.context.enumerateIndirectObjects()) {
    if (!(obj instanceof PDFRawStream)) continue;
    const dict = obj.dict;
    if (dict.get(PDFName.of("Subtype")) !== PDFName.of("Image")) continue;
    if (dict.get(PDFName.of("SMask")) || dict.get(PDFName.of("Mask")) || dict.get(PDFName.of("ImageMask"))) continue;
    const filter = dict.get(PDFName.of("Filter"));
    const fname = filter instanceof PDFName ? filter.asString() : filter?.toString() ?? "";
    const w = (dict.get(PDFName.of("Width")) as PDFNumber).asNumber();
    const h = (dict.get(PDFName.of("Height")) as PDFNumber).asNumber();
    if (w * h < 40000) continue; // imágenes pequeñas: no merece la pena
    let source: CanvasImageSource | null = null;
    try {
      if (fname === "/DCTDecode") {
        source = await createImageBitmap(new Blob([obj.contents as BlobPart], { type: "image/jpeg" }));
      } else if (fname === "/FlateDecode" && !dict.get(PDFName.of("DecodeParms"))) {
        const cs = dict.get(PDFName.of("ColorSpace"));
        const bpc = (dict.get(PDFName.of("BitsPerComponent")) as PDFNumber)?.asNumber();
        const comps = cs === PDFName.of("DeviceRGB") ? 3 : cs === PDFName.of("DeviceGray") ? 1 : 0;
        if (!comps || bpc !== 8) continue;
        const raw = decodePDFRawStream(obj).decode();
        if (raw.length < w * h * comps) continue;
        const id = new ImageData(w, h);
        for (let i = 0, j = 0; i < w * h; i++, j += comps) {
          id.data[i * 4] = raw[j];
          id.data[i * 4 + 1] = raw[comps === 3 ? j + 1 : j];
          id.data[i * 4 + 2] = raw[comps === 3 ? j + 2 : j];
          id.data[i * 4 + 3] = 255;
        }
        source = await createImageBitmap(id);
      } else continue;
    } catch {
      continue;
    }
    const k = Math.min(1, maxPx / Math.max(w, h));
    const nw = Math.max(1, Math.round(w * k)), nh = Math.max(1, Math.round(h * k));
    const cv = document.createElement("canvas");
    cv.width = nw;
    cv.height = nh;
    const ctx = cv.getContext("2d")!;
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, nw, nh);
    ctx.drawImage(source, 0, 0, nw, nh);
    const jpg = await blobBytes(await canvasBlob(cv, "image/jpeg", quality));
    if (jpg.length >= obj.contents.length) continue;
    const nd = PDFDict.withContext(doc.context);
    nd.set(PDFName.of("Type"), PDFName.of("XObject"));
    nd.set(PDFName.of("Subtype"), PDFName.of("Image"));
    nd.set(PDFName.of("Width"), PDFNumber.of(nw));
    nd.set(PDFName.of("Height"), PDFNumber.of(nh));
    nd.set(PDFName.of("ColorSpace"), PDFName.of("DeviceRGB"));
    nd.set(PDFName.of("BitsPerComponent"), PDFNumber.of(8));
    nd.set(PDFName.of("Filter"), PDFName.of("DCTDecode"));
    nd.set(PDFName.of("Length"), PDFNumber.of(jpg.length));
    doc.context.assign(ref, PDFRawStream.of(nd, jpg));
    images++;
  }
  const saved = await doc.save({ useObjectStreams: true, updateFieldAppearances: false });
  const { optimizePdf } = await import("./qpdf");
  const opt = await optimizePdf(saved);
  const best = [bytes, saved, opt].reduce((a, b) => (b.length < a.length ? b : a));
  return { bytes: best, images };
}
