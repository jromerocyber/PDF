import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { zipSync } from "fflate";
import type { PageViewport } from "pdfjs-dist";
import { PageCanvas } from "./components/PageCanvas";
import { Overlay } from "./components/Overlay";
import type { Pending, Style, Tool } from "./components/Overlay";
import { FormLayer } from "./components/FormLayer";
import { SignaturePad } from "./components/SignaturePad";
import { CommentsPanel } from "./components/CommentsPanel";
import { Icon } from "./components/Icon";
import { A4, buildPdf, download, loadSource, pageText, pagesOf, uid } from "./lib/pdf";
import type { BuildOptions, PageItem, Source } from "./lib/pdf";
import type { Annot, DocState, Rect } from "./lib/model";
import { emptyState } from "./lib/model";
import { STAMPS, imageFromFile, makeStamp } from "./lib/stamps";
import { Panels } from "./panels";
import { DialogHost, askConfirm, askText } from "./components/Dialogs";
import { desktop } from "./lib/desktop";
import type { PanelId } from "./panels";

const TOOL_NAMES: Partial<Record<Tool, string>> = {
  highlight: "Resaltar: selecciona el texto",
  underline: "Subrayar: selecciona el texto",
  strike: "Tachar: selecciona el texto",
  ink: "Lápiz: dibuja sobre la página",
  rect: "Rectángulo: arrastra sobre la página",
  ellipse: "Elipse: arrastra sobre la página",
  line: "Línea: arrastra sobre la página",
  arrow: "Flecha: arrastra sobre la página",
  text: "Texto: haz clic o arrastra donde quieras escribir",
  note: "Nota: haz clic donde quieras dejarla",
  place: "Haz clic donde quieras colocarlo",
  edit: "Editar texto: haz clic sobre el texto a cambiar",
  redact: "Redacción: arrastra sobre la zona a eliminar",
  "field-text": "Campo de texto: arrastra o haz clic",
  "field-multiline": "Campo multilínea: arrastra o haz clic",
  "field-check": "Casilla: haz clic donde colocarla",
  hand: "Mano: arrastra para desplazarte",
};
const ZOOMS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4];
const baseName = (n: string) => n.replace(/\.pdf$/i, "");
type Tab = "inicio" | "comentar" | "editar" | "formularios" | "proteger" | "convertir";

const loadPref = <T,>(k: string, d: T): T => {
  try {
    const v = localStorage.getItem("pdfstudio." + k);
    return v ? (JSON.parse(v) as T) : d;
  } catch {
    return d;
  }
};
const savePref = (k: string, v: unknown) => {
  try {
    localStorage.setItem("pdfstudio." + k, JSON.stringify(v));
  } catch {
    /* sin almacenamiento */
  }
};

