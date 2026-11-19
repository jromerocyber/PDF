// Herramientas de página y documento que trabajan sobre los bytes finales.
import { PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFPage, PDFString, StandardFonts, degrees, rgb } from "pdf-lib";
import { hexToRgb } from "./model";
import { safeText } from "./writeAnnots";

const load = (b: Uint8Array) => PDFDocument.load(b, { ignoreEncryption: true, updateMetadata: false });
const save = (d: PDFDocument) => d.save({ updateFieldAppearances: false });

/** Rango tipo "1-3,5,8-" → índices 0-based. Vacío = todas. */
export function parseRange(spec: string, total: number): number[] {
  if (!spec.trim()) return Array.from({ length: total }, (_, i) => i);
  const out = new Set<number>();
  for (const part of spec.split(",")) {
    const m = /^\s*(\d*)\s*(-?)\s*(\d*)\s*$/.exec(part);
    if (!m) continue;
    const a = m[1] ? Number(m[1]) : 1;
    const b = m[2] ? (m[3] ? Number(m[3]) : total) : a;
    for (let i = Math.max(1, a); i <= Math.min(total, b); i++) out.add(i - 1);
  }
  return [...out].sort((x, y) => x - y);
}

/** Caja visible de la página teniendo en cuenta la rotación: devuelve función para colocar en coordenadas "visuales". */
function visual(page: PDFPage) {
  const box = page.getCropBox();
  const rot = ((page.getRotation().angle % 360) + 360) % 360;
  const w = rot % 180 ? box.height : box.width;
  const h = rot % 180 ? box.width : box.height;
  // Convierte (x, y) visual (origen abajo-izquierda de lo que se ve) a espacio de usuario.
  const at = (x: number, y: number): [number, number] => {
    switch (rot) {
      case 90:
        return [box.x + box.width - y, box.y + x];
      case 180:
        return [box.x + box.width - x, box.y + box.height - y];
      case 270:
        return [box.x + y, box.y + box.height - x];
      default:
        return [box.x + x, box.y + y];
    }
  };
  return { w, h, rot, at };
}

export interface WatermarkOpts {
  text?: string;
  image?: { bytes: Uint8Array; png: boolean };
  size: number;
  color: string;
  opacity: number;
  angle: number;
  position: "center" | "tile";
  range: string;
  behind: boolean;
}

export async function addWatermark(bytes: Uint8Array, o: WatermarkOpts): Promise<Uint8Array> {
  const doc = await load(bytes);
  const font = await doc.embedFont(StandardFonts.HelveticaBold);
  const img = o.image ? (o.image.png ? await doc.embedPng(o.image.bytes) : await doc.embedJpg(o.image.bytes)) : null;
  const pages = doc.getPages();
  for (const i of parseRange(o.range, pages.length)) {
    const page = pages[i];
    const v = visual(page);
    const draw = (cx: number, cy: number) => {
      const ang = o.angle + v.rot;
      if (img) {
        const k = (o.size / 100) * Math.min(v.w, v.h) / Math.max(img.width, img.height);
        const w = img.width * k, h = img.height * k;
        const rad = (ang * Math.PI) / 180;
        const [x, y] = v.at(cx, cy);
        page.drawImage(img, { x: x - (w / 2) * Math.cos(rad) + (h / 2) * Math.sin(rad), y: y - (w / 2) * Math.sin(rad) - (h / 2) * Math.cos(rad), width: w, height: h, rotate: degrees(ang), opacity: o.opacity });
      } else if (o.text) {
        const t = safeText(font, o.text);
        const tw = font.widthOfTextAtSize(t, o.size);
        const rad = (ang * Math.PI) / 180;
        const [x, y] = v.at(cx, cy);
        const hh = o.size * 0.35;
        page.drawText(t, {
          x: x - (tw / 2) * Math.cos(rad) + hh * Math.sin(rad),
          y: y - (tw / 2) * Math.sin(rad) - hh * Math.cos(rad),
          size: o.size,
          font,
          color: rgb(...hexToRgb(o.color)),
          rotate: degrees(ang),
          opacity: o.opacity,
        });
      }
    };
    if (o.position === "tile") {
      const step = Math.max(o.size * 6, 150);
      for (let y = step / 2; y < v.h; y += step) for (let x = step / 2; x < v.w; x += step) draw(x, y);
    } else draw(v.w / 2, v.h / 2);
    if (o.behind) moveLastOpsBehind(page);
  }
  return save(doc);
}

