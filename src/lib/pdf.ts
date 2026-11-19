// Núcleo de documento: carga con PDF.js (Apache-2.0) y exportación con pdf-lib (MIT).
import * as pdfjs from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import type { PDFDocumentProxy } from "pdfjs-dist";
import { PDFDocument, degrees } from "pdf-lib";

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

export interface Source {
  id: string;
  name: string;
  bytes: Uint8Array;
  doc: PDFDocumentProxy;
}

/** Una página del documento de trabajo: o bien viene de un PDF origen, o es una página en blanco. */
export type PageItem =
  | { key: string; kind: "src"; srcId: string; index: number; rotation: number }
  | { key: string; kind: "blank"; width: number; height: number; rotation: number };

let counter = 0;
export const uid = (p = "k") => `${p}${Date.now().toString(36)}${(counter++).toString(36)}`;

export const A4: [number, number] = [595.28, 841.89];

export async function loadSource(file: File | { name: string; bytes: Uint8Array }): Promise<Source> {
  const bytes = file instanceof File ? new Uint8Array(await file.arrayBuffer()) : file.bytes;
  // PDF.js transfiere el buffer al worker; le pasamos una copia para conservar el original.
  const doc = await pdfjs.getDocument({ data: bytes.slice() }).promise;
  return { id: uid("s"), name: file.name, bytes, doc };
}

export function pagesOf(src: Source): PageItem[] {
  return Array.from({ length: src.doc.numPages }, (_, i) => ({
    key: uid(),
    kind: "src" as const,
    srcId: src.id,
    index: i,
    rotation: 0,
  }));
}

/** Construye un PDF nuevo con las páginas indicadas, en ese orden y con sus rotaciones. */
export async function buildPdf(pages: PageItem[], sources: Map<string, Source>): Promise<Uint8Array> {
  const out = await PDFDocument.create();
  const loaded = new Map<string, PDFDocument>();
  for (const p of pages) {
    if (p.kind === "blank") {
      const page = out.addPage([p.width, p.height]);
      page.setRotation(degrees(p.rotation));
      continue;
    }
    let src = loaded.get(p.srcId);
    if (!src) {
      const s = sources.get(p.srcId);
      if (!s) throw new Error("Documento origen no encontrado");
      src = await PDFDocument.load(s.bytes, { ignoreEncryption: true });
      loaded.set(p.srcId, src);
    }
    const [copied] = await out.copyPages(src, [p.index]);
    copied.setRotation(degrees((copied.getRotation().angle + p.rotation) % 360));
    out.addPage(copied);
  }
  return out.save();
}

export function download(bytes: Uint8Array, name: string, type = "application/pdf") {
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** Texto plano de cada página, para la búsqueda. */
export async function pageText(src: Source, index: number): Promise<string> {
  const page = await src.doc.getPage(index + 1);
  const tc = await page.getTextContent();
  return tc.items.map((it) => ("str" in it ? it.str : "")).join(" ");
}
