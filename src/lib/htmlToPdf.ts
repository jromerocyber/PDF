// Maquetador sencillo HTML → PDF (títulos, párrafos, negrita/cursiva/subrayado, listas, tablas, imágenes).
import { PDFDocument, PDFFont, PDFPage, StandardFonts, rgb } from "pdf-lib";
import { safeText } from "./writeAnnots";

interface RunStyle {
  bold: boolean;
  italic: boolean;
  underline: boolean;
  mono: boolean;
  color: [number, number, number];
}
interface Run extends RunStyle {
  text: string;
}

const PAGE: [number, number] = [595.28, 841.89];
const M = 56;

export async function htmlToPdf(html: string, opts: { baseSize?: number } = {}): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const F = {
    r: await doc.embedFont(StandardFonts.Helvetica),
    b: await doc.embedFont(StandardFonts.HelveticaBold),
    i: await doc.embedFont(StandardFonts.HelveticaOblique),
    bi: await doc.embedFont(StandardFonts.HelveticaBoldOblique),
    m: await doc.embedFont(StandardFonts.Courier),
  };
  const fontOf = (s: RunStyle): PDFFont => (s.mono ? F.m : s.bold && s.italic ? F.bi : s.bold ? F.b : s.italic ? F.i : F.r);
  const base = opts.baseSize ?? 11;
  const width = PAGE[0] - 2 * M;
  let page: PDFPage = doc.addPage(PAGE);
  let y = PAGE[1] - M;

  const newPage = () => {
    page = doc.addPage(PAGE);
    y = PAGE[1] - M;
  };
  const ensure = (h: number) => {
    if (y - h < M) newPage();
  };

  /** Escribe runs con ajuste de línea. */
  const flow = (runs: Run[], size: number, x0: number, w: number, lineGap = 1.35, draw = true): number => {
    const words: { text: string; style: Run; width: number; space: boolean }[] = [];
    for (const r of runs) {
      const font = fontOf(r);
      for (const part of r.text.split(/(\s+)/)) {
        if (!part) continue;
        if (/^\s+$/.test(part)) {
          if (part.includes("\n")) words.push({ text: "\n", style: r, width: 0, space: false });
          else words.push({ text: " ", style: r, width: font.widthOfTextAtSize(" ", size), space: true });
        } else {
          const t = safeText(font, part);
          words.push({ text: t, style: r, width: font.widthOfTextAtSize(t, size), space: false });
        }
      }
    }
    const lh = size * lineGap;
    let used = 0;
    let line: typeof words = [];
    let lw = 0;
    const emit = () => {
      while (line.length && line[line.length - 1].space) lw -= line.pop()!.width;
      if (draw) {
        ensure(lh);
        let x = x0;
        for (const wd of line) {
          if (!wd.space) {
            page.drawText(wd.text, { x, y: y - size, size, font: fontOf(wd.style), color: rgb(...wd.style.color) });
            if (wd.style.underline) page.drawLine({ start: { x, y: y - size - 1.5 }, end: { x: x + wd.width, y: y - size - 1.5 }, thickness: 0.6, color: rgb(...wd.style.color) });
          }
          x += wd.width;
        }
        y -= lh;
      }
      used += lh;
      line = [];
      lw = 0;
    };
    for (const wd of words) {
      if (wd.text === "\n") {
        emit();
        continue;
      }
      if (wd.space && !line.length) continue;
      if (lw + wd.width > w && line.length) emit();
      if (wd.space && !line.length) continue;
      line.push(wd);
      lw += wd.width;
    }
    if (line.length) emit();
    return used;
  };

  const defaultStyle: RunStyle = { bold: false, italic: false, underline: false, mono: false, color: [0.1, 0.1, 0.1] };
  const collect = (node: Node, st: RunStyle, out: Run[]) => {
    if (node.nodeType === Node.TEXT_NODE) {
      const t = (node.textContent ?? "").replace(/\s+/g, " ");
      if (t) out.push({ ...st, text: t });
      return;
    }
    if (!(node instanceof HTMLElement)) return;
    const tag = node.tagName.toLowerCase();
    if (tag === "br") return void out.push({ ...st, text: "\n" });
    const s = { ...st };
    if (tag === "b" || tag === "strong" || /^h\d$/.test(tag) || tag === "th") s.bold = true;
    if (tag === "i" || tag === "em") s.italic = true;
    if (tag === "u") s.underline = true;
    if (tag === "code" || tag === "pre" || tag === "kbd") s.mono = true;
    if (tag === "a") (s.color = [0.1, 0.3, 0.8]), (s.underline = true);
    node.childNodes.forEach((c) => collect(c, s, out));
  };

  const images = async (el: HTMLElement) => {
    for (const img of el.querySelectorAll("img")) {
      const src = img.getAttribute("src") ?? "";
      const m = /^data:image\/(png|jpe?g);base64,(.*)$/.exec(src);
      if (!m) continue;
      const bin = Uint8Array.from(atob(m[2]), (c) => c.charCodeAt(0));
      const im = m[1] === "png" ? await doc.embedPng(bin) : await doc.embedJpg(bin);
      const k = Math.min(1, width / (im.width * 0.75), 500 / (im.height * 0.75));
      const w = im.width * 0.75 * k, h = im.height * 0.75 * k;
      ensure(h + 6);
      page.drawImage(im, { x: M, y: y - h, width: w, height: h });
      y -= h + 8;
    }
  };

  const block = async (el: Element, indent = 0, listCtx?: { ordered: boolean; n: number }) => {
    if (!(el instanceof HTMLElement)) return;
    const tag = el.tagName.toLowerCase();
    if (tag === "ul" || tag === "ol") {
      const ctx = { ordered: tag === "ol", n: 1 };
      for (const li of el.children) await block(li, indent + 18, ctx);
      y -= 4;
      return;
    }
    if (tag === "table") {
      const rows = [...el.querySelectorAll("tr")];
      const cols = Math.max(1, ...rows.map((r) => r.children.length));
      const cw = (width - indent) / cols;
      const size = base * 0.9;
      for (const tr of rows) {
        const cells = [...tr.children].map((c) => {
          const runs: Run[] = [];
          collect(c, { ...defaultStyle, bold: c.tagName === "TH" }, runs);
          return runs;
        });
        const h = Math.max(size * 1.6, ...cells.map((r) => flow(r, size, 0, cw - 8, 1.3, false) + 6));
        ensure(h);
        const top = y;
        cells.forEach((runs, i) => {
          const x = M + indent + i * cw;
          page.drawRectangle({ x, y: top - h, width: cw, height: h, borderWidth: 0.5, borderColor: rgb(0.6, 0.6, 0.6) });
          y = top - 3;
          flow(runs, size, x + 4, cw - 8, 1.3);
        });
        y = top - h;
      }
      y -= 8;
      return;
    }
    if (tag === "hr") {
      ensure(10);
      page.drawLine({ start: { x: M, y: y - 5 }, end: { x: M + width, y: y - 5 }, thickness: 0.7, color: rgb(0.7, 0.7, 0.7) });
      y -= 12;
      return;
    }
    if (tag === "img") return images(el.parentElement ?? el);
    const hasBlocks = [...el.children].some((c) => /^(p|div|h\d|ul|ol|table|blockquote|pre|section|article|hr)$/i.test(c.tagName));
    if (hasBlocks && !listCtx) {
      for (const c of el.children) await block(c, indent + (tag === "blockquote" ? 18 : 0));
      return;
    }
    const runs: Run[] = [];
    collect(el, defaultStyle, runs);
    if (tag === "pre") runs.forEach((r) => (r.text = r.text));
    const h = /^h(\d)$/.exec(tag);
    const size = h ? [0, 22, 18, 15, 13, 12, 11][Number(h[1])] : base;
    if (h) y -= size * 0.6;
    if (listCtx) {
      const marker = listCtx.ordered ? `${listCtx.n++}.` : "•";
      ensure(size * 1.4);
      page.drawText(marker, { x: M + indent - 12, y: y - size, size, font: F.r, color: rgb(0.1, 0.1, 0.1) });
    }
    if (runs.some((r) => r.text.trim())) flow(runs, size, M + indent, width - indent);
    await images(el);
    y -= h ? size * 0.4 : size * 0.5;
  };

  const dom = new DOMParser().parseFromString(`<body>${html}</body>`, "text/html");
  const body = dom.body;
  // Texto suelto en el body.
  if (!body.children.length && body.textContent?.trim()) {
    flow([{ ...defaultStyle, text: body.textContent }], base, M, width);
  }
  for (const el of body.children) await block(el);
  return doc.save();
}

/** Texto plano → PDF. */
export async function textToPdf(text: string, mono = false): Promise<Uint8Array> {
  const esc = (s: string) => s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]!);
  const html = text
    .split(/\n{2,}/)
    .map((p) => `<${mono ? "pre" : "p"}>${esc(p).replace(/\n/g, "<br>")}</${mono ? "pre" : "p"}>`)
    .join("");
  return htmlToPdf(html);
}
