// Redacción segura: las páginas con zonas marcadas se convierten en imagen con las zonas en negro.
// Así el texto oculto desaparece de verdad del archivo (no basta con tapar con un rectángulo).
import * as pdfjs from "pdfjs-dist";
import { PDFDocument, PDFName, PDFRawStream, concatTransformationMatrix, drawObject, popGraphicsState, pushGraphicsState } from "pdf-lib";
import type { PageItem, Source } from "./pdf";
import type { Annot, Rect } from "./model";

const DPI = 200;

export async function applyRedactions(doc: PDFDocument, pages: PageItem[], annots: Record<string, Annot[]>, _sources: Map<string, Source>) {
  const targets = pages.map((p, i) => ({ i, rects: (annots[p.key] ?? []).filter((a) => a.type === "redact").map((a) => (a as { rect: Rect }).rect) })).filter((t) => t.rects.length);
  if (!targets.length) return;
  const bytes = await doc.save({ updateFieldAppearances: false });
  const js = await pdfjs.getDocument({ data: bytes }).promise;
  try {
    for (const { i, rects } of targets) {
      const jp = await js.getPage(i + 1);
      const vp = jp.getViewport({ scale: DPI / 72, rotation: 0 });
      const cv = document.createElement("canvas");
      cv.width = Math.ceil(vp.width);
      cv.height = Math.ceil(vp.height);
      const ctx = cv.getContext("2d")!;
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, cv.width, cv.height);
      await jp.render({ canvas: cv, viewport: vp }).promise;
      ctx.fillStyle = "#000";
      for (const r of rects) {
        const [ax, ay] = vp.convertToViewportPoint(r[0], r[1]);
        const [bx, by] = vp.convertToViewportPoint(r[2], r[3]);
        ctx.fillRect(Math.min(ax, bx), Math.min(ay, by), Math.abs(bx - ax), Math.abs(by - ay));
      }
      const jpg = await new Promise<Blob>((res) => cv.toBlob((b) => res(b!), "image/jpeg", 0.9));
      const img = await doc.embedJpg(new Uint8Array(await jpg.arrayBuffer()));
      const page = doc.getPage(i);
      const [vx1, vy1, vx2, vy2] = jp.view; // caja visible (CropBox) en espacio de usuario
      const content = doc.context.flateStream(
        [pushGraphicsState(), concatTransformationMatrix(vx2 - vx1, 0, 0, vy2 - vy1, vx1, vy1), drawObject("Im0"), popGraphicsState()].join("\n"),
      );
      page.node.set(PDFName.of("Contents"), doc.context.register(content));
      page.node.set(PDFName.of("Resources"), doc.context.obj({ XObject: { Im0: img.ref } }));
      page.node.delete(PDFName.of("Annots"));
    }
  } finally {
    await js.loadingTask.destroy();
  }
}

/** Busca un texto en las páginas y devuelve los rectángulos (en puntos PDF) de cada aparición. */
export async function findTextRects(pages: PageItem[], sources: Map<string, Source>, query: string, opts: { caseSensitive?: boolean; regex?: boolean } = {}): Promise<Map<string, Rect[]>> {
  const out = new Map<string, Rect[]>();
  const re = opts.regex ? new RegExp(query, opts.caseSensitive ? "g" : "gi") : null;
  const q = opts.caseSensitive ? query : query.toLowerCase();
  for (const p of pages) {
    if (p.kind !== "src") continue;
    const page = await sources.get(p.srcId)!.doc.getPage(p.index + 1);
    const tc = await page.getTextContent();
    const rects: Rect[] = [];
    for (const it of tc.items) {
      if (!("str" in it) || !it.str) continue;
      const str = opts.caseSensitive ? it.str : it.str.toLowerCase();
      const hits: [number, number][] = [];
      if (re) {
        re.lastIndex = 0;
        for (let m = re.exec(it.str); m; m = re.exec(it.str)) {
          if (!m[0]) break;
          hits.push([m.index, m[0].length]);
        }
      } else if (q) {
        for (let j = str.indexOf(q); j !== -1; j = str.indexOf(q, j + q.length)) hits.push([j, q.length]);
      }
      if (!hits.length) continue;
      const [a, b, , d, e, f] = it.transform as number[];
      const fontH = Math.hypot(b, d) || it.height;
      const horizontal = Math.abs(b) < 0.01;
      for (const [start, len] of hits) {
        const x1 = e + (it.width * start) / it.str.length;
        const x2 = e + (it.width * (start + len)) / it.str.length;
        if (horizontal) rects.push([Math.min(x1, x2) - 1, f - fontH * 0.25, Math.max(x1, x2) + 1, f + fontH * 0.95]);
        else rects.push([e - fontH * 0.25, f, e + fontH, f + it.width]); // texto vertical: aproximación
        void a;
      }
    }
    if (rects.length) out.set(p.key, rects);
  }
  return out;
}

void PDFRawStream;
