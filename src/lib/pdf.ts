// Núcleo de documento: carga con PDF.js (Apache-2.0) y exportación con pdf-lib (MIT).
import * as pdfjs from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import type { PDFDocumentProxy } from "pdfjs-dist";
import {
  PDFCheckBox,
  PDFDict,
  PDFDocument,
  PDFDropdown,
  PDFName,
  PDFOptionList,
  PDFPage,
  PDFRadioGroup,
  PDFRef,
  PDFTextField,
  degrees,
} from "pdf-lib";
import type { Annot } from "./model";
import { desktop } from "./desktop";
import { FontCache, writeAnnots, writeFields } from "./writeAnnots";

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

export type PasswordPrompt = (name: string, retry: boolean) => string | null | Promise<string | null>;

/** Carga un PDF. Si está protegido pide la contraseña y lo descifra (para poder editarlo).
 *  Si está dañado intenta repararlo con qpdf. */
export async function loadSource(file: File | { name: string; bytes: Uint8Array }, askPassword?: PasswordPrompt): Promise<Source> {
  let bytes = file instanceof File ? new Uint8Array(await file.arrayBuffer()) : file.bytes;
  const { looksEncrypted, decryptPdf, repairPdf } = await import("./qpdf");
  if (looksEncrypted(bytes)) {
    // Primero sin contraseña (PDFs con solo restricciones de permisos).
    let plain = await decryptPdf(bytes, "");
    let retry = false;
    while (!plain) {
      const pw = askPassword ? await askPassword(file.name, retry) : null;
      if (pw === null) throw new Error("Se necesita la contraseña para abrir el documento");
      plain = await decryptPdf(bytes, pw);
      retry = true;
    }
    bytes = plain;
  }
  let doc: PDFDocumentProxy;
  try {
    // PDF.js transfiere el buffer al worker; le pasamos una copia para conservar el original.
    doc = await pdfjs.getDocument({ data: bytes.slice() }).promise;
    await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
  } catch (e) {
    const fixed = await repairPdf(bytes);
    if (!fixed) throw new Error(`No se puede abrir "${file.name}": el archivo está dañado o no es un PDF`, { cause: e });
    bytes = fixed;
    doc = await pdfjs.getDocument({ data: bytes.slice() }).promise;
  }
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

export interface BuildOptions {
  annots?: Record<string, Annot[]>;
  forms?: Record<string, string | boolean>;
  flattenAnnots?: boolean;
  flattenForms?: boolean;
  /** Quitar la marca de solo lectura de los campos de formulario. */
  unlockForms?: boolean;
  /** Hook para procesar el documento final antes de guardar (redacción, marcas de agua...). */
  post?: (doc: PDFDocument, pages: PageItem[]) => Promise<void>;
}

/** Aplica los valores de formulario de un origen a su documento pdf-lib. */
function applyFormValues(doc: PDFDocument, srcId: string, forms: Record<string, string | boolean>, unlock = false) {
  const prefix = srcId + "|";
  const entries = Object.entries(forms).filter(([k]) => k.startsWith(prefix));
  if (!entries.length && !unlock) return;
  const form = doc.getForm();
  if (unlock) {
    for (const f of form.getFields()) {
      try {
        if (f.isReadOnly()) f.disableReadOnly();
      } catch {
        /* campo raro: se deja como está */
      }
    }
  }
  for (const [k, v] of entries) {
    const field = form.getFieldMaybe(k.slice(prefix.length));
    if (!field) continue;
    try {
      if (field instanceof PDFTextField) field.setText(String(v));
      else if (field instanceof PDFCheckBox) (v ? field.check() : field.uncheck());
      else if (field instanceof PDFRadioGroup) field.select(String(v));
      else if (field instanceof PDFDropdown || field instanceof PDFOptionList) field.select(String(v));
    } catch (e) {
      console.warn("No se pudo rellenar", k, e);
    }
  }
  try {
    form.updateFieldAppearances();
  } catch (e) {
    console.warn(e);
  }
}

/** Construye el PDF con las páginas indicadas, en ese orden, con rotaciones, anotaciones y formularios.
 *  Se parte del documento de la primera página para conservar formularios, marcadores y metadatos. */
export async function buildDoc(pages: PageItem[], sources: Map<string, Source>, opts: BuildOptions = {}): Promise<PDFDocument> {
  const loaded = new Map<string, PDFDocument>();
  const load = async (id: string) => {
    let d = loaded.get(id);
    if (!d) {
      const s = sources.get(id);
      if (!s) throw new Error("Documento origen no encontrado");
      d = await PDFDocument.load(s.bytes, { ignoreEncryption: true, updateMetadata: false });
      if (opts.forms || opts.unlockForms) applyFormValues(d, id, opts.forms ?? {}, !!opts.unlockForms);
      loaded.set(id, d);
    }
    return d;
  };

  const first = pages.find((p) => p.kind === "src");
  const out = first && first.kind === "src" ? await load(first.srcId) : await PDFDocument.create();
  const baseId = first && first.kind === "src" ? first.srcId : null;
  const basePages = out.getPages();
  while (out.getPageCount()) out.removePage(0);
  const used = new Set<number>();
  const fonts = new FontCache(out);

  for (const p of pages) {
    let page: PDFPage;
    if (p.kind === "blank") {
      page = out.addPage([p.width, p.height]);
      page.setRotation(degrees(p.rotation));
    } else {
      if (p.srcId === baseId && !used.has(p.index)) {
        used.add(p.index);
        page = basePages[p.index];
        out.addPage(page);
      } else {
        const src = await load(p.srcId);
        [page] = await out.copyPages(src, [p.index]);
        out.addPage(page);
        if (p.srcId !== baseId) adoptWidgets(out, page);
      }
      page.setRotation(degrees((page.getRotation().angle + p.rotation) % 360));
    }
    const annots = opts.annots?.[p.key];
    if (annots?.length) {
      await writeAnnots(out, page, annots, fonts, !!opts.flattenAnnots);
      writeFields(out, page, annots);
    }
  }
  if (opts.flattenForms) {
    try {
      out.getForm().flatten();
    } catch (e) {
      console.warn(e);
    }
  }
  if (opts.post) await opts.post(out, pages);
  return out;
}

/** Los campos de formulario de páginas copiadas de otro PDF se añaden al formulario del documento. */
function adoptWidgets(doc: PDFDocument, page: PDFPage) {
  const annots = page.node.Annots();
  if (!annots) return;
  const fields: PDFRef[] = [];
  for (let i = 0; i < annots.size(); i++) {
    const ref = annots.get(i);
    if (!(ref instanceof PDFRef)) continue;
    let dict = doc.context.lookup(ref, PDFDict);
    if (dict.get(PDFName.of("Subtype")) !== PDFName.of("Widget")) continue;
    let top = ref;
    while (dict.get(PDFName.of("Parent")) instanceof PDFRef) {
      top = dict.get(PDFName.of("Parent")) as PDFRef;
      dict = doc.context.lookup(top, PDFDict);
    }
    if (!fields.includes(top)) fields.push(top);
  }
  if (!fields.length) return;
  const acro = doc.getForm().acroForm;
  for (const f of fields) acro.addField(f);
}

export async function buildPdf(pages: PageItem[], sources: Map<string, Source>, opts: BuildOptions = {}): Promise<Uint8Array> {
  const doc = await buildDoc(pages, sources, opts);
  return doc.save({ updateFieldAppearances: false });
}

/** Guarda/descarga un archivo. En escritorio abre el diálogo nativo; devuelve false si se cancela. */
export async function download(bytes: Uint8Array, name: string, type = "application/pdf"): Promise<boolean> {
  if (desktop.available) {
    try {
      return await desktop.saveFile(bytes, name);
    } catch (e) {
      throw new Error("No se pudo guardar el archivo: " + (e instanceof Error ? e.message : String(e)));
    }
  }
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  return true;
}

/** Texto plano de cada página, para la búsqueda. */
export async function pageText(src: Source, index: number): Promise<string> {
  const page = await src.doc.getPage(index + 1);
  const tc = await page.getTextContent();
  return tc.items.map((it) => ("str" in it ? it.str : "")).join(" ");
}
