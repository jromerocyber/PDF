import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { zipSync } from "fflate";
import { PageCanvas } from "./components/PageCanvas";
import { A4, buildPdf, download, loadSource, pageText, pagesOf, uid } from "./lib/pdf";
import type { PageItem, Source } from "./lib/pdf";

const ZOOMS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4];
const baseName = (n: string) => n.replace(/\.pdf$/i, "");

export default function App() {
  const [sources, setSources] = useState<Map<string, Source>>(new Map());
  const [pages, setPagesRaw] = useState<PageItem[]>([]);
  const [past, setPast] = useState<PageItem[][]>([]);
  const [future, setFuture] = useState<PageItem[][]>([]);
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
  const [dragKey, setDragKey] = useState<string | null>(null);
  const [dropOver, setDropOver] = useState(false);

  const openInput = useRef<HTMLInputElement>(null);
  const addInput = useRef<HTMLInputElement>(null);
  const viewer = useRef<HTMLDivElement>(null);
  const searchInput = useRef<HTMLInputElement>(null);

  /** Cambia las páginas guardando historial para deshacer/rehacer. */
  const setPages = useCallback(
    (next: PageItem[] | ((p: PageItem[]) => PageItem[])) => {
      setPagesRaw((prev) => {
        const value = typeof next === "function" ? next(prev) : next;
        setPast((h) => [...h.slice(-99), prev]);
        setFuture([]);
        return value;
      });
    },
    [],
  );

  const undo = () => {
    if (!past.length) return;
    setFuture((f) => [pages, ...f]);
    setPagesRaw(past[past.length - 1]);
    setPast((h) => h.slice(0, -1));
  };
  const redo = () => {
    if (!future.length) return;
    setPast((h) => [...h, pages]);
    setPagesRaw(future[0]);
    setFuture((f) => f.slice(1));
  };

  const run = async (label: string, fn: () => Promise<void>) => {
    setBusy(label);
    setError(null);
    try {
      await fn();
    } catch (e) {
      console.error(e);
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const openFiles = (files: FileList | File[], append: boolean) =>
    run("Abriendo…", async () => {
      const pdfs = [...files].filter((f) => f.type === "application/pdf" || /\.pdf$/i.test(f.name));
      if (!pdfs.length) throw new Error("Selecciona un archivo PDF");
      const loaded = await Promise.all(pdfs.map((f) => loadSource(f)));
      const newPages = loaded.flatMap(pagesOf);
      setSources((prev) => {
        const m = new Map(append ? prev : []);
        loaded.forEach((s) => m.set(s.id, s));
        return m;
      });
      if (append) {
        setPages((p) => [...p, ...newPages]);
      } else {
        setPagesRaw(newPages);
        setPast([]);
        setFuture([]);
        setFileName(pdfs.length === 1 ? pdfs[0].name : "combinado.pdf");
        setSelected(new Set());
        setMatches([]);
        setActiveQuery("");
        viewer.current?.scrollTo({ top: 0 });
      }
    });

  const save = () =>
    run("Guardando…", async () => {
      download(await buildPdf(pages, sources), fileName);
    });

  const selectedPages = useMemo(() => pages.filter((p) => selected.has(p.key)), [pages, selected]);
  /** Las páginas sobre las que actúan los botones: la selección o, si no hay, la página actual. */
  const targets = useCallback(
    () => (selected.size ? selected : new Set(pages[current] ? [pages[current].key] : [])),
    [selected, pages, current],
  );

  const rotate = (deg: number) => {
    const t = targets();
    setPages((ps) => ps.map((p) => (t.has(p.key) ? { ...p, rotation: (p.rotation + deg + 360) % 360 } : p)));
  };
  const remove = () => {
    const t = targets();
    if (t.size >= pages.length) return setError("No se pueden eliminar todas las páginas");
    setPages((ps) => ps.filter((p) => !t.has(p.key)));
    setSelected(new Set());
  };
  const insertBlank = () => {
    const blank: PageItem = { key: uid(), kind: "blank", width: A4[0], height: A4[1], rotation: 0 };
    setPages((ps) => [...ps.slice(0, current + 1), blank, ...ps.slice(current + 1)]);
  };
  const extract = () =>
    run("Extrayendo…", async () => {
      const list = selectedPages.length ? selectedPages : [pages[current]];
      download(await buildPdf(list, sources), `${baseName(fileName)}_extracto.pdf`);
    });
  const split = () =>
    run("Dividiendo…", async () => {
      const files: Record<string, Uint8Array> = {};
      for (let i = 0; i < pages.length; i++) {
        files[`${baseName(fileName)}_p${String(i + 1).padStart(3, "0")}.pdf`] = await buildPdf([pages[i]], sources);
      }
      download(zipSync(files, { level: 0 }), `${baseName(fileName)}_paginas.zip`, "application/zip");
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
      const els = root.querySelectorAll<HTMLElement>("[data-index]");
      let idx = 0;
      for (const el of els) {
        if (el.offsetTop <= mid) idx = Number(el.dataset.index);
        else break;
      }
      setCurrent(idx);
    };
    onScroll();
    // Las páginas cambian de tamaño al conocerse sus dimensiones o al hacer zoom.
    const ro = new ResizeObserver(onScroll);
    root.querySelectorAll("[data-index]").forEach((el) => ro.observe(el));
    root.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      ro.disconnect();
      root.removeEventListener("scroll", onScroll);
    };
  }, [pages]);

  const fitWidth = async () => {
    const p = pages[current];
    const root = viewer.current;
    if (!p || !root) return;
    let w = p.kind === "blank" ? p.width : 0;
    if (p.kind === "src") {
      const page = await sources.get(p.srcId)!.doc.getPage(p.index + 1);
      w = page.getViewport({ scale: 1, rotation: (page.rotate + p.rotation) % 360 }).width;
    }
    setScale(Math.max(0.1, (root.clientWidth - 64) / w));
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
      const typing = (e.target as HTMLElement).tagName === "INPUT";
      if (mod && e.key === "o") (e.preventDefault(), openInput.current?.click());
      else if (mod && e.key === "s" && pages.length) (e.preventDefault(), save());
      else if (mod && e.key === "f" && pages.length) (e.preventDefault(), searchInput.current?.focus());
      else if (mod && e.key === "z" && !typing) (e.preventDefault(), e.shiftKey ? redo() : undo());
      else if (mod && e.key === "y" && !typing) (e.preventDefault(), redo());
      else if (mod && (e.key === "+" || e.key === "=")) (e.preventDefault(), zoom(1));
      else if (mod && e.key === "-") (e.preventDefault(), zoom(-1));
      else if (e.key === "Delete" && !typing && selected.size) remove();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const has = pages.length > 0;
  const nTargets = selected.size || (has ? 1 : 0);

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
      <header className="toolbar">
        <div className="brand">PDF Studio</div>
        <div className="group">
          <button onClick={() => openInput.current?.click()} title="Abrir (Ctrl+O)">Abrir</button>
          <button onClick={() => addInput.current?.click()} disabled={!has} title="Añadir otro PDF al final">Unir PDF</button>
          <button className="primary" onClick={save} disabled={!has} title="Guardar (Ctrl+S)">Guardar</button>
        </div>
        <div className="group">
          <button onClick={undo} disabled={!past.length} title="Deshacer (Ctrl+Z)">↶</button>
          <button onClick={redo} disabled={!future.length} title="Rehacer (Ctrl+Y)">↷</button>
        </div>
        <div className="group">
          <button onClick={() => zoom(-1)} disabled={!has} title="Alejar">−</button>
          <span className="zoom">{Math.round(scale * 100)}%</span>
          <button onClick={() => zoom(1)} disabled={!has} title="Acercar">+</button>
          <button onClick={fitWidth} disabled={!has}>Ajustar ancho</button>
        </div>
        <div className="group">
          <button onClick={() => rotate(-90)} disabled={!has} title={`Rotar a la izquierda (${nTargets})`}>⟲</button>
          <button onClick={() => rotate(90)} disabled={!has} title={`Rotar a la derecha (${nTargets})`}>⟳</button>
          <button onClick={remove} disabled={!has} title={`Eliminar páginas (${nTargets})`}>Eliminar</button>
          <button onClick={insertBlank} disabled={!has} title="Insertar página en blanco tras la actual">+ En blanco</button>
          <button onClick={extract} disabled={!has} title="Guardar las páginas seleccionadas como PDF nuevo">Extraer</button>
          <button onClick={split} disabled={!has} title="Una página por archivo (ZIP)">Dividir</button>
        </div>
        <form
          className="group search"
          onSubmit={(e) => {
            e.preventDefault();
            search(1);
          }}
        >
          <input ref={searchInput} value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Buscar… (Ctrl+F)" disabled={!has} />
          {activeQuery && (
            <span className="count">{matches.length ? `${matchIdx + 1}/${matches.length} pág.` : "0"}</span>
          )}
          <button type="button" onClick={() => search(-1)} disabled={!matches.length}>▲</button>
          <button type="submit" disabled={!has}>▼</button>
        </form>
        <input ref={openInput} type="file" accept="application/pdf,.pdf" multiple hidden onChange={(e) => (e.target.files && openFiles(e.target.files, false), (e.target.value = ""))} />
        <input ref={addInput} type="file" accept="application/pdf,.pdf" multiple hidden onChange={(e) => (e.target.files && openFiles(e.target.files, true), (e.target.value = ""))} />
      </header>

      {(error || busy) && <div className={`notice ${error ? "error" : ""}`} onClick={() => setError(null)}>{error ?? busy}</div>}

      {!has ? (
        <main className="empty">
          <div className="empty-card" onClick={() => openInput.current?.click()}>
            <div className="empty-icon">PDF</div>
            <h1>Abre o arrastra un PDF</h1>
            <p>Ver, buscar, rotar, reordenar, unir, dividir y extraer páginas. Todo se procesa en tu equipo: el archivo no sale de él.</p>
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
          <div className="viewer" ref={viewer}>
            {pages.map((p, i) => (
              <div key={p.key} data-index={i} className="page">
                <PageCanvas
                  item={p}
                  source={p.kind === "src" ? sources.get(p.srcId) : undefined}
                  scale={scale}
                  textLayer
                  highlight={activeQuery}
                />
              </div>
            ))}
          </div>
        </main>
      )}

      <footer className="status">
        {has ? (
          <>
            <span>{fileName}</span>
            <span>
              Página{" "}
              <input
                className="pageno"
                type="number"
                min={1}
                max={pages.length}
                value={current + 1}
                onChange={(e) => goTo(Math.min(pages.length, Math.max(1, Number(e.target.value))) - 1)}
              />{" "}
              de {pages.length}
            </span>
          </>
        ) : (
          <span>Listo</span>
        )}
      </footer>
    </div>
  );
}