/** Mueve el último flujo de contenido añadido al principio (para dibujar detrás). */
function moveLastOpsBehind(page: PDFPage) {
  const contents = page.node.Contents();
  if (contents instanceof PDFArray && contents.size() > 1) {
    const last = contents.get(contents.size() - 1);
    contents.remove(contents.size() - 1);
    contents.insert(0, last);
  }
}

export interface HeaderFooterOpts {
  /** 6 posiciones: arriba izq/centro/der, abajo izq/centro/der. Variables: {n} página, {total}, {fecha}, {archivo} */
  slots: [string, string, string, string, string, string];
  size: number;
  color: string;
  margin: number;
  range: string;
  startAt: number;
  fileName: string;
}

export async function addHeaderFooter(bytes: Uint8Array, o: HeaderFooterOpts): Promise<Uint8Array> {
  const doc = await load(bytes);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const pages = doc.getPages();
  const idx = parseRange(o.range, pages.length);
  const total = idx.length + o.startAt - 1;
  const date = new Date().toLocaleDateString("es-ES");
  idx.forEach((i, k) => {
    const page = pages[i];
    const v = visual(page);
    o.slots.forEach((tpl, s) => {
      if (!tpl.trim()) return;
      const text = safeText(font, tpl.replace(/\{n\}/g, String(k + o.startAt)).replace(/\{total\}/g, String(total)).replace(/\{fecha\}/g, date).replace(/\{archivo\}/g, o.fileName));
      const tw = font.widthOfTextAtSize(text, o.size);
      const col = s % 3;
      const vx = col === 0 ? o.margin : col === 1 ? (v.w - tw) / 2 : v.w - o.margin - tw;
      const vy = s < 3 ? v.h - o.margin - o.size * 0.8 : o.margin;
      const [x, y] = v.at(vx, vy);
      page.drawText(text, { x, y, size: o.size, font, color: rgb(...hexToRgb(o.color)), rotate: degrees(v.rot) });
    });
  });
  return save(doc);
}

export async function addBates(bytes: Uint8Array, prefix: string, start: number, digits: number, suffix: string, position: number, size: number): Promise<Uint8Array> {
  const slots: HeaderFooterOpts["slots"] = ["", "", "", "", "", ""];
  slots[position] = `${prefix}{bates}${suffix}`;
  const doc = await load(bytes);
  const font = await doc.embedFont(StandardFonts.HelveticaBold);
  doc.getPages().forEach((page, i) => {
    const v = visual(page);
    const text = safeText(font, slots[position].replace("{bates}", String(start + i).padStart(digits, "0")));
    const tw = font.widthOfTextAtSize(text, size);
    const col = position % 3;
    const vx = col === 0 ? 24 : col === 1 ? (v.w - tw) / 2 : v.w - 24 - tw;
    const vy = position < 3 ? v.h - 24 - size : 20;
    const [x, y] = v.at(vx, vy);
    page.drawText(text, { x, y, size, font, color: rgb(0, 0, 0), rotate: degrees(v.rot) });
  });
  return save(doc);
}

export async function addBackground(bytes: Uint8Array, color: string, range: string): Promise<Uint8Array> {
  const doc = await load(bytes);
  const pages = doc.getPages();
  for (const i of parseRange(range, pages.length)) {
    const p = pages[i];
    const b = p.getMediaBox();
    p.drawRectangle({ x: b.x, y: b.y, width: b.width, height: b.height, color: rgb(...hexToRgb(color)) });
    moveLastOpsBehind(p);
  }
  return save(doc);
}

