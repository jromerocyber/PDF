// Firma PAdES mediante actualización incremental: se AÑADEN objetos al final del archivo sin tocar
// los bytes existentes, de modo que las firmas anteriores siguen siendo válidas.
import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFFont,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFObject,
  PDFRef,
  PDFString,
  StandardFonts,
  concatTransformationMatrix,
  degrees,
  drawObject,
  drawText,
  popGraphicsState,
  pushGraphicsState,
  rgb,
} from "pdf-lib";
import type { PDFOperator } from "pdf-lib";
import { buildCms, sha256 } from "./cms";
import type { CmsOptions } from "./cms";
import type { Signer } from "./signer";
import { certInfo } from "./signer";
import { safeText, wrapText } from "../writeAnnots";

export interface SignOptions extends CmsOptions {
  reason?: string;
  location?: string;
  contact?: string;
  /** Página (0-based) y rectángulo en espacio de usuario PDF. Sin rect = firma invisible. */
  page?: number;
  rect?: [number, number, number, number];
  /** Imagen de firma manuscrita para la apariencia (dataURL PNG/JPEG). */
  image?: string;
  /** Texto de la apariencia; por defecto nombre, fecha, motivo. */
  showDetails?: boolean;
  /** Firma de certificación (DocMDP): 1 = sin cambios, 2 = formularios y firmas, 3 = además comentarios. */
  certify?: 1 | 2 | 3;
  fieldName?: string;
  /** Bytes reservados para la firma (la firma CMS en DER debe caber). */
  reserve?: number;
}

const enc = new TextEncoder();
const latin1 = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0) & 0xff);
const str = (u: Uint8Array) => new TextDecoder("latin1").decode(u);

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) (out.set(p, o), (o += p.length));
  return out;
}

const serialize = (obj: PDFObject) => {
  const b = new Uint8Array(obj.sizeInBytes());
  obj.copyBytesInto(b, 0);
  return b;
};

function pdfDate(d: Date): string {
  const p = (n: number) => String(Math.abs(n)).padStart(2, "0");
  const off = -d.getTimezoneOffset();
  return `D:${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}${off >= 0 ? "+" : "-"}${p(Math.trunc(off / 60))}'${p(off % 60)}'`;
}

/** Datos del último tráiler / xref. */
function lastXref(bytes: Uint8Array) {
  const tail = str(bytes.subarray(Math.max(0, bytes.length - 2048)));
  const m = /startxref\s+(\d+)\s+%%EOF\s*$/.exec(tail) ?? [...tail.matchAll(/startxref\s+(\d+)/g)].pop();
  if (!m) throw new Error("PDF sin tabla de referencias (startxref)");
  const offset = Number(m[1]);
  const at = str(bytes.subarray(offset, Math.min(bytes.length, offset + 8192)));
  const isStream = !/^\s*xref/.test(at);
  const size = Number(/\/Size\s+(\d+)/.exec(at)?.[1] ?? 0);
  return { offset, isStream, size };
}

