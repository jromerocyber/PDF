// Escribe las anotaciones en el PDF con pdf-lib: como anotaciones PDF estándar (editables en
// Acrobat/Foxit/etc.) con su apariencia, o "aplanadas" dentro del contenido de la página.
import {
  PDFArray,
  PDFDocument,
  PDFFont,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFPage,
  PDFString,
  StandardFonts,
  PDFOperator,
  appendBezierCurve,
  closePath,
  drawObject,
  drawText,
  fill,
  fillAndStroke,
  lineTo,
  moveTo,
  popGraphicsState,
  pushGraphicsState,
  rectangle,
  rgb,
  degrees,
  setFillingRgbColor,
  setGraphicsState,
  setLineCap,
  setLineJoin,
  setLineWidth,
  setStrokingRgbColor,
  stroke,
  LineCapStyle,
  LineJoinStyle,
  concatTransformationMatrix,
  PDFDict,
  PDFRef,
} from "pdf-lib";
import type { Annot, FontKey, Rect } from "./model";
import { annotBounds, hexToRgb, pad } from "./model";

const FONT_MAP: Record<FontKey, StandardFonts> = {
  Helvetica: StandardFonts.Helvetica,
  "Helvetica-Bold": StandardFonts.HelveticaBold,
  "Times-Roman": StandardFonts.TimesRoman,
  Courier: StandardFonts.Courier,
};

export class FontCache {
  private fonts = new Map<string, PDFFont>();
  private doc: PDFDocument;
  constructor(doc: PDFDocument) {
    this.doc = doc;
  }
  async get(key: FontKey): Promise<PDFFont> {
    let f = this.fonts.get(key);
    if (!f) {
      f = await this.doc.embedFont(FONT_MAP[key]);
      this.fonts.set(key, f);
    }
    return f;
  }
}

/** Sustituye los caracteres que la fuente estándar (WinAnsi) no puede codificar. */
export function safeText(font: PDFFont, text: string): string {
  let out = "";
  for (const ch of text) {
    try {
      font.encodeText(ch);
      out += ch;
    } catch {
      out += ch === "\t" ? "    " : "?";
    }
  }
  return out;
}

/** Parte el texto en líneas que caben en `width`. */
export function wrapText(font: PDFFont, text: string, size: number, width: number): string[] {
  const lines: string[] = [];
  for (const para of text.split(/\r?\n/)) {
    const words = para.split(/(\s+)/);
    let line = "";
    for (const w of words) {
      const test = line + w;
      if (line && font.widthOfTextAtSize(test.trimEnd(), size) > width) {
        lines.push(line.trimEnd());
        line = w.trimStart();
      } else line = test;
    }
    lines.push(line.trimEnd());
  }
  return lines;
}

const rgbOps = (hex: string, fillToo = true) => {
  const [r, g, b] = hexToRgb(hex);
  return fillToo ? [setStrokingRgbColor(r, g, b), setFillingRgbColor(r, g, b)] : [setStrokingRgbColor(r, g, b)];
};

function dataUrlBytes(url: string): { bytes: Uint8Array; png: boolean } {
  const [head, b64] = url.split(",");
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return { bytes, png: head.includes("png") };
}

interface Appearance {
  ops: PDFOperator[];
  bbox: Rect;
  resources: Record<string, unknown>;
}