/** Recorta márgenes (en puntos, sobre lo que se ve). */
export async function cropPages(bytes: Uint8Array, m: { top: number; right: number; bottom: number; left: number }, range: string): Promise<Uint8Array> {
  const doc = await load(bytes);
  const pages = doc.getPages();
  for (const i of parseRange(range, pages.length)) {
    const p = pages[i];
    const b = p.getCropBox();
    const rot = ((p.getRotation().angle % 360) + 360) % 360;
    // Reasignar márgenes visuales a lados del espacio de usuario.
    const [t, r, bo, l] =
      rot === 90 ? [m.left, m.top, m.right, m.bottom] : rot === 180 ? [m.bottom, m.left, m.top, m.right] : rot === 270 ? [m.right, m.bottom, m.left, m.top] : [m.top, m.right, m.bottom, m.left];
    const w = b.width - l - r, h = b.height - t - bo;
    if (w < 10 || h < 10) throw new Error("Los márgenes son mayores que la página");
    p.setCropBox(b.x + l, b.y + bo, w, h);
  }
  return save(doc);
}

export interface Meta {
  title: string;
  author: string;
  subject: string;
  keywords: string;
  creator: string;
  producer: string;
}

export async function readMeta(bytes: Uint8Array): Promise<Meta & { pages: number; version: string; created?: Date; modified?: Date }> {
  const doc = await load(bytes);
  const head = new TextDecoder("latin1").decode(bytes.subarray(0, 16));
  return {
    title: doc.getTitle() ?? "",
    author: doc.getAuthor() ?? "",
    subject: doc.getSubject() ?? "",
    keywords: doc.getKeywords() ?? "",
    creator: doc.getCreator() ?? "",
    producer: doc.getProducer() ?? "",
    pages: doc.getPageCount(),
    version: /%PDF-(\d\.\d)/.exec(head)?.[1] ?? "?",
    created: doc.getCreationDate(),
    modified: doc.getModificationDate(),
  };
}

export async function writeMeta(bytes: Uint8Array, m: Meta): Promise<Uint8Array> {
  const doc = await load(bytes);
  doc.setTitle(m.title, { showInWindowTitleBar: true });
  doc.setAuthor(m.author);
  doc.setSubject(m.subject);
  doc.setKeywords(m.keywords.split(/[,;]\s*/).filter(Boolean));
  doc.setCreator(m.creator);
  doc.setProducer(m.producer || "PDF Studio");
  doc.setModificationDate(new Date());
  return save(doc);
}

// ---------- Adjuntos ----------

export interface Attachment {
  name: string;
  size: number;
  bytes: Uint8Array;
}

export async function listAttachments(bytes: Uint8Array): Promise<Attachment[]> {
  const { openJs } = await import("./convert");
  const js = await openJs(bytes);
  const att = (await js.getAttachments()) as Record<string, { filename: string; content: Uint8Array }> | null;
  await js.loadingTask.destroy();
  return Object.values(att ?? {}).map((a) => ({ name: a.filename, size: a.content.length, bytes: a.content }));
}

export async function addAttachment(bytes: Uint8Array, file: File): Promise<Uint8Array> {
  const doc = await load(bytes);
  await doc.attach(new Uint8Array(await file.arrayBuffer()), file.name, { mimeType: file.type || "application/octet-stream", creationDate: new Date(file.lastModified), modificationDate: new Date() });
  return save(doc);
}

export async function removeAttachments(bytes: Uint8Array): Promise<Uint8Array> {
  const doc = await load(bytes);
  const names = doc.catalog.lookupMaybe(PDFName.of("Names"), PDFDict);
  names?.delete(PDFName.of("EmbeddedFiles"));
  for (const p of doc.getPages()) {
    const annots = p.node.Annots();
    if (!annots) continue;
    for (let i = annots.size() - 1; i >= 0; i--) {
      const a = annots.lookup(i, PDFDict);
      if (a.get(PDFName.of("Subtype")) === PDFName.of("FileAttachment")) annots.remove(i);
    }
  }
  return save(doc);
}