/** Apariencia visible de la firma. */
async function appearance(doc: PDFDocument, signer: Signer, o: SignOptions, w: number, h: number, date: Date): Promise<{ ops: PDFOperator[]; resources: Record<string, unknown> }> {
  const font: PDFFont = await doc.embedFont(StandardFonts.Helvetica);
  const bold: PDFFont = await doc.embedFont(StandardFonts.HelveticaBold);
  await font.embed();
  await bold.embed();
  const resources: Record<string, unknown> = { Font: { F1: font.ref, F2: bold.ref } };
  const ops: PDFOperator[] = [];
  let textX = 4;
  if (o.image) {
    const [head, b64] = o.image.split(",");
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const img = head.includes("png") ? await doc.embedPng(bytes) : await doc.embedJpg(bytes);
    await img.embed();
    resources.XObject = { Im1: img.ref };
    const area = o.showDetails === false ? w - 8 : w * 0.45;
    const k = Math.min(area / img.width, (h - 8) / img.height);
    const iw = img.width * k, ih = img.height * k;
    ops.push(pushGraphicsState(), concatTransformationMatrix(iw, 0, 0, ih, 4 + (area - iw) / 2, (h - ih) / 2), drawObject("Im1"), popGraphicsState());
    textX = area + 8;
  }
  if (o.showDetails !== false) {
    const info = certInfo(signer.certificate);
    const lines: [string, PDFFont][] = [
      ["Firmado digitalmente por", font],
      [info.subjectCN, bold],
      [`Fecha: ${date.toLocaleString("es-ES", { dateStyle: "short", timeStyle: "medium" })}`, font],
    ];
    if (o.reason) lines.push([`Motivo: ${o.reason}`, font]);
    if (o.location) lines.push([`Lugar: ${o.location}`, font]);
    const tw = w - textX - 4;
    // Tamaño de letra que hace caber todo.
    let size = 11;
    const layout = (s: number) => lines.flatMap(([t, f]) => wrapText(f, safeText(f, t), s, tw).map((l) => [l, f] as [string, PDFFont]));
    let wrapped = layout(size);
    while (size > 4 && wrapped.length * size * 1.2 > h - 6) wrapped = layout((size -= 0.5));
    let y = h - 3 - size;
    for (const [line, f] of wrapped) {
      ops.push(...drawText(f.encodeText(line), { color: rgb(0.1, 0.1, 0.1), font: f === bold ? "F2" : "F1", size, x: textX, y, rotate: degrees(0), xSkew: degrees(0), ySkew: degrees(0) }));
      y -= size * 1.2;
    }
  }
  return { ops, resources };
}

