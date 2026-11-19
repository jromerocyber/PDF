// Escribe los marcadores (outline) del documento.
import { PDFDict, PDFDocument, PDFHexString, PDFName, PDFNull, PDFNumber, PDFRef } from "pdf-lib";

export interface Bookmark {
  title: string;
  page: number; // 1-based
  level: number;
}

export async function writeOutline(bytes: Uint8Array, items: Bookmark[]): Promise<Uint8Array> {
  const doc = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
  const ctx = doc.context;
  const pages = doc.getPages();
  if (!items.length) {
    doc.catalog.delete(PDFName.of("Outlines"));
    return doc.save({ updateFieldAppearances: false });
  }
  const rootRef = ctx.nextRef();
  interface Node { ref: PDFRef; dict: PDFDict; children: Node[]; parent: Node | null }
  const root: Node = { ref: rootRef, dict: ctx.obj({ Type: "Outlines" }), children: [], parent: null };
  const stack: Node[] = [root];
  for (const it of items) {
    const level = Math.min(it.level, stack.length - 1);
    stack.length = level + 1;
    const parent = stack[level];
    const page = pages[Math.min(Math.max(1, it.page), pages.length) - 1];
    const dict = ctx.obj({});
    dict.set(PDFName.of("Title"), PDFHexString.fromText(it.title || "(sin título)"));
    dict.set(PDFName.of("Dest"), ctx.obj([page.ref, PDFName.of("XYZ"), PDFNull, PDFNull, PDFNull]));
    const node: Node = { ref: ctx.nextRef(), dict, children: [], parent };
    parent.children.push(node);
    stack.push(node);
  }
  const link = (n: Node): number => {
    let count = 0;
    n.children.forEach((c, i) => {
      c.dict.set(PDFName.of("Parent"), n.ref);
      if (i > 0) c.dict.set(PDFName.of("Prev"), n.children[i - 1].ref);
      if (i < n.children.length - 1) c.dict.set(PDFName.of("Next"), n.children[i + 1].ref);
      count += 1 + link(c);
    });
    if (n.children.length) {
      n.dict.set(PDFName.of("First"), n.children[0].ref);
      n.dict.set(PDFName.of("Last"), n.children[n.children.length - 1].ref);
      n.dict.set(PDFName.of("Count"), PDFNumber.of(n === root ? count : n.children.length));
    }
    ctx.assign(n.ref, n.dict);
    return count;
  };
  link(root);
  doc.catalog.set(PDFName.of("Outlines"), rootRef);
  doc.catalog.set(PDFName.of("PageMode"), PDFName.of("UseOutlines"));
  return doc.save({ updateFieldAppearances: false });
}