// ---------- Limpieza ----------

export interface SanitizeOpts {
  metadata: boolean;
  javascript: boolean;
  attachments: boolean;
  links: boolean;
  comments: boolean;
  forms: boolean;
}

export async function sanitize(bytes: Uint8Array, o: SanitizeOpts): Promise<Uint8Array> {
  let doc = await load(bytes);
  const cat = doc.catalog;
  if (o.javascript) {
    cat.delete(PDFName.of("OpenAction"));
    cat.delete(PDFName.of("AA"));
    const names = cat.lookupMaybe(PDFName.of("Names"), PDFDict);
    names?.delete(PDFName.of("JavaScript"));
    for (const [, obj] of doc.context.enumerateIndirectObjects()) {
      if (obj instanceof PDFDict) {
        obj.delete(PDFName.of("AA"));
        const s = obj.get(PDFName.of("S"));
        if (s === PDFName.of("JavaScript") || s === PDFName.of("Launch") || s === PDFName.of("SubmitForm") || s === PDFName.of("ImportData")) obj.set(PDFName.of("S"), PDFName.of("Named")), obj.set(PDFName.of("N"), PDFName.of("NextPage")), obj.delete(PDFName.of("JS"));
      }
    }
  }
  if (o.metadata) {
    const info = doc.context.trailerInfo.Info;
    if (info) doc.context.trailerInfo.Info = doc.context.obj({});
    cat.delete(PDFName.of("Metadata"));
    cat.delete(PDFName.of("PieceInfo"));
    for (const p of doc.getPages()) (p.node.delete(PDFName.of("PieceInfo")), p.node.delete(PDFName.of("Metadata")));
    doc.setProducer("");
    doc.setCreator("");
  }
  if (o.forms) {
    try {
      doc.getForm().flatten();
    } catch {
      /* sin formulario */
    }
  }
  for (const p of doc.getPages()) {
    const annots = p.node.Annots();
    if (!annots) continue;
    for (let i = annots.size() - 1; i >= 0; i--) {
      const a = annots.lookup(i, PDFDict);
      const st = a.get(PDFName.of("Subtype"));
      const isLink = st === PDFName.of("Link");
      const isFile = st === PDFName.of("FileAttachment");
      const isWidget = st === PDFName.of("Widget");
      if ((o.links && isLink) || (o.attachments && isFile) || (o.comments && !isLink && !isWidget && !isFile)) annots.remove(i);
    }
  }
  if (o.attachments) {
    const out = await save(doc);
    doc = await load(await removeAttachments(out));
  }
  return save(doc);
}

// ---------- Comparar ----------

export interface DiffPart {
  type: "same" | "add" | "del";
  text: string;
}

/** Diferencias palabra a palabra (LCS) entre dos textos. */
export function diffWords(a: string, b: string): DiffPart[] {
  const A = a.split(/(\s+)/).filter(Boolean), B = b.split(/(\s+)/).filter(Boolean);
  const n = A.length, m = B.length;
  if (n * m > 4_000_000) return [{ type: "del", text: a }, { type: "add", text: b }];
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out: DiffPart[] = [];
  const push = (type: DiffPart["type"], text: string) => {
    const last = out[out.length - 1];
    if (last && last.type === type) last.text += text;
    else out.push({ type, text });
  };
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (A[i] === B[j]) push("same", A[i++]), j++;
    else if (dp[i + 1][j] >= dp[i][j + 1]) push("del", A[i++]);
    else push("add", B[j++]);
  }
  while (i < n) push("del", A[i++]);
  while (j < m) push("add", B[j++]);
  return out;
}

export { PDFHexString, PDFString };