export default function App() {
  const [sources, setSources] = useState<Map<string, Source>>(new Map());
  const [doc, setDocRaw] = useState<DocState>(emptyState);
  const [past, setPast] = useState<DocState[]>([]);
  const [future, setFuture] = useState<DocState[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [anchor, setAnchor] = useState<string | null>(null);
  const [scale, setScale] = useState(1);
  const [current, setCurrent] = useState(0);
  const [fileName, setFileName] = useState("documento.pdf");
  const [query, setQuery] = useState("");
  const [activeQuery, setActiveQuery] = useState("");
  const [matches, setMatches] = useState<number[]>([]);
  const [matchIdx, setMatchIdx] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [dragKey, setDragKey] = useState<string | null>(null);
  const [dropOver, setDropOver] = useState(false);
  const [tab, setTab] = useState<Tab>("inicio");
  const [tool, setTool] = useState<Tool>("select");
  const [style, setStyle] = useState<Style>(() =>
    loadPref("style", { color: "#e11d48", width: 2, opacity: 1, size: 12, font: "Helvetica", fill: null, author: "" } as Style),
  );
  const [pending, setPending] = useState<Pending | null>(null);
  const [selAnnot, setSelAnnot] = useState<{ page: string; id: string } | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [showSig, setShowSig] = useState(false);
  const [showComments, setShowComments] = useState(false);
  const [panel, setPanel] = useState<PanelId | null>(null);
  const [flattenOnSave, setFlattenOnSave] = useState(false);
  const [dirty, setDirty] = useState(false);
  /** Páginas tal como se abrieron (sin modificar): para firmar sin romper firmas previas. */
  const [pristine, setPristine] = useState<PageItem[] | null>(null);

  const openInput = useRef<HTMLInputElement>(null);
  const addInput = useRef<HTMLInputElement>(null);
  const imgInput = useRef<HTMLInputElement>(null);
  const viewer = useRef<HTMLDivElement>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const viewports = useRef(new Map<string, PageViewport>());

  const pages = doc.pages;
  useEffect(() => savePref("style", style), [style]);

  /** Aplica un cambio guardando historial (deshacer/rehacer). */
  const commit = useCallback((fn: (d: DocState) => DocState) => {
    setDocRaw((prev) => {
      const next = fn(prev);
      if (next === prev) return prev;
      setPast((h) => [...h.slice(-99), prev]);
      setFuture([]);
      setDirty(true);
      return next;
    });
  }, []);
  const setPages = useCallback((fn: (p: PageItem[]) => PageItem[]) => commit((d) => ({ ...d, pages: fn(d.pages) })), [commit]);

  const undo = () => {
    if (!past.length) return;
    setFuture((f) => [doc, ...f]);
    setDocRaw(past[past.length - 1]);
    setPast((h) => h.slice(0, -1));
  };
  const redo = () => {
    if (!future.length) return;
    setPast((h) => [...h, doc]);
    setDocRaw(future[0]);
    setFuture((f) => f.slice(1));
  };

  const runId = useRef(0);
  const [slow, setSlow] = useState(false);
  const run = async (label: string, fn: () => Promise<void>) => {
    const id = ++runId.current;
    setBusy(label);
    setSlow(false);
    setError(null);
    const slowTimer = setTimeout(() => runId.current === id && setSlow(true), 15000);
    try {
      await fn();
    } catch (e) {
      console.error(e);
      if (runId.current === id) setError(e instanceof Error ? e.message : typeof e === "string" ? e : JSON.stringify(e));
    } finally {
      clearTimeout(slowTimer);
      if (runId.current === id) (setBusy(null), setSlow(false));
    }
  };
  /** Deja de esperar una tarea que tarda demasiado (la interfaz vuelve a estar disponible). */
  const cancelRun = () => {
    runId.current++;
    setBusy(null);
    setSlow(false);
    setInfo("Tarea cancelada");
  };
  const notify = (m: string) => {
    setInfo(m);
    setTimeout(() => setInfo((x) => (x === m ? null : x)), 4000);
  };
  // Cualquier error inesperado se muestra en pantalla (nunca falla en silencio).
  useEffect(() => {
    const msg = (r: unknown) => (r instanceof Error ? r.message : typeof r === "string" ? r : "Error inesperado");
    const onRej = (e: PromiseRejectionEvent) => setError("Error inesperado: " + msg(e.reason));
    const onErr = (e: ErrorEvent) => setError("Error inesperado: " + (e.message || "desconocido"));
    window.addEventListener("unhandledrejection", onRej);
    window.addEventListener("error", onErr);
    return () => (window.removeEventListener("unhandledrejection", onRej), window.removeEventListener("error", onErr));
  }, []);
  // Los errores también desaparecen solos (antes se quedaban fijos).
  useEffect(() => {
    if (!error) return;
    const t = setTimeout(() => setError(null), 9000);
    return () => clearTimeout(t);
  }, [error]);

  /** Abre/añade documentos ya cargados. */
  const addSources = useCallback(
    (loaded: Source[], append: boolean, name?: string) => {
      const newPages = loaded.flatMap(pagesOf);
      setSources((prev) => {
        const m = new Map(append ? prev : []);
        loaded.forEach((s) => m.set(s.id, s));
        return m;
      });
      if (append) {
        commit((d) => ({ ...d, pages: [...d.pages, ...newPages] }));
      } else {
        setDocRaw({ ...emptyState(), pages: newPages });
        setPristine(loaded.length === 1 ? newPages : null);
        setPast([]);
        setFuture([]);
        setDirty(false);
        setFileName(name ?? (loaded.length === 1 ? loaded[0].name : "combinado.pdf"));
        setSelected(new Set());
        setSelAnnot(null);
        setMatches([]);
        setActiveQuery("");
        viewer.current?.scrollTo({ top: 0 });
      }
    },
    [commit],
  );

  const askPassword = useCallback((name: string, retry: boolean) => {
    return askText("Documento protegido", `${retry ? "Contraseña incorrecta. " : ""}"${name}" está protegido. Introduce la contraseña:`, true);
  }, []);

  const openFiles = (files: FileList | File[], append: boolean) =>
    run("Abriendo…", async () => {
      const list = [...files];
      const imgs = list.filter((f) => f.type.startsWith("image/"));
      const pdfs = list.filter((f) => f.type === "application/pdf" || /\.pdf$/i.test(f.name));
      if (!pdfs.length && !imgs.length) throw new Error("Selecciona un archivo PDF o una imagen");
      const loaded: Source[] = [];
      for (const f of pdfs) loaded.push(await loadSource(f, askPassword));
      if (imgs.length) {
        const { imagesToPdf } = await import("./lib/convert");
        const bytes = await imagesToPdf(imgs);
        loaded.push(await loadSource({ name: imgs.length === 1 ? baseName(imgs[0].name) + ".pdf" : "imagenes.pdf", bytes }));
      }
      addSources(loaded, append);
    });

  const buildOpts = (extra: Partial<BuildOptions> = {}): BuildOptions => ({
    annots: doc.annots,
    forms: doc.forms,
    flattenAnnots: flattenOnSave,
    ...extra,
  });

  /** Bytes del documento actual tal como se guardaría. */
  // Caché: si el documento no ha cambiado no se vuelve a generar (puede tardar en PDF grandes).
  const bytesCache = useRef<{ doc: DocState; flatten: boolean; bytes: Promise<Uint8Array> } | null>(null);
  const currentBytes = useCallback(
    async (extra: Partial<BuildOptions> = {}) => {
      const cacheable = !Object.keys(extra).length;
      const c = bytesCache.current;
      if (cacheable && c && c.doc === doc && c.flatten === flattenOnSave) return (await c.bytes).slice();
      // Documento recién abierto y sin cambios: sus bytes originales (instantáneo).
      const untouched = pristine && doc.pages === pristine && !Object.values(doc.annots).some((l) => l.length) && !Object.keys(doc.forms).length && !flattenOnSave;
      const first = pages[0];
      const job = (async () => {
        if (cacheable && untouched && first?.kind === "src") return sources.get(first.srcId)!.bytes;
        const { applyRedactions } = await import("./lib/redact");
        const hasRedact = Object.values(doc.annots).some((l) => l.some((a) => a.type === "redact"));
        return buildPdf(pages, sources, {
          annots: doc.annots,
          forms: doc.forms,
          flattenAnnots: flattenOnSave,
          post: hasRedact ? (d, ps) => applyRedactions(d, ps, doc.annots, sources) : undefined,
          ...extra,
        });
      })();
      if (cacheable) {
        bytesCache.current = { doc, flatten: flattenOnSave, bytes: job };
        job.catch(() => (bytesCache.current = null));
      }
      return (await job).slice();
    },
    [doc, pages, sources, flattenOnSave, pristine],
  );

  /** Sustituye el documento por una nueva versión (manteniendo deshacer). */
  const replaceDoc = useCallback(
    async (bytes: Uint8Array) => {
      const src = await loadSource({ name: fileName, bytes }, askPassword);
      const newPages = pagesOf(src);
      setSources((prev) => new Map(prev).set(src.id, src));
      commit(() => ({ ...emptyState(), pages: newPages }));
      setPristine(newPages);
      setSelected(new Set());
      setSelAnnot(null);
    },
    [fileName, askPassword, commit],
  );

  const pristineBytes = useCallback(async () => {
    const untouched = pristine && doc.pages === pristine && !Object.values(doc.annots).some((l) => l.length) && !Object.keys(doc.forms).length;
    const first = pages[0];
    if (untouched && first?.kind === "src") return { bytes: sources.get(first.srcId)!.bytes, pristine: true };
    return { bytes: await currentBytes(), pristine: false };
  }, [pristine, doc, pages, sources, currentBytes]);

  const save = () =>
    run("Guardando…", async () => {
      const hasRedact = Object.values(doc.annots).some((l) => l.some((a) => a.type === "redact"));
      if (hasRedact && !(await askConfirm("Aplicar redacciones", "Se aplicarán las redacciones: el contenido marcado se eliminará de forma permanente en el archivo guardado. ¿Continuar?", true))) return;
      if (await download(await currentBytes(), fileName)) {
        setDirty(false);
        if (desktop.available) notify("Guardado");
      }
    });

  const selectedPages = useMemo(() => pages.filter((p) => selected.has(p.key)), [pages, selected]);
  const targets = useCallback(() => (selected.size ? selected : new Set(pages[current] ? [pages[current].key] : [])), [selected, pages, current]);

  const rotate = (deg: number) => {
    const t = targets();
    setPages((ps) => ps.map((p) => (t.has(p.key) ? { ...p, rotation: (p.rotation + deg + 360) % 360 } : p)));
  };
  const removePages = () => {
    const t = targets();
    if (t.size >= pages.length) return setError("No se pueden eliminar todas las páginas");
    setPages((ps) => ps.filter((p) => !t.has(p.key)));
    setSelected(new Set());
  };
  const insertBlank = () => {
    const blank: PageItem = { key: uid(), kind: "blank", width: A4[0], height: A4[1], rotation: 0 };
    setPages((ps) => [...ps.slice(0, current + 1), blank, ...ps.slice(current + 1)]);
  };
  const duplicatePages = () => {
    const t = targets();
    commit((d) => {
      const annots = { ...d.annots };
      const ps = d.pages.flatMap((p) => {
        if (!t.has(p.key)) return [p];
        const copy = { ...p, key: uid() };
        if (d.annots[p.key]) annots[copy.key] = d.annots[p.key].map((a) => ({ ...a, id: uid("a") }));
        return [p, copy];
      });
      return { ...d, pages: ps, annots };
    });
  };
  const extract = () =>
    run("Extrayendo…", async () => {
      const list = selectedPages.length ? selectedPages : [pages[current]];
      await download(await buildPdf(list, sources, buildOpts()), `${baseName(fileName)}_extracto.pdf`);
    });
  const split = () =>
    run("Dividiendo…", async () => {
      const files: Record<string, Uint8Array> = {};
      for (let i = 0; i < pages.length; i++) {
        files[`${baseName(fileName)}_p${String(i + 1).padStart(3, "0")}.pdf`] = await buildPdf([pages[i]], sources, buildOpts());
      }
      await download(zipSync(files, { level: 0 }), `${baseName(fileName)}_paginas.zip`, "application/zip");
    });

  const goTo = useCallback((i: number) => {
    const el = viewer.current?.querySelector<HTMLElement>(`[data-index="${i}"]`);
    el?.scrollIntoView({ block: "start" });
  }, []);

  // Página actual según el scroll.
  useEffect(() => {
    const root = viewer.current;
    if (!root) return;
    const onScroll = () => {
      const mid = root.scrollTop + root.clientHeight / 3;
      let idx = 0;
      for (const el of root.querySelectorAll<HTMLElement>("[data-index]")) {
        if (el.offsetTop <= mid) idx = Number(el.dataset.index);
        else break;
      }
      setCurrent(idx);
    };
    onScroll();
    const ro = new ResizeObserver(onScroll);
    root.querySelectorAll("[data-index]").forEach((el) => ro.observe(el));
    root.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      ro.disconnect();
      root.removeEventListener("scroll", onScroll);
    };
  }, [pages]);

  const fitWidth = async (page = false) => {
    const p = pages[current];
    const root = viewer.current;
    if (!p || !root) return;
    let w = p.kind === "blank" ? p.width : 0, h = p.kind === "blank" ? p.height : 0;
    if (p.kind === "src") {
      const pg = await sources.get(p.srcId)!.doc.getPage(p.index + 1);
      const vp = pg.getViewport({ scale: 1, rotation: (pg.rotate + p.rotation) % 360 });
      w = vp.width;
      h = vp.height;
    }
    const sw = (root.clientWidth - 64) / w;
    setScale(Math.max(0.1, page ? Math.min(sw, (root.clientHeight - 48) / h) : sw));
  };
  const zoom = (dir: 1 | -1) => {
    const next = dir > 0 ? ZOOMS.find((z) => z > scale + 0.001) : [...ZOOMS].reverse().find((z) => z < scale - 0.001);
    if (next) setScale(next);
  };

  const search = (dir: 1 | -1 = 1) =>
    run("Buscando…", async () => {
      const q = query.trim().toLowerCase();
      if (!q) {
        setMatches([]);
        setActiveQuery("");
        return;
      }
      if (q === activeQuery.toLowerCase() && matches.length) {
        const n = (matchIdx + dir + matches.length) % matches.length;
        setMatchIdx(n);
        goTo(matches[n]);
        return;
      }
      const found: number[] = [];
      for (let i = 0; i < pages.length; i++) {
        const p = pages[i];
        if (p.kind !== "src") continue;
        if ((await pageText(sources.get(p.srcId)!, p.index)).toLowerCase().includes(q)) found.push(i);
      }
      setActiveQuery(query.trim());
      setMatches(found);
      const start = found.findIndex((i) => i >= current);
      const n = start === -1 ? 0 : start;
      setMatchIdx(n);
      if (found.length) goTo(found[n]);
    });

  // ---------- Anotaciones ----------
  const addAnnot = (pageKey: string, a: Annot, edit = false) => {
    commit((d) => ({ ...d, annots: { ...d.annots, [pageKey]: [...(d.annots[pageKey] ?? []), a] } }));
    setSelAnnot({ page: pageKey, id: a.id });
    if (edit) setEditingId(a.id);
    // Las herramientas de un solo uso vuelven a "Seleccionar"; el lápiz y los marcadores siguen activos.
    if (!["ink", "highlight", "underline", "strike"].includes(a.type)) setTool("select");
  };
  const updateAnnot = (pageKey: string, a: Annot) =>
    commit((d) => {
      const list = d.annots[pageKey] ?? [];
      const old = list.find((x) => x.id === a.id);
      if (!old || JSON.stringify(old) === JSON.stringify(a)) return d;
      return { ...d, annots: { ...d.annots, [pageKey]: list.map((x) => (x.id === a.id ? a : x)) } };
    });
  const deleteAnnot = (pageKey: string, id: string) => {
    commit((d) => ({ ...d, annots: { ...d.annots, [pageKey]: (d.annots[pageKey] ?? []).filter((x) => x.id !== id) } }));
    setSelAnnot(null);
  };
  const selectedAnnot = selAnnot ? doc.annots[selAnnot.page]?.find((a) => a.id === selAnnot.id) : undefined;

  /** Resaltar/subrayar/tachar a partir de la selección de texto. */
  const applyMarkup = useCallback(() => {
    if (tool !== "highlight" && tool !== "underline" && tool !== "strike") return;
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !viewer.current) return;
    const text = sel.toString();
    const byPage = new Map<string, Rect[]>();
    const pageEls = [...viewer.current.querySelectorAll<HTMLElement>("[data-key]")];
    for (let i = 0; i < sel.rangeCount; i++) {
      for (const cr of sel.getRangeAt(i).getClientRects()) {
        if (cr.width < 1 || cr.height < 1) continue;
        const cx = cr.left + cr.width / 2, cy = cr.top + cr.height / 2;
        const el = pageEls.find((e) => {
          const b = e.querySelector(".page-canvas")!.getBoundingClientRect();
          return cx >= b.left && cx <= b.right && cy >= b.top && cy <= b.bottom;
        });
        if (!el) continue;
        const key = el.dataset.key!;
        const vp = viewports.current.get(key);
        if (!vp) continue;
        const b = el.querySelector(".page-canvas")!.getBoundingClientRect();
        const [x1, y1] = vp.convertToPdfPoint(cr.left - b.left, cr.top - b.top);
        const [x2, y2] = vp.convertToPdfPoint(cr.right - b.left, cr.bottom - b.top);
        const r: Rect = [Math.min(x1, x2), Math.min(y1, y2), Math.max(x1, x2), Math.max(y1, y2)];
        const list = byPage.get(key) ?? [];
        // Unir rectángulos contiguos de la misma línea.
        const same = list.find((q) => Math.abs(q[1] - r[1]) < 2 && Math.abs(q[3] - r[3]) < 2 && r[0] <= q[2] + 3 && r[2] >= q[0] - 3);
        if (same) {
          same[0] = Math.min(same[0], r[0]);
          same[2] = Math.max(same[2], r[2]);
        } else list.push(r);
        byPage.set(key, list);
      }
    }
    if (!byPage.size) return;
    commit((d) => {
      const annots = { ...d.annots };
      for (const [key, quads] of byPage) {
        const a: Annot = {
          id: uid("a"),
          type: tool,
          quads,
          text,
          color: tool === "highlight" && style.color === "#e11d48" ? "#ffd400" : style.color,
          opacity: tool === "highlight" ? Math.min(style.opacity, 0.6) : style.opacity,
          author: style.author,
          created: Date.now(),
        };
        annots[key] = [...(annots[key] ?? []), a];
      }
      return { ...d, annots };
    });
    sel.removeAllRanges();
  }, [tool, style, commit]);

  /** Herramienta "Editar texto": al hacer clic en un texto, lo tapa y crea un cuadro editable encima. */
  const onEditClick = (e: React.MouseEvent) => {
    if (tool !== "edit") return;
    const span = (e.target as HTMLElement).closest(".textLayer span:not(.markedContent)") as HTMLElement | null;
    const pageEl = (e.target as HTMLElement).closest("[data-key]") as HTMLElement | null;
    if (!span || !pageEl) return;
    const key = pageEl.dataset.key!;
    const vp = viewports.current.get(key);
    if (!vp) return;
    const b = pageEl.querySelector(".page-canvas")!.getBoundingClientRect();
    const cr = span.getBoundingClientRect();
    const [x1, y1] = vp.convertToPdfPoint(cr.left - b.left, cr.top - b.top);
    const [x2, y2] = vp.convertToPdfPoint(cr.right - b.left, cr.bottom - b.top);
    const r: Rect = [Math.min(x1, x2) - 1, Math.min(y1, y2) - 1, Math.max(x1, x2) + 2, Math.max(y1, y2) + 1];
    const size = Math.max(4, Math.round((r[3] - r[1]) * 0.78 * 2) / 2);
    const text = span.dataset.orig ?? span.textContent ?? "";
    const serif = /serif|times/i.test(span.style.fontFamily) && !/sans/i.test(span.style.fontFamily);
    addAnnot(
      key,
      { id: uid("a"), type: "text", rect: r, text, size, font: serif ? "Times-Roman" : "Helvetica", color: "#000000", opacity: 1, bg: "#ffffff", flatten: true, author: style.author, created: Date.now() },
      true,
    );
  };

  const placeStamp = (label: string, color: string) => {
    setPending({ ...makeStamp(label, color, true, style.author), kind: "stamp" });
    setTool("place");
  };

  const clickThumb = (e: React.MouseEvent, key: string, i: number) => {
    if (e.shiftKey && anchor) {
      const a = pages.findIndex((p) => p.key === anchor);
      const [s, t] = a < i ? [a, i] : [i, a];
      setSelected(new Set(pages.slice(s, t + 1).map((p) => p.key)));
    } else if (e.ctrlKey || e.metaKey) {
      setSelected((sel) => {
        const n = new Set(sel);
        if (n.has(key)) n.delete(key);
        else n.add(key);
        return n;
      });
      setAnchor(key);
    } else {
      setSelected(new Set([key]));
      setAnchor(key);
      goTo(i);
    }
  };

  const dropThumb = (targetKey: string) => {
    if (!dragKey || dragKey === targetKey) return;
    setPages((ps) => {
      const moving = selected.has(dragKey) ? ps.filter((p) => selected.has(p.key)) : ps.filter((p) => p.key === dragKey);
      const movingKeys = new Set(moving.map((p) => p.key));
      if (movingKeys.has(targetKey)) return ps;
      const rest = ps.filter((p) => !movingKeys.has(p.key));
      const at = rest.findIndex((p) => p.key === targetKey);
      const from = ps.findIndex((p) => p.key === dragKey);
      const to = ps.findIndex((p) => p.key === targetKey);
      const pos = from < to ? at + 1 : at;
      return [...rest.slice(0, pos), ...moving, ...rest.slice(pos)];
    });
    setDragKey(null);
  };

  // Atajos de teclado.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      const t = e.target as HTMLElement;
      const typing = t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT";
      if (mod && e.key === "o") (e.preventDefault(), openInput.current?.click());
      else if (mod && e.key === "s" && pages.length) (e.preventDefault(), save());
      else if (mod && e.key === "p" && pages.length) (e.preventDefault(), setPanel("print"));
      else if (mod && e.key === "f" && pages.length) (e.preventDefault(), searchInput.current?.focus());
      else if (typing) return;
      else if (mod && e.key === "z") (e.preventDefault(), e.shiftKey ? redo() : undo());
      else if (mod && e.key === "y") (e.preventDefault(), redo());
      else if (mod && (e.key === "+" || e.key === "=")) (e.preventDefault(), zoom(1));
      else if (mod && e.key === "-") (e.preventDefault(), zoom(-1));
      else if (e.key === "Escape") (setTool("select"), setSelAnnot(null), setPending(null));
      else if ((e.key === "Delete" || e.key === "Backspace") && selAnnot) deleteAnnot(selAnnot.page, selAnnot.id);
      else if (e.key === "Delete" && selected.size) removePages();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  // Escritorio: abrir el PDF con el que se lanzó la app.
  useEffect(() => {
    desktop.initialFile().then(async (f) => f && addSources([await loadSource(f, askPassword)], false)).catch((e) => setError(String(e)));
  }, [addSources, askPassword]);

  // Aviso al cerrar con cambios sin guardar.
  useEffect(() => {
    const h = (e: BeforeUnloadEvent) => {
      if (dirty) e.preventDefault();
    };
    window.addEventListener("beforeunload", h);
    return () => window.removeEventListener("beforeunload", h);
  }, [dirty]);

  const has = pages.length > 0;
  const nTargets = selected.size || (has ? 1 : 0);
  const T = (t: Tool, label: string, icon: string, title?: string) => (
    <button className={`tbtn ${tool === t ? "on" : ""}`} onClick={() => setTool(tool === t ? "select" : t)} disabled={!has} title={title ?? label}>
      <Icon name={icon} />
      <span>{label}</span>
    </button>
  );
  const B = (label: string, icon: string, onClick: () => void, title?: string, disabled = !has) => (
    <button className="tbtn" onClick={onClick} disabled={disabled} title={title ?? label}>
      <Icon name={icon} />
      <span>{label}</span>
    </button>
  );
  const P = (id: PanelId, label: string, icon: string, title?: string, always = false) => B(label, icon, () => setPanel(id), title, always ? false : !has);

  const panelCtx = {
    pages,
    sources,
    doc,
    fileName,
    current,
    selectedPages,
    commit,
    addSources,
    replaceDoc,
    currentBytes,
    pristineBytes,
    goTo,
    progress: (m: string) => setBusy(m),
    run,
    notify,
    close: () => setPanel(null),
    setError,
    askPassword,
  };

  return (
    <div
      className={`app ${dropOver ? "drop-over" : ""}`}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes("Files")) (e.preventDefault(), setDropOver(true));
      }}
      onDragLeave={(e) => e.currentTarget === e.target && setDropOver(false)}
      onDrop={(e) => {
        if (!e.dataTransfer.files.length) return;
        e.preventDefault();
        setDropOver(false);
        openFiles(e.dataTransfer.files, has);
      }}
    >
      <header className="topbar">
        <div className="brand">PDF Studio</div>
        <div className="quick">
          <button onClick={() => openInput.current?.click()} title="Abrir (Ctrl+O)"><Icon name="open" /></button>
          <button onClick={save} disabled={!has} title="Guardar (Ctrl+S)"><Icon name="save" /></button>
          <button onClick={() => setPanel("print")} disabled={!has} title="Imprimir (Ctrl+P)"><Icon name="print" /></button>
          <button onClick={undo} disabled={!past.length} title="Deshacer (Ctrl+Z)"><Icon name="undo" /></button>
          <button onClick={redo} disabled={!future.length} title="Rehacer (Ctrl+Y)"><Icon name="redo" /></button>
        </div>
        <nav className="tabs-nav">
          {(["inicio", "comentar", "editar", "formularios", "proteger", "convertir"] as Tab[]).map((t) => (
            <button key={t} className={tab === t ? "on" : ""} onClick={() => setTab(t)}>
              {{ inicio: "Inicio", comentar: "Comentar", editar: "Editar", formularios: "Formularios", proteger: "Proteger y firmar", convertir: "Convertir" }[t]}
            </button>
          ))}
        </nav>
        <form className="search" onSubmit={(e) => (e.preventDefault(), search(1))}>
          <input ref={searchInput} value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Buscar… (Ctrl+F)" disabled={!has} />
          {activeQuery && <span className="count">{matches.length ? `${matchIdx + 1}/${matches.length}` : "0"}</span>}
          <button type="button" onClick={() => search(-1)} disabled={!matches.length} title="Anterior">▲</button>
          <button type="submit" disabled={!has} title="Siguiente">▼</button>
        </form>
      </header>

      <div className="ribbon">
        {tab === "inicio" && (
          <>
            <div className="rgroup">
              {B("Abrir", "open", () => openInput.current?.click(), "Abrir PDF o imágenes (Ctrl+O)", false)}
              {B("Guardar", "save", save, "Guardar (Ctrl+S)")}
              {B("Unir", "merge", () => addInput.current?.click(), "Añadir otro PDF o imágenes al final")}
              {P("print", "Imprimir", "print")}
            </div>
            <div className="rgroup">
              {T("select", "Seleccionar", "cursor")}
              {T("hand", "Mano", "hand", "Desplazar arrastrando")}
              {B("Alejar", "zoomout", () => zoom(-1))}
              <span className="zoom">{Math.round(scale * 100)}%</span>
              {B("Acercar", "zoomin", () => zoom(1))}
              {B("Ancho", "fitw", () => fitWidth(false), "Ajustar al ancho")}
              {B("Página", "fitp", () => fitWidth(true), "Página completa")}
            </div>
            <div className="rgroup">
              {B("Izquierda", "rotl", () => rotate(-90), `Rotar a la izquierda (${nTargets})`)}
              {B("Derecha", "rotr", () => rotate(90), `Rotar a la derecha (${nTargets})`)}
              {B("Eliminar", "trash", removePages, `Eliminar páginas (${nTargets})`)}
              {B("Duplicar", "copy", duplicatePages, `Duplicar páginas (${nTargets})`)}
              {B("En blanco", "blank", insertBlank, "Insertar página en blanco tras la actual")}
              {B("Extraer", "extract", extract, "Guardar las páginas seleccionadas como PDF nuevo")}
              {B("Dividir", "split", split, "Una página por archivo (ZIP)")}
              {P("crop", "Recortar", "crop", "Recortar márgenes de las páginas")}
            </div>
            <div className="rgroup">
              {B("Comentarios", "list", () => setShowComments((s) => !s), "Lista de comentarios")}
              {P("properties", "Propiedades", "info", "Propiedades y metadatos")}
              {P("outline", "Marcadores", "bookmark", "Marcadores e índice")}
            </div>
          </>
        )}
        {tab === "comentar" && (
          <>
            <div className="rgroup">
              {T("select", "Seleccionar", "cursor", "Seleccionar y mover comentarios (Esc)")}
              {T("highlight", "Resaltar", "highlight", "Selecciona texto para resaltarlo")}
              {T("underline", "Subrayar", "underline")}
              {T("strike", "Tachar", "strike")}
              {T("note", "Nota", "note", "Haz clic para añadir una nota")}
              {T("text", "Texto", "text", "Cuadro de texto")}
            </div>
            <div className="rgroup">
              {T("ink", "Lápiz", "pen", "Dibujo a mano alzada")}
              {T("rect", "Rectángulo", "rect")}
              {T("ellipse", "Elipse", "ellipse")}
              {T("line", "Línea", "line")}
              {T("arrow", "Flecha", "arrow")}
            </div>
            <div className="rgroup">
              <label className="stamp-pick">
                <Icon name="stamp" />
                <select value="" disabled={!has} onChange={(e) => e.target.value && placeStamp(e.target.value, STAMPS.find((s) => s.label === e.target.value)!.color)}>
                  <option value="">Sello…</option>
                  {STAMPS.map((s) => (
                    <option key={s.label} value={s.label}>{s.label}</option>
                  ))}
                </select>
              </label>
              {B("Firma", "sign", () => setShowSig(true), "Firma manuscrita (dibujada, escrita o imagen)")}
              {B("Imagen", "image", () => imgInput.current?.click())}
            </div>
            <StyleBar style={style} setStyle={setStyle} selected={selectedAnnot} onApply={(patch) => selAnnot && selectedAnnot && updateAnnot(selAnnot.page, { ...selectedAnnot, ...patch } as Annot)} />
          </>
        )}
        {tab === "editar" && (
          <>
            <div className="rgroup">
              {T("select", "Seleccionar", "cursor", "Seleccionar y mover (Esc)")}
              {T("edit", "Editar texto", "edittext", "Haz clic sobre un texto del documento para modificarlo")}
              {T("text", "Añadir texto", "text")}
              {B("Imagen", "image", () => imgInput.current?.click(), "Añadir imagen")}
              {T("rect", "Forma", "rect")}
            </div>
            <div className="rgroup">
              {P("watermark", "Marca de agua", "watermark")}
              {P("headerfooter", "Encabezado y pie", "header", "Encabezado, pie y numeración de páginas")}
              {P("bates", "Bates", "hash", "Numeración Bates")}
              {P("background", "Fondo", "fill", "Color de fondo de página")}
            </div>
            <div className="rgroup">
              {B("Insertar PDF", "merge", () => addInput.current?.click())}
              {B("En blanco", "blank", insertBlank)}
              {P("attachments", "Adjuntos", "clip", "Archivos adjuntos")}
              {P("compare", "Comparar", "compare", "Comparar con otro PDF")}
            </div>
            <StyleBar style={style} setStyle={setStyle} selected={selectedAnnot} onApply={(patch) => selAnnot && selectedAnnot && updateAnnot(selAnnot.page, { ...selectedAnnot, ...patch } as Annot)} />
          </>
        )}
        {tab === "formularios" && (
          <>
            <div className="rgroup">
              {T("select", "Rellenar", "cursor", "Rellena los campos del formulario directamente sobre el documento")}
              {T("field-text", "Campo texto", "field", "Crear campo de texto")}
              {T("field-multiline", "Texto multilínea", "fieldml")}
              {T("field-check", "Casilla", "check", "Crear casilla de verificación")}
            </div>
            <div className="rgroup">
              {P("formdata", "Datos", "table", "Exportar/importar datos del formulario")}
              {B("Borrar datos", "eraser", () => commit((d) => ({ ...d, forms: Object.fromEntries(Object.keys(d.forms).map((k) => [k, typeof d.forms[k] === "boolean" ? false : ""])) })), "Vaciar los valores introducidos")}
            </div>
          </>
        )}
        {tab === "proteger" && (
          <>
            <div className="rgroup">
              {T("select", "Seleccionar", "cursor", "Seleccionar (Esc)")}
              {P("sign", "Firmar con certificado", "cert", "Firma digital con certificado (.p12/.pfx, DNIe, tarjeta)")}
              {P("verify", "Verificar firmas", "verify", "Comprobar las firmas digitales del documento")}
              {B("Firma manuscrita", "sign", () => (setTab("comentar"), setShowSig(true)))}
            </div>
            <div className="rgroup">
              {P("encrypt", "Contraseña", "lock", "Proteger con contraseña y permisos (AES-256)")}
              {P("decrypt", "Quitar seguridad", "unlock", "Guardar sin contraseña")}
            </div>
            <div className="rgroup">
              {T("redact", "Marcar redacción", "redact", "Marca zonas a eliminar definitivamente")}
              {P("redactsearch", "Buscar y redactar", "search", "Marcar todas las apariciones de un texto")}
              {P("sanitize", "Limpiar documento", "broom", "Quitar metadatos, JavaScript, adjuntos y datos ocultos")}
            </div>
          </>
        )}
        {tab === "convertir" && (
          <>
            <div className="rgroup">
              {P("toimages", "A imágenes", "image", "Exportar páginas como PNG/JPG")}
              {P("toword", "A Word", "word", "Convertir a .docx editable")}
              {P("totext", "A texto", "text", "Extraer todo el texto")}
              {P("tohtml", "A HTML", "code")}
            </div>
            <div className="rgroup">
              {B("Desde imágenes", "image", () => openInput.current?.click(), "Crear PDF desde imágenes (JPG, PNG…)", false)}
              {P("fromword", "Desde Word", "word", "Crear PDF desde .docx", true)}
              {P("fromtext", "Desde texto", "text", "Crear PDF desde texto o HTML", true)}
            </div>
            <div className="rgroup">
              {P("ocr", "OCR", "ocr", "Reconocer texto en documentos escaneados")}
              {P("compress", "Comprimir", "compress", "Reducir el tamaño del archivo")}
            </div>
          </>
        )}
      </div>

      <input ref={openInput} type="file" accept="application/pdf,.pdf,image/*" multiple hidden onChange={(e) => (e.target.files && openFiles(e.target.files, false), (e.target.value = ""))} />
      <input ref={addInput} type="file" accept="application/pdf,.pdf,image/*" multiple hidden onChange={(e) => (e.target.files && openFiles(e.target.files, true), (e.target.value = ""))} />
      <input
        ref={imgInput}
        type="file"
        accept="image/*"
        hidden
        onChange={async (e) => {
          const f = e.target.files?.[0];
          e.target.value = "";
          if (!f) return;
          setPending({ ...(await imageFromFile(f)), kind: "image" });
          setTool("place");
          notify("Haz clic en la página donde quieras colocar la imagen");
        }}
      />

      {(error || info) && (
        <div className={`notice ${error ? "error" : ""}`} role={error ? "alert" : "status"} onClick={() => (setError(null), setInfo(null))}>
          {error ?? info}
          {error && <span className="notice-close"> ✕</span>}
        </div>
      )}
      {busy && !error && (
        <div className="busy-overlay" role="status" aria-live="polite">
          <div className="busy-box">
            <div className="spinner" />
            <span>{busy}</span>
            {slow && <button onClick={cancelRun}>Cancelar</button>}
          </div>
        </div>
      )}

      {!has ? (
        <main className="empty">
          <div className="empty-card" onClick={() => openInput.current?.click()}>
            <div className="empty-icon">PDF</div>
            <h1>Abre o arrastra un PDF</h1>
            <p>Ver, comentar, editar, rellenar formularios, firmar con certificado, proteger, convertir y organizar. Todo se procesa en tu equipo: el archivo no sale de él.</p>
            <button className="primary">Abrir archivo</button>
          </div>
        </main>
      ) : (
        <main className="workspace">
          <aside className="thumbs">
            <div className="thumbs-head">
              {selected.size ? `${selected.size} seleccionadas` : `${pages.length} páginas`}
              {selected.size > 0 && <button className="link" onClick={() => setSelected(new Set())}>Quitar</button>}
            </div>
            {pages.map((p, i) => (
              <div
                key={p.key}
                className={`thumb ${selected.has(p.key) ? "sel" : ""} ${i === current ? "cur" : ""}`}
                draggable
                onDragStart={(e) => (setDragKey(p.key), e.dataTransfer.setData("text/plain", p.key))}
                onDragOver={(e) => dragKey && e.preventDefault()}
                onDrop={(e) => (e.preventDefault(), e.stopPropagation(), dropThumb(p.key))}
                onClick={(e) => clickThumb(e, p.key, i)}
              >
                <PageCanvas item={p} source={p.kind === "src" ? sources.get(p.srcId) : undefined} scale={0.18} rootMargin="300px" />
                <span>{i + 1}</span>
              </div>
            ))}
          </aside>
          {TOOL_NAMES[tool] && (
            <div className="tool-banner" role="status">
              <span>{TOOL_NAMES[tool]}</span>
              <button onClick={() => (setTool("select"), setPending(null))}>Terminar (Esc)</button>
            </div>
          )}
          <div
            className={`viewer tool-${tool}`}
            ref={viewer}
            onMouseUp={applyMarkup}
            onClick={onEditClick}
            onPointerDown={(e) => {
              if (tool !== "hand" || !viewer.current) return;
              const v = viewer.current, sx = e.clientX, sy = e.clientY, l = v.scrollLeft, t = v.scrollTop;
              const mv = (ev: PointerEvent) => v.scrollTo(l - (ev.clientX - sx), t - (ev.clientY - sy));
              const up = () => (window.removeEventListener("pointermove", mv), window.removeEventListener("pointerup", up));
              window.addEventListener("pointermove", mv);
              window.addEventListener("pointerup", up);
            }}
          >
            {pages.map((p, i) => {
              const src = p.kind === "src" ? sources.get(p.srcId) : undefined;
              return (
                <div key={p.key} data-index={i} data-key={p.key} className="page">
                  <PageCanvas item={p} source={src} scale={scale} textLayer highlight={activeQuery} hideForms>
                    {(vp) => {
                      viewports.current.set(p.key, vp);
                      return (
                        <>
                          {src && p.kind === "src" && tool === "select" && (
                            <FormLayer viewport={vp} source={src} index={p.index} values={doc.forms} onChange={(k, v) => commit((d) => ({ ...d, forms: { ...d.forms, [k]: v } }))} />
                          )}
                          <Overlay
                            viewport={vp}
                            annots={doc.annots[p.key] ?? []}
                            tool={tool}
                            style={style}
                            pending={pending}
                            selectedId={selAnnot?.page === p.key ? selAnnot.id : null}
                            editingId={editingId}
                            onAdd={(a, edit) => addAnnot(p.key, a, edit)}
                            onUpdate={(a) => updateAnnot(p.key, a)}
                            onSelect={(id) => setSelAnnot(id ? { page: p.key, id } : null)}
                            onEdit={setEditingId}
                            onPlaced={() => (setPending(null), setTool("select"))}
                          />
                        </>
                      );
                    }}
                  </PageCanvas>
                </div>
              );
            })}
          </div>
          {showComments && (
            <CommentsPanel
              pages={pages}
              annots={doc.annots}
              onGo={(pageKey, id) => {
                goTo(pages.findIndex((p) => p.key === pageKey));
                setSelAnnot({ page: pageKey, id });
              }}
              onDelete={deleteAnnot}
              onClose={() => setShowComments(false)}
            />
          )}
        </main>
      )}

      <footer className="status">
        {has ? (
          <>
            <span>
              {fileName}
              {dirty ? " •" : ""}
            </span>
            <label className="row small">
              <input type="checkbox" checked={flattenOnSave} onChange={(e) => setFlattenOnSave(e.target.checked)} /> Aplanar anotaciones al guardar
            </label>
            <span>
              Página{" "}
              <input className="pageno" type="number" min={1} max={pages.length} value={current + 1} onChange={(e) => goTo(Math.min(pages.length, Math.max(1, Number(e.target.value))) - 1)} /> de {pages.length}
            </span>
          </>
        ) : (
          <span>Listo</span>
        )}
      </footer>

      {showSig && (
        <SignaturePad
          onClose={() => setShowSig(false)}
          onDone={(s) => {
            setShowSig(false);
            setPending({ ...s, kind: "signature" });
            setTool("place");
            notify("Haz clic donde quieras colocar la firma");
          }}
        />
      )}
      {panel && <Panels id={panel} ctx={panelCtx} />}
      <DialogHost />
    </div>
  );
}

