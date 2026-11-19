import { useEffect, useMemo, useState } from "react";
import { Modal } from "./components/Modal";
import { download, loadSource } from "./lib/pdf";
import type { PageItem, Source, PasswordPrompt } from "./lib/pdf";
import type { Annot, DocState } from "./lib/model";
import { uid } from "./lib/pdf";
import { loadSaved } from "./components/SignaturePad";
import { desktop } from "./lib/desktop";
import { askConfirm } from "./components/Dialogs";

export type PanelId =
  | "print" | "crop" | "properties" | "outline" | "watermark" | "headerfooter" | "bates" | "background" | "attachments" | "compare"
  | "formdata" | "sign" | "verify" | "encrypt" | "decrypt" | "redactsearch" | "sanitize"
  | "toimages" | "toword" | "totext" | "tohtml" | "fromword" | "fromtext" | "ocr" | "compress";

export interface PanelCtx {
  pages: PageItem[];
  sources: Map<string, Source>;
  doc: DocState;
  fileName: string;
  current: number;
  selectedPages: PageItem[];
  commit: (fn: (d: DocState) => DocState) => void;
  addSources: (s: Source[], append: boolean, name?: string) => void;
  replaceDoc: (bytes: Uint8Array) => Promise<void>;
  currentBytes: () => Promise<Uint8Array>;
  /** Bytes para firmar/verificar: el original si no se ha modificado (conserva firmas previas). */
  pristineBytes: () => Promise<{ bytes: Uint8Array; pristine: boolean }>;
  run: (label: string, fn: () => Promise<void>) => Promise<void>;
  /** Actualiza el mensaje de progreso de la tarea en curso. */
  progress: (msg: string) => void;
  notify: (m: string) => void;
  close: () => void;
  setError: (e: string | null) => void;
  askPassword: PasswordPrompt;
  goTo: (i: number) => void;
}

const base = (n: string) => n.replace(/\.pdf$/i, "");
const fmtSize = (n: number) => (n > 1048576 ? `${(n / 1048576).toFixed(2)} MB` : `${Math.round(n / 1024)} KB`);
const fileBytes = async (f: File) => new Uint8Array(await f.arrayBuffer());
/** Guardar desde un botón (fuera de una tarea): muestra errores y progreso. */
const saveAs = (ctx: PanelCtx, bytes: Uint8Array, name: string, type?: string) =>
  void ctx.run("Guardando…", async () => {
    await download(bytes, name, type);
  });

export function Panels({ id, ctx }: { id: PanelId; ctx: PanelCtx }) {
  const C = PANELS[id];
  return <C ctx={ctx} />;
}

type P = { ctx: PanelCtx };

const Field = ({ label, children }: { label: string; children: React.ReactNode }) => (
  <label className="field">
    <span>{label}</span>
    {children}
  </label>
);

// ---------------------------------------------------------------- Imprimir
function PrintPanel({ ctx }: P) {
  const [range, setRange] = useState("");
  const [dpi, setDpi] = useState(150);
  const go = () =>
    ctx.run("Preparando impresión…", async () => {
      const { openJs, renderPage } = await import("./lib/convert");
      const { parseRange } = await import("./lib/tools");
      const js = await openJs(await ctx.currentBytes());
      const idx = parseRange(range, js.numPages);
      const imgs: string[] = [];
      for (const i of idx) imgs.push((await renderPage(js, i + 1, dpi)).toDataURL("image/jpeg", 0.92));
      await js.loadingTask.destroy();
      const frame = document.createElement("iframe");
      frame.style.cssText = "position:fixed;right:0;bottom:0;width:0;height:0;border:0";
      document.body.appendChild(frame);
      const d = frame.contentDocument!;
      d.open();
      d.write(`<!doctype html><html><head><style>@page{margin:0}body{margin:0}img{display:block;width:100%;page-break-after:always;break-after:page}</style></head><body>${imgs.map((s) => `<img src="${s}">`).join("")}</body></html>`);
      d.close();
      await Promise.all([...d.images].map((im) => (im.complete ? 0 : new Promise((r) => (im.onload = r)))));
      frame.contentWindow!.focus();
      frame.contentWindow!.print();
      setTimeout(() => frame.remove(), 60_000);
      ctx.close();
    });
  return (
    <Modal title="Imprimir" onClose={ctx.close}>
      <Field label="Páginas (vacío = todas, p. ej. 1-3,5)"><input value={range} onChange={(e) => setRange(e.target.value)} placeholder="Todas" /></Field>
      <Field label="Calidad">
        <select value={dpi} onChange={(e) => setDpi(Number(e.target.value))}>
          <option value={100}>Borrador (100 ppp)</option>
          <option value={150}>Normal (150 ppp)</option>
          <option value={300}>Alta (300 ppp)</option>
        </select>
      </Field>
      <p className="muted small">Se imprimen las páginas con sus comentarios y formularios tal como se ven.</p>
      <div className="row end"><button className="primary" onClick={go}>Imprimir</button></div>
    </Modal>
  );
}

// ---------------------------------------------------------------- Recortar
function CropPanel({ ctx }: P) {
  const [m, setM] = useState({ top: 20, right: 20, bottom: 20, left: 20 });
  const [range, setRange] = useState("");
  const [unit, setUnit] = useState<"mm" | "pt">("mm");
  const k = unit === "mm" ? 72 / 25.4 : 1;
  const go = () =>
    ctx.run("Recortando…", async () => {
      const { cropPages } = await import("./lib/tools");
      await ctx.replaceDoc(await cropPages(await ctx.currentBytes(), { top: m.top * k, right: m.right * k, bottom: m.bottom * k, left: m.left * k }, range));
      ctx.close();
    });
  return (
    <Modal title="Recortar páginas" onClose={ctx.close}>
      <div className="grid2">
        {(["top", "bottom", "left", "right"] as const).map((s) => (
          <Field key={s} label={{ top: "Arriba", bottom: "Abajo", left: "Izquierda", right: "Derecha" }[s]}>
            <input type="number" min={0} value={m[s]} onChange={(e) => setM({ ...m, [s]: Number(e.target.value) })} />
          </Field>
        ))}
      </div>
      <div className="grid2">
        <Field label="Unidades"><select value={unit} onChange={(e) => setUnit(e.target.value as "mm" | "pt")}><option value="mm">mm</option><option value="pt">puntos</option></select></Field>
        <Field label="Páginas"><input value={range} onChange={(e) => setRange(e.target.value)} placeholder="Todas" /></Field>
      </div>
      <div className="row end"><button className="primary" onClick={go}>Recortar</button></div>
    </Modal>
  );
}