/** Firma el PDF y devuelve los bytes firmados. */
export async function signPdf(bytes: Uint8Array, signer: Signer, o: SignOptions = {}): Promise<Uint8Array> {
  const prev = lastXref(bytes);
  const doc = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false, throwOnInvalidObject: false });
  const ctx = doc.context;
  const origSize = Math.max(prev.size, ctx.largestObjectNumber + 1);
  // Los objetos nuevos se numeran a partir del tamaño original.
  ctx.largestObjectNumber = origSize - 1;
  const modified = new Set<PDFRef>();
  const date = new Date();
  const reserve = o.reserve ?? (o.tsaUrl ? 24000 : 14000);

  const pageIdx = Math.min(o.page ?? 0, doc.getPageCount() - 1);
  const page = doc.getPage(pageIdx);
  const rect = o.rect ?? [0, 0, 0, 0];
  const visible = !!o.rect && rect[2] - rect[0] > 1 && rect[3] - rect[1] > 1;

  // --- Diccionario de firma (se escribe a mano para controlar la posición de /Contents y /ByteRange).
  const sigRef = ctx.nextRef();
  const hexText = (s: string) => serialize(PDFHexString.fromText(s));
  const sigParts: Uint8Array[] = [
    latin1(`${sigRef.objectNumber} 0 obj\n<</Type /Sig /Filter /Adobe.PPKLite /SubFilter /ETSI.CAdES.detached /ByteRange [0 0000000000 0000000000 0000000000] /Contents <`),
    latin1("0".repeat(reserve * 2)),
    latin1(`> /M (${pdfDate(date)}) /Name `),
    hexText(certInfo(signer.certificate).subjectCN),
  ];
  if (o.reason) sigParts.push(latin1(" /Reason "), hexText(o.reason));
  if (o.location) sigParts.push(latin1(" /Location "), hexText(o.location));
  if (o.contact) sigParts.push(latin1(" /ContactInfo "), hexText(o.contact));
  if (o.certify) {
    sigParts.push(latin1(` /Reference [<</Type /SigRef /TransformMethod /DocMDP /TransformParams <</Type /TransformParams /P ${o.certify} /V /1.2>>>>]`));
  }
  sigParts.push(latin1(">>\nendobj\n"));
  const sigObjBytes = concat(sigParts);

  // --- Apariencia
  const rot = ((page.getRotation().angle % 360) + 360) % 360;
  const bw = rect[2] - rect[0], bh = rect[3] - rect[1];
  const [vw, vh] = rot % 180 ? [bh, bw] : [bw, bh];
  let apRef: PDFRef;
  if (visible) {
    const { ops, resources } = await appearance(doc, signer, o, vw, vh, date);
    const rad = (rot * Math.PI) / 180;
    const c = Math.round(Math.cos(rad)), s = Math.round(Math.sin(rad));
    apRef = ctx.register(ctx.formXObject(ops, { BBox: [0, 0, vw, vh], Matrix: [c, s, -s, c, 0, 0], Resources: resources } as never));
  } else {
    apRef = ctx.register(ctx.formXObject([], { BBox: [0, 0, 0, 0] } as never));
  }

  // --- Campo de firma / widget
  const acroFormRaw = doc.catalog.get(PDFName.of("AcroForm"));
  let acro: PDFDict;
  if (acroFormRaw instanceof PDFRef) {
    acro = ctx.lookup(acroFormRaw, PDFDict);
    modified.add(acroFormRaw);
  } else {
    acro = acroFormRaw instanceof PDFDict ? acroFormRaw : ctx.obj({});
    const acroRef = ctx.register(acro);
    doc.catalog.set(PDFName.of("AcroForm"), acroRef);
    modified.add(ctx.getObjectRef(doc.catalog)!);
  }
  let fields = acro.lookupMaybe(PDFName.of("Fields"), PDFArray);
  const fieldsRaw = acro.get(PDFName.of("Fields"));
  if (!fields) {
    fields = ctx.obj([]);
    acro.set(PDFName.of("Fields"), fields);
  } else if (fieldsRaw instanceof PDFRef) modified.add(fieldsRaw);

  // Nombre de campo único.
  const existing = new Set<string>();
  for (let i = 0; i < fields.size(); i++) {
    const f = fields.lookup(i);
    if (f instanceof PDFDict) {
      const t = f.lookupMaybe(PDFName.of("T"), PDFString, PDFHexString);
      if (t) existing.add(t.decodeText());
    }
  }
  let name = o.fieldName ?? "Firma1";
  for (let n = 2; existing.has(name); n++) name = `Firma${n}`;

  const widget = ctx.obj({
    Type: "Annot",
    Subtype: "Widget",
    FT: "Sig",
    T: PDFHexString.fromText(name),
    V: sigRef,
    F: 132, // imprimir + bloqueado
    P: page.ref,
    Rect: rect,
    AP: { N: apRef },
  });
  const widgetRef = ctx.register(widget);
  fields.push(widgetRef);
  acro.set(PDFName.of("SigFlags"), PDFNumber.of(3));

  const annotsRaw = page.node.get(PDFName.of("Annots"));
  if (annotsRaw instanceof PDFRef) {
    ctx.lookup(annotsRaw, PDFArray).push(widgetRef);
    modified.add(annotsRaw);
  } else {
    const arr = annotsRaw instanceof PDFArray ? annotsRaw : ctx.obj([]);
    arr.push(widgetRef);
    page.node.set(PDFName.of("Annots"), arr);
    modified.add(page.ref);
  }

  if (o.certify) {
    if (doc.catalog.get(PDFName.of("Perms"))) throw new Error("El documento ya está certificado");
    doc.catalog.set(PDFName.of("Perms"), ctx.obj({ DocMDP: sigRef }));
    modified.add(ctx.getObjectRef(doc.catalog)!);
  }

  // --- Escribir la actualización incremental
  const entries: { num: number; offset: number }[] = [];
  const chunks: Uint8Array[] = [];
  let pos = bytes.length;
  const sep = bytes[bytes.length - 1] === 0x0a || bytes[bytes.length - 1] === 0x0d ? "" : "\n";
  if (sep) (chunks.push(latin1(sep)), (pos += sep.length));
  const emit = (num: number, body: Uint8Array) => {
    entries.push({ num, offset: pos });
    chunks.push(body);
    pos += body.length;
  };
  const objBytes = (ref: PDFRef) => concat([latin1(`${ref.objectNumber} ${ref.generationNumber} obj\n`), serialize(ctx.lookup(ref)!), latin1("\nendobj\n")]);

  for (const ref of modified) emit(ref.objectNumber, objBytes(ref));
  let sigOffsetInUpdate = -1;
  for (const [ref] of ctx.enumerateIndirectObjects()) {
    if (ref.objectNumber < origSize) continue;
    if (ref === sigRef) {
      sigOffsetInUpdate = pos;
      emit(ref.objectNumber, sigObjBytes);
    } else emit(ref.objectNumber, objBytes(ref));
  }
  if (sigOffsetInUpdate < 0) {
    sigOffsetInUpdate = pos;
    emit(sigRef.objectNumber, sigObjBytes);
  }

  const trailer = ctx.trailerInfo;
  const root = trailer.Root as PDFRef;
  const info = trailer.Info as PDFRef | undefined;
  const idArr = trailer.ID instanceof PDFArray ? trailer.ID : null;
  const id0 = idArr ? serialize(idArr.get(0)) : latin1(`<${[...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, "0")).join("")}>`);
  const id1 = latin1(`<${[...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, "0")).join("")}>`);
  const size = Math.max(origSize, ...entries.map((e) => e.num + 1)) + (prev.isStream ? 1 : 0);
  const trailerKeys = `/Size ${size} /Root ${root.objectNumber} ${root.generationNumber} R${info ? ` /Info ${info.objectNumber} ${info.generationNumber} R` : ""} /ID [${str(id0)} ${str(id1)}] /Prev ${prev.offset}`;

  entries.sort((a, b) => a.num - b.num);
  if (!prev.isStream) {
    let xref = "xref\n0 1\n0000000000 65535 f\r\n";
    for (let i = 0; i < entries.length; ) {
      let j = i;
      while (j + 1 < entries.length && entries[j + 1].num === entries[j].num + 1) j++;
      xref += `${entries[i].num} ${j - i + 1}\n`;
      for (let k = i; k <= j; k++) xref += `${String(entries[k].offset).padStart(10, "0")} 00000 n\r\n`;
      i = j + 1;
    }
    xref += `trailer\n<<${trailerKeys}>>\nstartxref\n${pos}\n%%EOF\n`;
    chunks.push(latin1(xref));
  } else {
    // Tabla de referencias como flujo (para PDFs que ya usan xref streams).
    const xrefNum = size - 1;
    entries.push({ num: xrefNum, offset: pos });
    entries.sort((a, b) => a.num - b.num);
    const index: number[] = [];
    const rows: number[] = [];
    for (let i = 0; i < entries.length; ) {
      let j = i;
      while (j + 1 < entries.length && entries[j + 1].num === entries[j].num + 1) j++;
      index.push(entries[i].num, j - i + 1);
      for (let k = i; k <= j; k++) {
        const off = entries[k].offset;
        rows.push(1, (off >>> 24) & 255, (off >>> 16) & 255, (off >>> 8) & 255, off & 255, 0, 0);
      }
      i = j + 1;
    }
    const data = Uint8Array.from(rows);
    const head = latin1(`${xrefNum} 0 obj\n<</Type /XRef ${trailerKeys} /W [1 4 2] /Index [${index.join(" ")}] /Length ${data.length}>>\nstream\n`);
    chunks.push(head, data, latin1(`\nendstream\nendobj\nstartxref\n${pos}\n%%EOF\n`));
  }

  const out = concat([bytes, ...chunks]);

  // --- Rellenar ByteRange y firmar
  const sigText = str(out.subarray(sigOffsetInUpdate, sigOffsetInUpdate + 400));
  const brAt = sigOffsetInUpdate + sigText.indexOf("[0 0000000000 0000000000 0000000000]");
  const contentsStart = sigOffsetInUpdate + sigText.indexOf("/Contents <") + "/Contents ".length; // posición de '<'
  const contentsEnd = contentsStart + 2 + reserve * 2; // tras '>'
  const br = [0, contentsStart, contentsEnd, out.length - contentsEnd];
  const brStr = `[${br.join(" ")}]`.padEnd("[0 0000000000 0000000000 0000000000]".length, " ");
  out.set(latin1(brStr), brAt);

  const signedData = concat([out.subarray(0, contentsStart), out.subarray(contentsEnd)]);
  const digest = await sha256(signedData);
  const cms = await buildCms(signer, digest, o);
  if (cms.length > reserve) {
    return signPdf(bytes, signer, { ...o, reserve: cms.length + 4096 });
  }
  const hex = [...cms].map((b) => b.toString(16).padStart(2, "0")).join("");
  out.set(latin1(hex), contentsStart + 1);
  return out;
}

export { enc };