function StyleBar({ style, setStyle, selected, onApply }: { style: Style; setStyle: (s: Style) => void; selected?: Annot; onApply: (p: Partial<Annot>) => void }) {
  const set = (patch: Partial<Style>) => {
    setStyle({ ...style, ...patch });
    if (!selected) return;
    const p: Record<string, unknown> = {};
    if (patch.color !== undefined) p.color = patch.color;
    if (patch.opacity !== undefined) p.opacity = patch.opacity;
    if (patch.width !== undefined && "width" in selected) p.width = patch.width;
    if (patch.size !== undefined && selected.type === "text") p.size = patch.size;
    if (patch.font !== undefined && selected.type === "text") p.font = patch.font;
    if (patch.fill !== undefined && (selected.type === "rect" || selected.type === "ellipse")) p.fill = patch.fill ?? undefined;
    if (Object.keys(p).length) onApply(p as Partial<Annot>);
  };
  return (
    <div className="rgroup stylebar">
      <label title="Color">
        <input type="color" value={style.color} onChange={(e) => set({ color: e.target.value })} />
      </label>
      <label title="Relleno" className="row small">
        <input type="checkbox" checked={!!style.fill} onChange={(e) => set({ fill: e.target.checked ? "#fde68a" : null })} />
        {style.fill && <input type="color" value={style.fill} onChange={(e) => set({ fill: e.target.value })} />}
        Relleno
      </label>
      <label className="row small" title="Grosor">
        Grosor
        <select value={style.width} onChange={(e) => set({ width: Number(e.target.value) })}>
          {[0.5, 1, 2, 3, 4, 6, 8, 12].map((w) => <option key={w} value={w}>{w}</option>)}
        </select>
      </label>
      <label className="row small" title="Opacidad">
        Opacidad
        <select value={style.opacity} onChange={(e) => set({ opacity: Number(e.target.value) })}>
          {[1, 0.8, 0.6, 0.4, 0.2].map((o) => <option key={o} value={o}>{o * 100}%</option>)}
        </select>
      </label>
      <label className="row small" title="Fuente">
        <select value={style.font} onChange={(e) => set({ font: e.target.value as Style["font"] })}>
          <option value="Helvetica">Helvetica</option>
          <option value="Helvetica-Bold">Helvetica negrita</option>
          <option value="Times-Roman">Times</option>
          <option value="Courier">Courier</option>
        </select>
        <select value={style.size} onChange={(e) => set({ size: Number(e.target.value) })}>
          {[6, 8, 9, 10, 11, 12, 14, 16, 18, 20, 24, 28, 36, 48, 72].map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
      </label>
      <label className="row small" title="Autor de los comentarios">
        Autor
        <input className="author" value={style.author} onChange={(e) => setStyle({ ...style, author: e.target.value })} placeholder="Tu nombre" />
      </label>
    </div>
  );
}