// ---------------------------------------------------------------- Propiedades
function PropertiesPanel({ ctx }: P) {
  const [meta, setMeta] = useState<Awaited<ReturnType<typeof import("./lib/tools").readMeta>> | null>(null);
  const [size, setSize] = useState(0);
  useEffect(() => {
    (async () => {
      const { readMeta } = await import("./lib/tools");
      const b = await ctx.currentBytes();
      setSize(b.length);
      setMeta(await readMeta(b));
    })().catch((e) => ctx.setError(String(e)));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  if (!meta) return <Modal title="Propiedades" onClose={ctx.close}><p className="muted">Cargando…</p></Modal>;
  const set = (k: keyof typeof meta) => (e: React.ChangeEvent<HTMLInputElement>) => setMeta({ ...meta, [k]: e.target.value });
  const go = () =>
    ctx.run("Guardando propiedades…", async () => {
      const { writeMeta } = await import("./lib/tools");
      await ctx.replaceDoc(await writeMeta(await ctx.currentBytes(), meta));
      ctx.notify("Propiedades actualizadas");
      ctx.close();
    });
  return (
    <Modal title="Propiedades del documento" onClose={ctx.close}>
      <Field label="Título"><input value={meta.title} onChange={set("title")} /></Field>
      <Field label="Autor"><input value={meta.author} onChange={set("author")} /></Field>
      <Field label="Asunto"><input value={meta.subject} onChange={set("subject")} /></Field>
      <Field label="Palabras clave"><input value={meta.keywords} onChange={set("keywords")} /></Field>
      <div className="grid2">
        <Field label="Aplicación"><input value={meta.creator} onChange={set("creator")} /></Field>
        <Field label="Productor"><input value={meta.producer} onChange={set("producer")} /></Field>
      </div>
      <p className="muted small">
        {meta.pages} páginas · PDF {meta.version} · {fmtSize(size)}
        {meta.created && ` · Creado ${meta.created.toLocaleString("es-ES")}`}
        {meta.modified && ` · Modificado ${meta.modified.toLocaleString("es-ES")}`}
      </p>
      <div className="row end"><button className="primary" onClick={go}>Guardar</button></div>
    </Modal>
  );
}

// ---------------------------------------------------------------- Marcadores
interface OutlineNode { title: string; dest: unknown; items: OutlineNode[] }
function OutlinePanel({ ctx }: P) {
  const [tree, setTree] = useState<OutlineNode[] | null>(null);
  const [js, setJs] = useState<import("pdfjs-dist").PDFDocumentProxy | null>(null);
  const [edit, setEdit] = useState<{ title: string; page: number; level: number }[] | null>(null);
  useEffect(() => {
    (async () => {
      const { openJs } = await import("./lib/convert");
      const d = await openJs(await ctx.currentBytes());
      setJs(d);
      setTree(((await d.getOutline()) as OutlineNode[] | null) ?? []);
    })().catch((e) => ctx.setError(String(e)));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const pageOf = async (dest: unknown) => {
    if (!js) return -1;
    const d = typeof dest === "string" ? await js.getDestination(dest) : (dest as unknown[]);
    if (!d) return -1;
    return js.getPageIndex(d[0] as never);
  };
  const go = async (dest: unknown) => {
    const i = await pageOf(dest);
    if (i >= 0) ctx.goTo(i);
  };
  const startEdit = async () => {
    const flat: { title: string; page: number; level: number }[] = [];
    const walk = async (nodes: OutlineNode[], level: number) => {
      for (const n of nodes) {
        flat.push({ title: n.title, page: Math.max(0, await pageOf(n.dest)) + 1, level });
        await walk(n.items, level + 1);
      }
    };
    await walk(tree ?? [], 0);
    setEdit(flat);
  };
  const save = () =>
    ctx.run("Guardando marcadores…", async () => {
      const { writeOutline } = await import("./lib/outline");
      await ctx.replaceDoc(await writeOutline(await ctx.currentBytes(), edit!));
      ctx.notify("Marcadores guardados");
      ctx.close();
    });
  const render = (nodes: OutlineNode[], depth = 0): React.ReactNode =>
    nodes.map((n, i) => (
      <div key={i} style={{ paddingLeft: depth * 14 }}>
        <button className="link left" onClick={() => go(n.dest)}>{n.title}</button>
        {render(n.items, depth + 1)}
      </div>
    ));
  return (
    <Modal title="Marcadores" onClose={ctx.close}>
      {!edit ? (
        <>
          {tree === null ? <p className="muted">Cargando…</p> : tree.length ? <div className="outline">{render(tree)}</div> : <p className="muted">Este documento no tiene marcadores.</p>}
          <div className="row end"><button onClick={startEdit}>Editar marcadores</button></div>
        </>
      ) : (
        <>
          <div className="outline-edit">
            {edit.map((b, i) => (
              <div key={i} className="row">
                <input style={{ marginLeft: b.level * 16, flex: 1 }} value={b.title} onChange={(e) => setEdit(edit.map((x, j) => (j === i ? { ...x, title: e.target.value } : x)))} />
                <input type="number" className="num" min={1} max={ctx.pages.length} value={b.page} onChange={(e) => setEdit(edit.map((x, j) => (j === i ? { ...x, page: Number(e.target.value) } : x)))} title="Página" />
                <button onClick={() => setEdit(edit.map((x, j) => (j === i ? { ...x, level: Math.max(0, x.level - 1) } : x)))} title="Subir nivel">←</button>
                <button onClick={() => setEdit(edit.map((x, j) => (j === i ? { ...x, level: Math.min(5, x.level + 1) } : x)))} title="Bajar nivel">→</button>
                <button onClick={() => setEdit(edit.filter((_, j) => j !== i))} title="Quitar">✕</button>
              </div>
            ))}
          </div>
          <div className="row between">
            <button onClick={() => setEdit([...edit, { title: `Página ${ctx.current + 1}`, page: ctx.current + 1, level: 0 }])}>+ Añadir (página actual)</button>
            <button className="primary" onClick={save}>Guardar marcadores</button>
          </div>
        </>
      )}
    </Modal>
  );
}

// ---------------------------------------------------------------- Marca de agua
function WatermarkPanel({ ctx }: P) {
  const [o, setO] = useState({ text: "CONFIDENCIAL", size: 60, color: "#d00000", opacity: 0.25, angle: 45, position: "center" as "center" | "tile", range: "", behind: false });
  const [img, setImg] = useState<File | null>(null);
  const go = () =>
    ctx.run("Añadiendo marca de agua…", async () => {
      const { addWatermark } = await import("./lib/tools");
      const image = img ? { bytes: await fileBytes(img), png: img.type === "image/png" } : undefined;
      await ctx.replaceDoc(await addWatermark(await ctx.currentBytes(), { ...o, image, text: image ? undefined : o.text }));
      ctx.close();
    });
  return (
    <Modal title="Marca de agua" onClose={ctx.close}>
      <Field label="Texto"><input value={o.text} onChange={(e) => setO({ ...o, text: e.target.value })} disabled={!!img} /></Field>
      <Field label="…o imagen (PNG/JPG)"><input type="file" accept="image/png,image/jpeg" onChange={(e) => setImg(e.target.files?.[0] ?? null)} /></Field>
      <div className="grid2">
        <Field label={img ? "Tamaño (% de la página)" : "Tamaño de letra"}><input type="number" value={o.size} onChange={(e) => setO({ ...o, size: Number(e.target.value) })} /></Field>
        <Field label="Color"><input type="color" value={o.color} onChange={(e) => setO({ ...o, color: e.target.value })} /></Field>
        <Field label="Opacidad"><input type="range" min={0.05} max={1} step={0.05} value={o.opacity} onChange={(e) => setO({ ...o, opacity: Number(e.target.value) })} /></Field>
        <Field label="Ángulo"><input type="number" value={o.angle} onChange={(e) => setO({ ...o, angle: Number(e.target.value) })} /></Field>
        <Field label="Posición"><select value={o.position} onChange={(e) => setO({ ...o, position: e.target.value as "center" | "tile" })}><option value="center">Centrada</option><option value="tile">Mosaico</option></select></Field>
        <Field label="Páginas"><input value={o.range} onChange={(e) => setO({ ...o, range: e.target.value })} placeholder="Todas" /></Field>
      </div>
      <label className="row"><input type="checkbox" checked={o.behind} onChange={(e) => setO({ ...o, behind: e.target.checked })} /> Detrás del contenido</label>
      <div className="row end"><button className="primary" onClick={go}>Aplicar</button></div>
    </Modal>
  );
}

// ---------------------------------------------------------------- Encabezado y pie
function HeaderFooterPanel({ ctx }: P) {
  const [slots, setSlots] = useState<[string, string, string, string, string, string]>(["", "", "", "", "Página {n} de {total}", ""]);
  const [size, setSize] = useState(10);
  const [color, setColor] = useState("#333333");
  const [margin, setMargin] = useState(28);
  const [range, setRange] = useState("");
  const [startAt, setStartAt] = useState(1);
  const go = () =>
    ctx.run("Añadiendo encabezado y pie…", async () => {
      const { addHeaderFooter } = await import("./lib/tools");
      await ctx.replaceDoc(await addHeaderFooter(await ctx.currentBytes(), { slots, size, color, margin, range, startAt, fileName: ctx.fileName }));
      ctx.close();
    });
  const L = ["Encabezado izquierda", "Encabezado centro", "Encabezado derecha", "Pie izquierda", "Pie centro", "Pie derecha"];
  return (
    <Modal title="Encabezado, pie y numeración" onClose={ctx.close} wide>
      <div className="grid3">
        {slots.map((s, i) => (
          <Field key={i} label={L[i]}><input value={s} onChange={(e) => setSlots(slots.map((x, j) => (j === i ? e.target.value : x)) as typeof slots)} /></Field>
        ))}
      </div>
      <p className="muted small">Variables: {"{n}"} nº de página, {"{total}"} total, {"{fecha}"} fecha de hoy, {"{archivo}"} nombre del archivo.</p>
      <div className="grid3">
        <Field label="Tamaño"><input type="number" value={size} onChange={(e) => setSize(Number(e.target.value))} /></Field>
        <Field label="Color"><input type="color" value={color} onChange={(e) => setColor(e.target.value)} /></Field>
        <Field label="Margen (pt)"><input type="number" value={margin} onChange={(e) => setMargin(Number(e.target.value))} /></Field>
        <Field label="Páginas"><input value={range} onChange={(e) => setRange(e.target.value)} placeholder="Todas" /></Field>
        <Field label="Empezar a numerar en"><input type="number" value={startAt} onChange={(e) => setStartAt(Number(e.target.value))} /></Field>
      </div>
      <div className="row end"><button className="primary" onClick={go}>Aplicar</button></div>
    </Modal>
  );
}

function BatesPanel({ ctx }: P) {
  const [o, setO] = useState({ prefix: "DOC-", start: 1, digits: 6, suffix: "", position: 5, size: 9 });
  const go = () =>
    ctx.run("Numerando…", async () => {
      const { addBates } = await import("./lib/tools");
      await ctx.replaceDoc(await addBates(await ctx.currentBytes(), o.prefix, o.start, o.digits, o.suffix, o.position, o.size));
      ctx.close();
    });
  return (
    <Modal title="Numeración Bates" onClose={ctx.close}>
      <div className="grid2">
        <Field label="Prefijo"><input value={o.prefix} onChange={(e) => setO({ ...o, prefix: e.target.value })} /></Field>
        <Field label="Sufijo"><input value={o.suffix} onChange={(e) => setO({ ...o, suffix: e.target.value })} /></Field>
        <Field label="Número inicial"><input type="number" value={o.start} onChange={(e) => setO({ ...o, start: Number(e.target.value) })} /></Field>
        <Field label="Dígitos"><input type="number" value={o.digits} onChange={(e) => setO({ ...o, digits: Number(e.target.value) })} /></Field>
        <Field label="Posición">
          <select value={o.position} onChange={(e) => setO({ ...o, position: Number(e.target.value) })}>
            {["Arriba izquierda", "Arriba centro", "Arriba derecha", "Abajo izquierda", "Abajo centro", "Abajo derecha"].map((l, i) => <option key={i} value={i}>{l}</option>)}
          </select>
        </Field>
        <Field label="Tamaño"><input type="number" value={o.size} onChange={(e) => setO({ ...o, size: Number(e.target.value) })} /></Field>
      </div>
      <p className="muted small">Ejemplo: {o.prefix}{String(o.start).padStart(o.digits, "0")}{o.suffix}</p>
      <div className="row end"><button className="primary" onClick={go}>Aplicar</button></div>
    </Modal>
  );
}

function BackgroundPanel({ ctx }: P) {
  const [color, setColor] = useState("#fff8e1");
  const [range, setRange] = useState("");
  const go = () =>
    ctx.run("Aplicando fondo…", async () => {
      const { addBackground } = await import("./lib/tools");
      await ctx.replaceDoc(await addBackground(await ctx.currentBytes(), color, range));
      ctx.close();
    });
  return (
    <Modal title="Fondo de página" onClose={ctx.close}>
      <div className="grid2">
        <Field label="Color"><input type="color" value={color} onChange={(e) => setColor(e.target.value)} /></Field>
        <Field label="Páginas"><input value={range} onChange={(e) => setRange(e.target.value)} placeholder="Todas" /></Field>
      </div>
      <div className="row end"><button className="primary" onClick={go}>Aplicar</button></div>
    </Modal>
  );
}

// ---------------------------------------------------------------- Adjuntos
function AttachmentsPanel({ ctx }: P) {
  const [list, setList] = useState<import("./lib/tools").Attachment[] | null>(null);
  const refresh = async () => {
    const { listAttachments } = await import("./lib/tools");
    setList(await listAttachments(await ctx.currentBytes()));
  };
  useEffect(() => void refresh().catch((e) => ctx.setError(String(e))), []); // eslint-disable-line react-hooks/exhaustive-deps
  const add = (f: File) =>
    ctx.run("Adjuntando…", async () => {
      const { addAttachment } = await import("./lib/tools");
      await ctx.replaceDoc(await addAttachment(await ctx.currentBytes(), f));
      ctx.notify(`"${f.name}" adjuntado`);
      ctx.close();
    });
  const removeAll = () =>
    ctx.run("Quitando adjuntos…", async () => {
      const { removeAttachments } = await import("./lib/tools");
      await ctx.replaceDoc(await removeAttachments(await ctx.currentBytes()));
      ctx.close();
    });
  return (
    <Modal title="Archivos adjuntos" onClose={ctx.close}>
      {list === null ? <p className="muted">Cargando…</p> : !list.length ? <p className="muted">No hay archivos adjuntos.</p> : (
        <ul className="plain">
          {list.map((a, i) => (
            <li key={i} className="row between">
              <span>{a.name} <span className="muted small">({fmtSize(a.size)})</span></span>
              <button className="link" onClick={() => saveAs(ctx, a.bytes, a.name, "application/octet-stream")}>Descargar</button>
            </li>
          ))}
        </ul>
      )}
      <div className="row between">
        <label className="btn">+ Adjuntar archivo<input type="file" hidden onChange={(e) => e.target.files?.[0] && add(e.target.files[0])} /></label>
        <button onClick={removeAll} disabled={!list?.length}>Quitar todos</button>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------- Comparar
function ComparePanel({ ctx }: P) {
  const [result, setResult] = useState<{ page: number; parts: import("./lib/tools").DiffPart[] }[] | null>(null);
  const [other, setOther] = useState("");
  const go = (f: File) =>
    ctx.run("Comparando…", async () => {
      const { openJs, pageParagraphs } = await import("./lib/convert");
      const { diffWords } = await import("./lib/tools");
      const a = await openJs(await ctx.currentBytes());
      const bSrc = await loadSource(f, ctx.askPassword);
      const b = bSrc.doc;
      const n = Math.max(a.numPages, b.numPages);
      const out: { page: number; parts: import("./lib/tools").DiffPart[] }[] = [];
      for (let i = 1; i <= n; i++) {
        const ta = i <= a.numPages ? (await pageParagraphs(a, i)).paras.map((p) => p.text).join("\n") : "";
        const tb = i <= b.numPages ? (await pageParagraphs(b, i)).paras.map((p) => p.text).join("\n") : "";
        const parts = diffWords(ta, tb);
        if (parts.some((p) => p.type !== "same")) out.push({ page: i, parts });
      }
      await a.loadingTask.destroy();
      setOther(f.name);
      setResult(out);
    });
  return (
    <Modal title="Comparar documentos" onClose={ctx.close} wide>
      <p>Compara el texto del documento actual con otro PDF.</p>
      <input type="file" accept="application/pdf" onChange={(e) => e.target.files?.[0] && go(e.target.files[0])} />
      {result && (
        <div className="diff">
          <p className="muted small"><span className="del">Eliminado</span> (solo en {ctx.fileName}) · <span className="add">Añadido</span> (solo en {other})</p>
          {!result.length && <p><strong>No hay diferencias de texto.</strong></p>}
          {result.map((r) => (
            <div key={r.page} className="diff-page">
              <h4>Página {r.page}</h4>
              <p>{r.parts.map((p, i) => <span key={i} className={p.type}>{p.text}</span>)}</p>
            </div>
          ))}
        </div>
      )}
    </Modal>
  );
}

// ---------------------------------------------------------------- Datos de formulario
function FormDataPanel({ ctx }: P) {
  const [fields, setFields] = useState<{ name: string; type: string; value: string | boolean }[] | null>(null);
  useEffect(() => {
    (async () => {
      const { PDFDocument, PDFTextField, PDFCheckBox, PDFDropdown, PDFRadioGroup, PDFOptionList } = await import("pdf-lib");
      const d = await PDFDocument.load(await ctx.currentBytes(), { ignoreEncryption: true });
      setFields(
        d.getForm().getFields().map((f) => {
          let value: string | boolean = "";
          let type = "otro";
          if (f instanceof PDFTextField) (type = "texto"), (value = f.getText() ?? "");
          else if (f instanceof PDFCheckBox) (type = "casilla"), (value = f.isChecked());
          else if (f instanceof PDFDropdown) (type = "lista"), (value = f.getSelected().join(", "));
          else if (f instanceof PDFOptionList) (type = "lista"), (value = f.getSelected().join(", "));
          else if (f instanceof PDFRadioGroup) (type = "opción"), (value = f.getSelected() ?? "");
          return { name: f.getName(), type, value };
        }),
      );
    })().catch((e) => ctx.setError(String(e)));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const exportJson = () => saveAs(ctx, new TextEncoder().encode(JSON.stringify(Object.fromEntries(fields!.map((f) => [f.name, f.value])), null, 2)), `${base(ctx.fileName)}_datos.json`, "application/json");
  const exportCsv = () => {
    const esc = (s: string) => `"${s.replace(/"/g, '""')}"`;
    const csv = fields!.map((f) => esc(f.name)).join(";") + "\n" + fields!.map((f) => esc(String(f.value))).join(";");
    saveAs(ctx, new TextEncoder().encode("﻿" + csv), `${base(ctx.fileName)}_datos.csv`, "text/csv");
  };
  const importJson = async (f: File) => {
    const data = JSON.parse(await f.text()) as Record<string, string | boolean>;
    const srcIds = [...new Set(ctx.pages.filter((p) => p.kind === "src").map((p) => (p as { srcId: string }).srcId))];
    ctx.commit((d) => {
      const forms = { ...d.forms };
      for (const [k, v] of Object.entries(data)) for (const s of srcIds) forms[`${s}|${k}`] = v;
      return { ...d, forms };
    });
    ctx.notify("Datos importados");
    ctx.close();
  };
  return (
    <Modal title="Datos del formulario" onClose={ctx.close} wide>
      {fields === null ? <p className="muted">Cargando…</p> : !fields.length ? <p className="muted">Este documento no tiene campos de formulario. Créalos con las herramientas de la pestaña Formularios.</p> : (
        <table className="tbl">
          <thead><tr><th>Campo</th><th>Tipo</th><th>Valor</th></tr></thead>
          <tbody>{fields.map((f) => <tr key={f.name}><td>{f.name}</td><td>{f.type}</td><td>{String(f.value === true ? "Sí" : f.value === false ? "No" : f.value)}</td></tr>)}</tbody>
        </table>
      )}
      <div className="row between">
        <label className="btn">Importar JSON<input type="file" accept="application/json" hidden onChange={(e) => e.target.files?.[0] && importJson(e.target.files[0])} /></label>
        <span className="row">
          <button onClick={exportCsv} disabled={!fields?.length}>Exportar CSV</button>
          <button onClick={exportJson} disabled={!fields?.length}>Exportar JSON</button>
        </span>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------- Firmar con certificado
const TSAS = [
  { label: "Sin sello de tiempo", url: "" },
  { label: "FreeTSA (freetsa.org)", url: "https://freetsa.org/tsr" },
  { label: "DigiCert", url: "http://timestamp.digicert.com" },
  { label: "Sectigo", url: "http://timestamp.sectigo.com" },
  { label: "ACCV (Comunitat Valenciana)", url: "http://tss.accv.es:8318/tsa" },
  { label: "Otro…", url: "custom" },
];

function SignPanel({ ctx }: P) {
  const [mode, setMode] = useState<"file" | "system">(desktop.available ? "system" : "file");
  const [file, setFile] = useState<File | null>(null);
  const [pw, setPw] = useState("");
  const [sysCerts, setSysCerts] = useState<import("./lib/desktop").SystemCert[] | null>(null);
  const [sysId, setSysId] = useState("");
  const [pin, setPin] = useState("");
  const [signer, setSigner] = useState<import("./lib/sign/signer").Signer | null>(null);
  const [info, setInfo] = useState<import("./lib/sign/signer").CertInfo | null>(null);
  const [reason, setReason] = useState("");
  const [location, setLocation] = useState("");
  const [visible, setVisible] = useState(true);
  const [page, setPage] = useState(ctx.current + 1);
  const [pos, setPos] = useState("br");
  const [useImage, setUseImage] = useState(false);
  const saved = useMemo(loadSaved, []);
  const [imgIdx, setImgIdx] = useState(0);
  const [tsa, setTsa] = useState(desktop.available ? TSAS[1].url : "");
  const [customTsa, setCustomTsa] = useState("");
  const [certify, setCertify] = useState<0 | 1 | 2 | 3>(0);

  useEffect(() => {
    if (desktop.available) desktop.listCertificates().then(setSysCerts).catch(() => setSysCerts([]));
  }, []);

  const unlock = () =>
    ctx.run("Abriendo certificado…", async () => {
      const { signerFromP12, certInfo } = await import("./lib/sign/signer");
      let s;
      if (mode === "file") {
        if (!file) throw new Error("Elige el archivo del certificado (.p12 o .pfx)");
        s = await signerFromP12(await fileBytes(file), pw);
      } else {
        if (!sysId) throw new Error("Elige un certificado");
        s = await desktop.signer(sysId, pin);
      }
      const i = certInfo(s.certificate);
      if (i.notAfter < new Date()) throw new Error(`El certificado caducó el ${i.notAfter.toLocaleDateString("es-ES")}`);
      setSigner(s);
      setInfo(i);
    });

  const sign = () =>
    ctx.run("Firmando…", async () => {
      if (!signer) return;
      const { signPdf } = await import("./lib/sign/pades");
      const { hasSignatures } = await import("./lib/sign/verify");
      const { bytes, pristine } = await ctx.pristineBytes();
      const anySrcSigned = [...ctx.sources.values()].some((s) => hasSignatures(s.bytes));
      if (!pristine && anySrcSigned && !(await askConfirm("Firmas previas", "El documento tiene firmas previas y lo has modificado: esas firmas dejarán de ser válidas. ¿Firmar igualmente?", true))) return;
      let rect: [number, number, number, number] | undefined;
      const pIdx = Math.min(Math.max(1, page), ctx.pages.length) - 1;
      if (visible) {
        const { PDFDocument } = await import("pdf-lib");
        const d = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
        const pg = d.getPage(pIdx);
        const box = pg.getCropBox();
        const rot = ((pg.getRotation().angle % 360) + 360) % 360;
        const vw = rot % 180 ? box.height : box.width, vh = rot % 180 ? box.width : box.height;
        const W = 190, H = 60, M = 36;
        const vx = pos.endsWith("l") ? M : pos.endsWith("c") ? (vw - W) / 2 : vw - M - W;
        const vy = pos.startsWith("t") ? vh - M - H : M;
        // visual → usuario
        const at = (x: number, y: number): [number, number] =>
          rot === 90 ? [box.x + box.width - y, box.y + x] : rot === 180 ? [box.x + box.width - x, box.y + box.height - y] : rot === 270 ? [box.x + y, box.y + box.height - x] : [box.x + x, box.y + y];
        const [ax, ay] = at(vx, vy), [bx, by] = at(vx + W, vy + H);
        rect = [Math.min(ax, bx), Math.min(ay, by), Math.max(ax, bx), Math.max(ay, by)];
      }
      const tsaUrl = tsa === "custom" ? customTsa.trim() : tsa;
      const out = await signPdf(bytes, signer, {
        reason: reason || undefined,
        location: location || undefined,
        page: pIdx,
        rect,
        image: visible && useImage && saved[imgIdx] ? saved[imgIdx].dataUrl : undefined,
        tsaUrl: tsaUrl || undefined,
        certify: certify || undefined,
      });
      const name = `${base(ctx.fileName)}_firmado.pdf`;
      await download(out, name);
      await ctx.replaceDoc(out);
      ctx.notify("Documento firmado y descargado");
      ctx.close();
    });

  return (
    <Modal title="Firmar con certificado digital" onClose={ctx.close} wide>
      {!signer ? (
        <>
          {desktop.available && (
            <div className="tabs">
              <button className={mode === "system" ? "on" : ""} onClick={() => setMode("system")}>Certificados instalados / DNIe</button>
              <button className={mode === "file" ? "on" : ""} onClick={() => setMode("file")}>Archivo .p12 / .pfx</button>
            </div>
          )}
          {mode === "file" ? (
            <>
              <Field label="Certificado (.p12, .pfx)"><input type="file" accept=".p12,.pfx,application/x-pkcs12" onChange={(e) => setFile(e.target.files?.[0] ?? null)} /></Field>
              <Field label="Contraseña del certificado"><input type="password" value={pw} onChange={(e) => setPw(e.target.value)} onKeyDown={(e) => e.key === "Enter" && unlock()} autoComplete="off" /></Field>
              <p className="muted small">
                El certificado y su contraseña se usan solo en tu equipo, nunca se envían a ningún sitio.
                {!desktop.available && " Para usar el DNIe, tarjetas o los certificados instalados en Windows/macOS, usa la app de escritorio."}
              </p>
            </>
          ) : (
            <>
              {sysCerts === null ? <p className="muted">Buscando certificados…</p> : !sysCerts.length ? <p className="muted">No se encontraron certificados con clave privada. Inserta el DNIe o la tarjeta y vuelve a abrir esta ventana.</p> : (
                <div className="cert-list">
                  {sysCerts.map((c) => (
                    <label key={c.id} className={`cert ${sysId === c.id ? "on" : ""}`}>
                      <input type="radio" name="cert" checked={sysId === c.id} onChange={() => setSysId(c.id)} />
                      <div>
                        <strong>{c.subject}</strong>
                        <div className="muted small">{c.issuer} · caduca {new Date(c.notAfter).toLocaleDateString("es-ES")} · {c.source}</div>
                      </div>
                    </label>
                  ))}
                </div>
              )}
              {sysCerts?.find((c) => c.id === sysId)?.needsPin && <Field label="PIN"><input type="password" value={pin} onChange={(e) => setPin(e.target.value)} autoComplete="off" /></Field>}
            </>
          )}
          <div className="row end"><button className="primary" onClick={unlock}>Continuar</button></div>
        </>
      ) : (
        <>
          <div className="cert-card">
            <strong>{info!.subjectCN}</strong>
            <div className="muted small">Emitido por {info!.issuerCN} · válido hasta {info!.notAfter.toLocaleDateString("es-ES")}{info!.id ? ` · ${info!.id}` : ""}</div>
            <button className="link" onClick={() => setSigner(null)}>Cambiar</button>
          </div>
          <div className="grid2">
            <Field label="Motivo"><input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Ej.: Conforme" /></Field>
            <Field label="Lugar"><input value={location} onChange={(e) => setLocation(e.target.value)} placeholder="Ej.: Madrid" /></Field>
          </div>
          <label className="row"><input type="checkbox" checked={visible} onChange={(e) => setVisible(e.target.checked)} /> Firma visible en la página</label>
          {visible && (
            <div className="grid3">
              <Field label="Página"><input type="number" min={1} max={ctx.pages.length} value={page} onChange={(e) => setPage(Number(e.target.value))} /></Field>
              <Field label="Posición">
                <select value={pos} onChange={(e) => setPos(e.target.value)}>
                  <option value="br">Abajo derecha</option>
                  <option value="bc">Abajo centro</option>
                  <option value="bl">Abajo izquierda</option>
                  <option value="tr">Arriba derecha</option>
                  <option value="tl">Arriba izquierda</option>
                </select>
              </Field>
              <Field label="Firma manuscrita">
                <select value={useImage ? imgIdx : -1} onChange={(e) => (Number(e.target.value) < 0 ? setUseImage(false) : (setUseImage(true), setImgIdx(Number(e.target.value))))} disabled={!saved.length}>
                  <option value={-1}>{saved.length ? "Sin imagen" : "No hay firmas guardadas"}</option>
                  {saved.map((_, i) => <option key={i} value={i}>Firma guardada {i + 1}</option>)}
                </select>
              </Field>
            </div>
          )}
          <div className="grid2">
            <Field label="Sello de tiempo">
              <select value={tsa} onChange={(e) => setTsa(e.target.value)}>
                {TSAS.map((t) => <option key={t.label} value={t.url}>{t.label}</option>)}
              </select>
            </Field>
            {tsa === "custom" ? <Field label="URL de la TSA"><input value={customTsa} onChange={(e) => setCustomTsa(e.target.value)} placeholder="https://…" /></Field> : (
              <Field label="Tipo de firma">
                <select value={certify} onChange={(e) => setCertify(Number(e.target.value) as 0 | 1 | 2 | 3)}>
                  <option value={0}>Firma de aprobación</option>
                  <option value={1}>Certificar: no se permiten cambios</option>
                  <option value={2}>Certificar: permitir rellenar formularios y firmar</option>
                  <option value={3}>Certificar: permitir además comentarios</option>
                </select>
              </Field>
            )}
          </div>
          {tsa && !desktop.available && <p className="muted small">Aviso: algunos servidores de sellado de tiempo no aceptan peticiones desde el navegador. Si falla, firma sin sello o usa la app de escritorio.</p>}
          <p className="muted small">Firma PAdES (ETSI.CAdES.detached, SHA-256) compatible con Adobe Acrobat, Foxit, AutoFirma y validadores de la UE.</p>
          <div className="row end"><button className="primary" onClick={sign}>Firmar y descargar</button></div>
        </>
      )}
    </Modal>
  );
}

// ---------------------------------------------------------------- Verificar firmas
function VerifyPanel({ ctx }: P) {
  const [reports, setReports] = useState<import("./lib/sign/verify").SigReport[] | null>(null);
  const [bytes, setBytes] = useState<Uint8Array | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    (async () => {
      const { verifyPdf } = await import("./lib/sign/verify");
      const { bytes: b } = await ctx.pristineBytes();
      setBytes(b);
      setReports(await verifyPdf(b));
    })().catch((e) => ctx.setError(String(e)));
  }, [tick]); // eslint-disable-line react-hooks/exhaustive-deps
  const trust = async (i: number) => {
    const { signatureCerts, addTrustedRoot, b64 } = await import("./lib/sign/verify");
    const { certInfo } = await import("./lib/sign/signer");
    const certs = signatureCerts(bytes!, i);
    const root = certs.find((c) => certInfo(c).selfSigned) ?? certs[certs.length - 1];
    if (!root) return;
    const ci = certInfo(root);
    if (!(await askConfirm("Confiar en el emisor", `¿Confiar en "${ci.subjectCN}" como autoridad de certificación?\nSolo hazlo si sabes que es legítima (p. ej. FNMT, DNIe, tu empresa).`))) return;
    addTrustedRoot(b64(root));
    setTick((t) => t + 1);
  };
  const openRevision = (r: import("./lib/sign/verify").SigReport) =>
    ctx.run("Abriendo versión firmada…", async () => {
      const src = await loadSource({ name: `${base(ctx.fileName)}_version_firmada.pdf`, bytes: bytes!.slice(0, r.revisionLength) });
      ctx.addSources([src], false);
      ctx.close();
    });
  return (
    <Modal title="Firmas digitales" onClose={ctx.close} wide>
      {reports === null ? <p className="muted">Verificando…</p> : !reports.length ? <p>Este documento no contiene firmas digitales.</p> : reports.map((r, i) => {
        const ok = r.integrity && r.certValidAtSigning && !r.errors.length;
        return (
          <div key={i} className={`sig-report ${ok ? (r.trusted ? "ok" : "warn") : "bad"}`}>
            <div className="sig-title">
              <span className="badge">{ok ? (r.trusted ? "✔ Válida" : "✔ Íntegra") : "✖ No válida"}</span>
              <strong>{r.signer?.subjectCN ?? "Firmante desconocido"}</strong>
              {r.certified && <span className="muted small"> · Firma de certificación</span>}
            </div>
            <ul className="plain small">
              <li>{r.integrity ? "El documento no se ha modificado desde que se firmó." : "El contenido firmado ha sido alterado o la firma está dañada."}</li>
              <li>{r.coversWholeFile ? "La firma cubre todo el documento." : "Hay cambios posteriores a esta firma (por ejemplo, otras firmas o anotaciones)."}</li>
              <li>{r.trusted ? "La identidad del firmante está verificada con una autoridad de confianza." : "Identidad no verificada: la autoridad emisora no está en tu lista de confianza."} {!r.trusted && r.integrity && <button className="link" onClick={() => trust(i)}>Confiar en el emisor</button>}</li>
              <li>Fecha de firma: {r.signedAt ? r.signedAt.toLocaleString("es-ES") : "desconocida"} {r.timestamp ? `(sello de tiempo de ${r.timestamp.tsa}${r.timestamp.valid ? ", válido" : ", NO válido"})` : "(hora del equipo del firmante)"}</li>
              {r.reason && <li>Motivo: {r.reason}</li>}
              {r.location && <li>Lugar: {r.location}</li>}
              {r.signer && <li>Certificado: {r.signer.subject} · emitido por {r.signer.issuerCN} · válido del {r.signer.notBefore.toLocaleDateString("es-ES")} al {r.signer.notAfter.toLocaleDateString("es-ES")}</li>}
              <li>Formato: {r.subFilter}</li>
              {r.errors.map((e, j) => <li key={j} className="err">{e}</li>)}
            </ul>
            {!r.coversWholeFile && <button className="link" onClick={() => openRevision(r)}>Ver la versión firmada</button>}
          </div>
        );
      })}
    </Modal>
  );
}

// ---------------------------------------------------------------- Contraseña
function EncryptPanel({ ctx }: P) {
  const [user, setUser] = useState("");
  const [owner, setOwner] = useState("");
  const [perms, setPerms] = useState({ print: true, modify: false, copy: false, annotate: true, forms: true, assemble: false });
  const go = () =>
    ctx.run("Cifrando (AES-256)…", async () => {
      if (!user && !owner) throw new Error("Escribe al menos una contraseña");
      const { encryptPdf } = await import("./lib/qpdf");
      const out = await encryptPdf(await ctx.currentBytes(), user, owner, perms);
      await download(out, `${base(ctx.fileName)}_protegido.pdf`);
      ctx.notify("PDF protegido descargado");
      ctx.close();
    });
  const P2 = (k: keyof typeof perms, l: string) => <label className="row"><input type="checkbox" checked={perms[k]} onChange={(e) => setPerms({ ...perms, [k]: e.target.checked })} /> {l}</label>;
  return (
    <Modal title="Proteger con contraseña" onClose={ctx.close}>
      <Field label="Contraseña para abrir el documento"><input type="password" value={user} onChange={(e) => setUser(e.target.value)} autoComplete="new-password" placeholder="Opcional" /></Field>
      <Field label="Contraseña de permisos (propietario)"><input type="password" value={owner} onChange={(e) => setOwner(e.target.value)} autoComplete="new-password" placeholder="Para cambiar las restricciones" /></Field>
      <p className="muted small">Permitir sin la contraseña de propietario:</p>
      <div className="grid2">
        {P2("print", "Imprimir")}
        {P2("copy", "Copiar texto e imágenes")}
        {P2("annotate", "Comentar")}
        {P2("forms", "Rellenar formularios")}
        {P2("assemble", "Insertar/eliminar páginas")}
        {P2("modify", "Modificar el documento")}
      </div>
      <p className="muted small">Cifrado AES de 256 bits. Si olvidas la contraseña de apertura no se podrá recuperar el documento.</p>
      <div className="row end"><button className="primary" onClick={go}>Proteger y descargar</button></div>
    </Modal>
  );
}

function DecryptPanel({ ctx }: P) {
  const go = () =>
    ctx.run("Guardando…", async () => {
      await download(await ctx.currentBytes(), `${base(ctx.fileName)}_sin_proteccion.pdf`);
      ctx.close();
    });
  return (
    <Modal title="Quitar seguridad" onClose={ctx.close}>
      <p>Los documentos protegidos se desbloquean al abrirlos con su contraseña. Al guardar se genera una copia sin contraseña ni restricciones.</p>
      <div className="row end"><button className="primary" onClick={go}>Guardar sin protección</button></div>
    </Modal>
  );
}

// ---------------------------------------------------------------- Buscar y redactar
function RedactSearchPanel({ ctx }: P) {
  const [q, setQ] = useState("");
  const [cs, setCs] = useState(false);
  const [preset, setPreset] = useState("");
  const PRESETS: Record<string, string> = {
    dni: "\\b\\d{8}[A-HJ-NP-TV-Z]\\b|\\b[XYZ]\\d{7}[A-HJ-NP-TV-Z]\\b",
    email: "[\\w.+-]+@[\\w-]+\\.[\\w.]+",
    phone: "(\\+34\\s?)?[6789]\\d{2}[\\s.-]?\\d{3}[\\s.-]?\\d{3}",
    iban: "\\b[A-Z]{2}\\d{2}(?:\\s?[A-Z0-9]{4}){4,7}\\b",
    card: "\\b(?:\\d[ -]?){13,19}\\b",
  };
  const go = () =>
    ctx.run("Buscando…", async () => {
      const { findTextRects } = await import("./lib/redact");
      const found = await findTextRects(ctx.pages, ctx.sources, preset ? PRESETS[preset] : q, { caseSensitive: cs, regex: !!preset });
      const n = [...found.values()].reduce((s, r) => s + r.length, 0);
      ctx.commit((d) => {
        const annots = { ...d.annots };
        for (const [key, rects] of found) {
          annots[key] = [...(annots[key] ?? []), ...rects.map((rect) => ({ id: uid("a"), type: "redact" as const, rect, color: "#000000", opacity: 1, created: Date.now() }) as Annot)];
        }
        return { ...d, annots };
      });
      ctx.notify(n ? `${n} coincidencias marcadas. Se eliminarán al guardar.` : "No se encontraron coincidencias");
      ctx.close();
    });
  return (
    <Modal title="Buscar y redactar" onClose={ctx.close}>
      <Field label="Texto a eliminar"><input value={q} onChange={(e) => (setQ(e.target.value), setPreset(""))} placeholder="Ej.: nombre, número de cuenta…" /></Field>
      <Field label="…o un tipo de dato">
        <select value={preset} onChange={(e) => setPreset(e.target.value)}>
          <option value="">—</option>
          <option value="dni">DNI / NIE</option>
          <option value="email">Correos electrónicos</option>
          <option value="phone">Teléfonos</option>
          <option value="iban">IBAN</option>
          <option value="card">Tarjetas de crédito</option>
        </select>
      </Field>
      <label className="row"><input type="checkbox" checked={cs} onChange={(e) => setCs(e.target.checked)} /> Distinguir mayúsculas</label>
      <p className="muted small">Las zonas se marcan para revisarlas. Al guardar, las páginas afectadas se convierten en imagen con esas zonas en negro, de modo que el texto desaparece definitivamente.</p>
      <div className="row end"><button className="primary" onClick={go} disabled={!q && !preset}>Marcar</button></div>
    </Modal>
  );
}

function SanitizePanel({ ctx }: P) {
  const [o, setO] = useState({ metadata: true, javascript: true, attachments: true, links: false, comments: false, forms: false });
  const go = () =>
    ctx.run("Limpiando…", async () => {
      const { sanitize } = await import("./lib/tools");
      await ctx.replaceDoc(await sanitize(await ctx.currentBytes(), o));
      ctx.notify("Documento limpio");
      ctx.close();
    });
  const C = (k: keyof typeof o, l: string) => <label className="row"><input type="checkbox" checked={o[k]} onChange={(e) => setO({ ...o, [k]: e.target.checked })} /> {l}</label>;
  return (
    <Modal title="Limpiar documento" onClose={ctx.close}>
      {C("metadata", "Metadatos (autor, programa, fechas, XMP)")}
      {C("javascript", "JavaScript y acciones automáticas")}
      {C("attachments", "Archivos adjuntos")}
      {C("links", "Enlaces")}
      {C("comments", "Comentarios y anotaciones")}
      {C("forms", "Aplanar formularios")}
      <div className="row end"><button className="primary" onClick={go}>Limpiar</button></div>
    </Modal>
  );
}

// ---------------------------------------------------------------- Conversión
function ToImagesPanel({ ctx }: P) {
  const [format, setFormat] = useState<"png" | "jpeg">("png");
  const [dpi, setDpi] = useState(150);
  const go = () =>
    ctx.run("Convirtiendo…", async () => {
      const { pdfToImages } = await import("./lib/convert");
      const r = await pdfToImages(await ctx.currentBytes(), base(ctx.fileName), format, dpi);
      await download(r.bytes, r.name, r.type);
      ctx.close();
    });
  return (
    <Modal title="Exportar como imágenes" onClose={ctx.close}>
      <div className="grid2">
        <Field label="Formato"><select value={format} onChange={(e) => setFormat(e.target.value as "png" | "jpeg")}><option value="png">PNG</option><option value="jpeg">JPG</option></select></Field>
        <Field label="Resolución"><select value={dpi} onChange={(e) => setDpi(Number(e.target.value))}>{[72, 96, 150, 200, 300, 600].map((d) => <option key={d} value={d}>{d} ppp</option>)}</select></Field>
      </div>
      <div className="row end"><button className="primary" onClick={go}>Exportar</button></div>
    </Modal>
  );
}

function ToWordPanel({ ctx }: P) {
  const [snap, setSnap] = useState(false);
  const go = () =>
    ctx.run("Convirtiendo a Word…", async () => {
      const { pdfToDocx } = await import("./lib/convert");
      await download(await pdfToDocx(await ctx.currentBytes(), snap), `${base(ctx.fileName)}.docx`, "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
      ctx.close();
    });
  return (
    <Modal title="Convertir a Word" onClose={ctx.close}>
      <label className="row"><input type="radio" checked={!snap} onChange={() => setSnap(false)} /> Texto editable (reconstruye párrafos, títulos y listas)</label>
      <label className="row"><input type="radio" checked={snap} onChange={() => setSnap(true)} /> Aspecto exacto (cada página como imagen)</label>
      <p className="muted small">Para documentos escaneados, aplica antes el OCR.</p>
      <div className="row end"><button className="primary" onClick={go}>Convertir</button></div>
    </Modal>
  );
}

function ToTextPanel({ ctx }: P) {
  const [text, setText] = useState<string | null>(null);
  useEffect(() => {
    (async () => {
      const { pdfToText } = await import("./lib/convert");
      setText(await pdfToText(await ctx.currentBytes()));
    })().catch((e) => ctx.setError(String(e)));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <Modal title="Texto del documento" onClose={ctx.close} wide>
      {text === null ? <p className="muted">Extrayendo…</p> : <textarea className="bigtext" readOnly value={text} />}
      <div className="row end">
        <button onClick={() => text && navigator.clipboard.writeText(text).then(() => ctx.notify("Copiado"))} disabled={!text}>Copiar</button>
        <button className="primary" onClick={() => text !== null && saveAs(ctx, new TextEncoder().encode(text), `${base(ctx.fileName)}.txt`, "text/plain")} disabled={text === null}>Descargar .txt</button>
      </div>
    </Modal>
  );
}

function ToHtmlPanel({ ctx }: P) {
  const [img, setImg] = useState(false);
  const go = () =>
    ctx.run("Convirtiendo a HTML…", async () => {
      const { pdfToHtml } = await import("./lib/convert");
      await download(new TextEncoder().encode(await pdfToHtml(await ctx.currentBytes(), base(ctx.fileName), img)), `${base(ctx.fileName)}.html`, "text/html");
      ctx.close();
    });
  return (
    <Modal title="Convertir a HTML" onClose={ctx.close}>
      <label className="row"><input type="checkbox" checked={img} onChange={(e) => setImg(e.target.checked)} /> Incluir imagen de cada página</label>
      <div className="row end"><button className="primary" onClick={go}>Convertir</button></div>
    </Modal>
  );
}

function FromWordPanel({ ctx }: P) {
  const go = (f: File) =>
    ctx.run("Convirtiendo Word a PDF…", async () => {
      const { docxToPdf } = await import("./lib/convert");
      const bytes = await docxToPdf(f);
      ctx.addSources([await loadSource({ name: base(f.name.replace(/\.docx$/i, "")) + ".pdf", bytes })], false);
      ctx.close();
    });
  return (
    <Modal title="Crear PDF desde Word" onClose={ctx.close}>
      <input type="file" accept=".docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document" onChange={(e) => e.target.files?.[0] && go(e.target.files[0])} />
      <p className="muted small">Se conservan títulos, párrafos, negrita/cursiva, listas, tablas e imágenes. Los diseños muy complejos pueden variar.</p>
    </Modal>
  );
}

function FromTextPanel({ ctx }: P) {
  const [text, setText] = useState("");
  const [html, setHtml] = useState(false);
  const go = () =>
    ctx.run("Creando PDF…", async () => {
      const { htmlToPdf, textToPdf } = await import("./lib/htmlToPdf");
      const bytes = html ? await htmlToPdf(text) : await textToPdf(text);
      ctx.addSources([await loadSource({ name: "documento.pdf", bytes })], false);
      ctx.close();
    });
  return (
    <Modal title="Crear PDF desde texto" onClose={ctx.close} wide>
      <input type="file" accept=".txt,.html,.htm,.md,text/*" onChange={async (e) => { const f = e.target.files?.[0]; if (f) { setText(await f.text()); setHtml(/\.html?$/i.test(f.name)); } }} />
      <textarea className="bigtext" value={text} onChange={(e) => setText(e.target.value)} placeholder="Escribe o pega aquí el texto…" />
      <div className="row between">
        <label className="row"><input type="checkbox" checked={html} onChange={(e) => setHtml(e.target.checked)} /> Es HTML</label>
        <button className="primary" onClick={go} disabled={!text.trim()}>Crear PDF</button>
      </div>
    </Modal>
  );
}

function OcrPanel({ ctx }: P) {
  const [langs, setLangs] = useState(["spa", "eng"]);
  const [dpi, setDpi] = useState(300);
  const [only, setOnly] = useState(true);
  const [progress, setProgress] = useState<{ msg: string; pct: number } | null>(null);
  const go = () =>
    ctx.run("OCR en curso…", async () => {
      const { ocrPdf } = await import("./lib/ocr");
      const r = await ocrPdf(await ctx.currentBytes(), { langs, dpi, onlyWithoutText: only, onProgress: (msg, pct) => (setProgress({ msg, pct }), ctx.progress(`${msg} ${Math.round(pct)}%`)) });
      if (!r.pages) {
        ctx.notify("Todas las páginas ya tenían texto: no hacía falta OCR");
        ctx.close();
        return;
      }
      await ctx.replaceDoc(r.bytes);
      ctx.notify(`Texto reconocido en ${r.pages} página(s). Ya puedes buscar, copiar y convertir.`);
      ctx.close();
    });
  const L = (k: string, l: string) => <label className="row"><input type="checkbox" checked={langs.includes(k)} onChange={(e) => setLangs(e.target.checked ? [...langs, k] : langs.filter((x) => x !== k))} /> {l}</label>;
  return (
    <Modal title="Reconocimiento de texto (OCR)" onClose={ctx.close}>
      <p className="muted small">Convierte documentos escaneados en PDF con texto buscable y seleccionable. Funciona sin conexión.</p>
      <div className="row">{L("spa", "Español")}{L("eng", "Inglés")}</div>
      <Field label="Calidad"><select value={dpi} onChange={(e) => setDpi(Number(e.target.value))}><option value={200}>Rápida (200 ppp)</option><option value={300}>Precisa (300 ppp)</option><option value={400}>Muy precisa (400 ppp)</option></select></Field>
      <label className="row"><input type="checkbox" checked={only} onChange={(e) => setOnly(e.target.checked)} /> Solo páginas sin texto</label>
      {progress && (
        <div className="progress"><div style={{ width: `${progress.pct}%` }} /><span>{progress.msg}</span></div>
      )}
      <div className="row end"><button className="primary" onClick={go} disabled={!langs.length || !!progress}>Reconocer texto</button></div>
    </Modal>
  );
}

function CompressPanel({ ctx }: P) {
  const [level, setLevel] = useState<"low" | "medium" | "high">("medium");
  const [result, setResult] = useState<{ before: number; after: number; bytes: Uint8Array; images: number } | null>(null);
  const cfg = { low: [0.85, 200], medium: [0.7, 150], high: [0.5, 100] } as const;
  const go = () =>
    ctx.run("Comprimiendo…", async () => {
      const { compressPdf } = await import("./lib/convert");
      const b = await ctx.currentBytes();
      const r = await compressPdf(b, cfg[level][0], cfg[level][1]);
      setResult({ before: b.length, after: r.bytes.length, bytes: r.bytes, images: r.images });
    });
  return (
    <Modal title="Comprimir PDF" onClose={ctx.close}>
      <label className="row"><input type="radio" checked={level === "low"} onChange={() => setLevel("low")} /> Baja (máxima calidad)</label>
      <label className="row"><input type="radio" checked={level === "medium"} onChange={() => setLevel("medium")} /> Media (recomendada)</label>
      <label className="row"><input type="radio" checked={level === "high"} onChange={() => setLevel("high")} /> Alta (archivo más pequeño)</label>
      {result && (
        <p>
          {fmtSize(result.before)} → <strong>{fmtSize(result.after)}</strong> ({Math.round((1 - result.after / result.before) * 100)}% menos, {result.images} imágenes recomprimidas)
        </p>
      )}
      <div className="row end">
        {!result ? <button className="primary" onClick={go}>Comprimir</button> : (
          <>
            <button onClick={() => ctx.run("Aplicando…", async () => { await ctx.replaceDoc(result.bytes); ctx.close(); })}>Usar en el editor</button>
            <button className="primary" onClick={() => saveAs(ctx, result.bytes, `${base(ctx.fileName)}_comprimido.pdf`)}>Descargar</button>
          </>
        )}
      </div>
    </Modal>
  );
}

const PANELS: Record<PanelId, (p: P) => React.ReactElement> = {
  print: PrintPanel,
  crop: CropPanel,
  properties: PropertiesPanel,
  outline: OutlinePanel,
  watermark: WatermarkPanel,
  headerfooter: HeaderFooterPanel,
  bates: BatesPanel,
  background: BackgroundPanel,
  attachments: AttachmentsPanel,
  compare: ComparePanel,
  formdata: FormDataPanel,
  sign: SignPanel,
  verify: VerifyPanel,
  encrypt: EncryptPanel,
  decrypt: DecryptPanel,
  redactsearch: RedactSearchPanel,
  sanitize: SanitizePanel,
  toimages: ToImagesPanel,
  toword: ToWordPanel,
  totext: ToTextPanel,
  tohtml: ToHtmlPanel,
  fromword: FromWordPanel,
  fromtext: FromTextPanel,
  ocr: OcrPanel,
  compress: CompressPanel,
};