async function buildAppearance(doc: PDFDocument, fonts: FontCache, a: Annot): Promise<Appearance> {
  const ops: PDFOperator[] = [];
  const gs: Record<string, unknown> = { Type: "ExtGState", ca: a.opacity, CA: a.opacity };
  const resources: Record<string, unknown> = { ExtGState: { GS0: gs } };
  let bbox = pad(annotBounds(a), 1);
  ops.push(pushGraphicsState(), setGraphicsState("GS0"));

  switch (a.type) {
    case "highlight": {
      gs.BM = "Multiply";
      ops.push(...rgbOps(a.color));
      for (const q of a.quads) ops.push(rectangle(q[0], q[1], q[2] - q[0], q[3] - q[1]));
      ops.push(fill());
      break;
    }
    case "underline":
    case "strike": {
      ops.push(...rgbOps(a.color));
      for (const q of a.quads) {
        const h = q[3] - q[1];
        const y = a.type === "underline" ? q[1] + h * 0.06 : q[1] + h * 0.45;
        ops.push(setLineWidth(Math.max(0.8, h * 0.07)), moveTo(q[0], y), lineTo(q[2], y), stroke());
      }
      break;
    }
    case "ink": {
      ops.push(...rgbOps(a.color, false), setLineWidth(a.width), setLineCap(LineCapStyle.Round), setLineJoin(LineJoinStyle.Round));
      for (const path of a.paths) {
        if (!path.length) continue;
        ops.push(moveTo(path[0][0], path[0][1]));
        if (path.length === 1) ops.push(lineTo(path[0][0] + 0.01, path[0][1]));
        for (let i = 1; i < path.length; i++) ops.push(lineTo(path[i][0], path[i][1]));
        ops.push(stroke());
      }
      break;
    }
    case "rect":
    case "ellipse": {
      const [x1, y1, x2, y2] = a.rect;
      const w = a.width;
      ops.push(...rgbOps(a.color, false), setLineWidth(w));
      if (a.fill) {
        const [r, g, b] = hexToRgb(a.fill);
        ops.push(setFillingRgbColor(r, g, b));
      }
      if (a.type === "rect") {
        ops.push(rectangle(x1 + w / 2, y1 + w / 2, x2 - x1 - w, y2 - y1 - w));
      } else {
        // Elipse con 4 curvas de Bézier.
        const cx = (x1 + x2) / 2, cy = (y1 + y2) / 2;
        const rx = (x2 - x1 - w) / 2, ry = (y2 - y1 - w) / 2;
        const k = 0.5522847498;
        ops.push(
          moveTo(cx + rx, cy),
          appendBezierCurve(cx + rx, cy + ry * k, cx + rx * k, cy + ry, cx, cy + ry),
          appendBezierCurve(cx - rx * k, cy + ry, cx - rx, cy + ry * k, cx - rx, cy),
          appendBezierCurve(cx - rx, cy - ry * k, cx - rx * k, cy - ry, cx, cy - ry),
          appendBezierCurve(cx + rx * k, cy - ry, cx + rx, cy - ry * k, cx + rx, cy),
          closePath(),
        );
      }
      ops.push(a.fill ? fillAndStroke() : stroke());
      break;
    }
    case "line":
    case "arrow": {
      const [x1, y1] = a.a, [x2, y2] = a.b;
      ops.push(...rgbOps(a.color, false), setLineWidth(a.width), setLineCap(LineCapStyle.Round), setLineJoin(LineJoinStyle.Round));
      ops.push(moveTo(x1, y1), lineTo(x2, y2), stroke());
      if (a.type === "arrow") {
        const ang = Math.atan2(y2 - y1, x2 - x1);
        const len = Math.max(8, a.width * 4);
        for (const d of [Math.PI - 0.45, Math.PI + 0.45]) {
          ops.push(moveTo(x2, y2), lineTo(x2 + len * Math.cos(ang + d), y2 + len * Math.sin(ang + d)), stroke());
        }
      }
      break;
    }
    case "text": {
      const font = await fonts.get(a.font);
      resources.Font = { F0: font.ref };
      const [x1, y1, x2, y2] = a.rect;
      if (a.bg) {
        const [r, g, b] = hexToRgb(a.bg);
        ops.push(setFillingRgbColor(r, g, b), rectangle(x1, y1, x2 - x1, y2 - y1), fill());
      }
      if (a.border) {
        ops.push(...rgbOps(a.color, false), setLineWidth(1), rectangle(x1 + 0.5, y1 + 0.5, x2 - x1 - 1, y2 - y1 - 1), stroke());
      }
      const padX = a.bg && a.flatten ? 0 : 3;
      const lines = wrapText(font, safeText(font, a.text), a.size, x2 - x1 - padX * 2);
      const lh = a.size * 1.2;
      const [r, g, b] = hexToRgb(a.color);
      let y = y2 - padX - font.heightAtSize(a.size, { descender: false });
      for (const line of lines) {
        if (y < y1 - a.size) break;
        ops.push(
          ...drawText(font.encodeText(line), {
            color: rgb(r, g, b),
            font: "F0",
            size: a.size,
            x: x1 + padX,
            y,
            rotate: degrees(0),
            xSkew: degrees(0),
            ySkew: degrees(0),
          }),
        );
        y -= lh;
      }
      break;
    }
    case "note": {
      // Icono de nota: bocadillo amarillo.
      const [x, y] = a.at;
      ops.push(...rgbOps(a.color), setLineWidth(1));
      ops.push(rectangle(x, y - 16, 20, 16), fill());
      ops.push(setStrokingRgbColor(0.3, 0.3, 0.3), rectangle(x, y - 16, 20, 16), stroke());
      for (const ly of [y - 5, y - 9, y - 13]) ops.push(moveTo(x + 4, ly), lineTo(x + 16, ly), stroke());
      bbox = [x, y - 20, x + 20, y];
      break;
    }
    case "image": {
      const { bytes, png } = dataUrlBytes(a.dataUrl);
      const img = png ? await doc.embedPng(bytes) : await doc.embedJpg(bytes);
      resources.XObject = { Im0: img.ref };
      const [x1, y1, x2, y2] = a.rect;
      ops.push(concatTransformationMatrix(x2 - x1, 0, 0, y2 - y1, x1, y1), drawObject("Im0"));
      break;
    }
    case "redact":
    case "field":
      break;
  }
  ops.push(popGraphicsState());
  return { ops, bbox, resources };
}

const SUBTYPE: Partial<Record<Annot["type"], string>> = {
  highlight: "Highlight",
  underline: "Underline",
  strike: "StrikeOut",
  ink: "Ink",
  rect: "Square",
  ellipse: "Circle",
  line: "Line",
  arrow: "Line",
  text: "FreeText",
  note: "Text",
  image: "Stamp",
};

const pdfDate = (t: number) => {
  const d = new Date(t);
  const p = (n: number) => String(n).padStart(2, "0");
  return `D:${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
};

/** Añade las anotaciones a la página. `flattenAll` las dibuja todas en el contenido. */
export async function writeAnnots(doc: PDFDocument, page: PDFPage, annots: Annot[], fonts: FontCache, flattenAll: boolean) {
  const ctx = doc.context;
  for (const a of annots) {
    if (a.type === "redact" || a.type === "field") continue;
    const ap = await buildAppearance(doc, fonts, a);
    const xobj = ctx.formXObject(ap.ops, { BBox: ap.bbox, Resources: ap.resources } as never);
    const apRef = ctx.register(xobj);
    const flatten = flattenAll || (a.type === "text" && a.flatten);
    if (flatten) {
      const name = page.node.newXObject("Fl", apRef);
      page.pushOperators(pushGraphicsState(), drawObject(name), popGraphicsState());
      continue;
    }
    const [r, g, b] = hexToRgb(a.color);
    const dict: Record<string, unknown> = {
      Type: "Annot",
      Subtype: SUBTYPE[a.type],
      Rect: ap.bbox,
      C: [r, g, b],
      CA: a.opacity,
      F: 4,
      P: page.ref,
      M: PDFString.of(pdfDate(a.created ?? Date.now())),
      NM: PDFString.of(a.id),
      AP: { N: apRef },
    };
    if (a.author) dict.T = PDFHexString.fromText(a.author);
    switch (a.type) {
      case "highlight":
      case "underline":
      case "strike":
        dict.QuadPoints = a.quads.flatMap((q) => [q[0], q[3], q[2], q[3], q[0], q[1], q[2], q[1]]);
        if (a.text) dict.Contents = PDFHexString.fromText(a.text);
        break;
      case "ink":
        dict.InkList = a.paths.map((p) => p.flat());
        dict.BS = { W: a.width };
        break;
      case "rect":
      case "ellipse":
        dict.BS = { W: a.width };
        if (a.fill) dict.IC = hexToRgb(a.fill);
        break;
      case "line":
      case "arrow":
        dict.L = [...a.a, ...a.b];
        dict.BS = { W: a.width };
        if (a.type === "arrow") dict.LE = ["None", "OpenArrow"];
        break;
      case "text":
        dict.Contents = PDFHexString.fromText(a.text);
        dict.DA = PDFString.of(`/Helv ${a.size} Tf ${r} ${g} ${b} rg`);
        break;
      case "note":
        dict.Contents = PDFHexString.fromText(a.text);
        dict.Name = "Comment";
        dict.Open = false;
        break;
      case "image":
        dict.Name = a.kind === "signature" ? "SignHere" : "Draft";
        break;
    }
    const ref = ctx.register(ctx.obj(dict as never));
    page.node.addAnnot(ref);
  }
}

/** Crea campos de formulario nuevos. */
export function writeFields(doc: PDFDocument, page: PDFPage, annots: Annot[]) {
  const form = doc.getForm();
  for (const a of annots) {
    if (a.type !== "field") continue;
    const [x1, y1, x2, y2] = a.rect;
    const opts = { x: x1, y: y1, width: x2 - x1, height: y2 - y1, borderWidth: 1, borderColor: rgb(0.4, 0.4, 0.4) };
    let name = a.name || "campo";
    let n = 1;
    while (form.getFieldMaybe(name)) name = `${a.name || "campo"}_${n++}`;
    if (a.field === "checkbox") {
      form.createCheckBox(name).addToPage(page, opts);
    } else {
      const tf = form.createTextField(name);
      if (a.field === "multiline") tf.enableMultiline();
      tf.addToPage(page, opts);
    }
  }
}

// Reexportes útiles para otros módulos.
export { PDFArray, PDFDict, PDFName, PDFNumber, PDFRef };
