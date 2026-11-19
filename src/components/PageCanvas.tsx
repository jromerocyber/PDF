import { useEffect, useRef, useState } from "react";
import { TextLayer } from "pdfjs-dist";
import type { RenderTask } from "pdfjs-dist";
import type { PageItem, Source } from "../lib/pdf";

interface Props {
  item: PageItem;
  source?: Source;
  scale: number;
  /** Con capa de texto (selección y búsqueda). Las miniaturas no la necesitan. */
  textLayer?: boolean;
  highlight?: string;
  /** Margen del IntersectionObserver para precargar. */
  rootMargin?: string;
}

interface Size {
  w: number;
  h: number;
}

/** Tamaño en puntos de la página ya rotada (sin escala). */
export function usePageSize(item: PageItem, source?: Source): Size | null {
  const [size, setSize] = useState<Size | null>(null);
  useEffect(() => {
    let alive = true;
    if (item.kind === "blank") {
      const swap = item.rotation % 180 !== 0;
      setSize(swap ? { w: item.height, h: item.width } : { w: item.width, h: item.height });
    } else if (source) {
      source.doc.getPage(item.index + 1).then((page) => {
        if (!alive) return;
        const vp = page.getViewport({ scale: 1, rotation: (page.rotate + item.rotation) % 360 });
        setSize({ w: vp.width, h: vp.height });
      });
    }
    return () => {
      alive = false;
    };
  }, [item, source]);
  return size;
}

export function PageCanvas({ item, source, scale, textLayer, highlight, rootMargin = "600px" }: Props) {
  const wrap = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const textDiv = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  const [textReady, setTextReady] = useState(0);
  const size = usePageSize(item, source);

  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const io = new IntersectionObserver(([e]) => setVisible(e.isIntersecting), { rootMargin });
    io.observe(el);
    return () => io.disconnect();
  }, [rootMargin]);

  useEffect(() => {
    if (!visible || !size || !canvas.current) return;
    const cv = canvas.current;
    const dpr = window.devicePixelRatio || 1;
    let task: RenderTask | null = null;
    let tl: TextLayer | null = null;
    let cancelled = false;

    cv.width = Math.floor(size.w * scale * dpr);
    cv.height = Math.floor(size.h * scale * dpr);

    if (item.kind === "blank") {
      const ctx = cv.getContext("2d")!;
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, cv.width, cv.height);
      if (textDiv.current) textDiv.current.replaceChildren();
      return;
    }
    if (!source) return;

    source.doc.getPage(item.index + 1).then(async (page) => {
      if (cancelled) return;
      const rotation = (page.rotate + item.rotation) % 360;
      const viewport = page.getViewport({ scale: scale * dpr, rotation });
      task = page.render({ canvas: cv, viewport });
      try {
        await task.promise;
      } catch {
        return; // render cancelado
      }
      if (cancelled || !textLayer || !textDiv.current) return;
      const div = textDiv.current;
      div.replaceChildren();
      div.style.setProperty("--total-scale-factor", String(scale));
      tl = new TextLayer({
        textContentSource: page.streamTextContent(),
        container: div,
        viewport: page.getViewport({ scale, rotation }),
      });
      await tl.render().catch(() => {});
      if (!cancelled) setTextReady((n) => n + 1);
    });

    return () => {
      cancelled = true;
      task?.cancel();
      tl?.cancel();
    };
  }, [visible, size, scale, item, source, textLayer]);

  // Resaltado de búsqueda dentro de la capa de texto.
  useEffect(() => {
    const div = textDiv.current;
    if (!div || !textLayer) return;
    const q = highlight?.trim().toLowerCase();
    for (const span of div.querySelectorAll<HTMLSpanElement>("span:not(.markedContent)")) {
      if (span.dataset.orig !== undefined) {
        span.textContent = span.dataset.orig;
        delete span.dataset.orig;
      }
      if (!q) continue;
      const text = span.textContent ?? "";
      const lower = text.toLowerCase();
      if (!lower.includes(q)) continue;
      span.dataset.orig = text;
      span.replaceChildren();
      let i = 0;
      for (let j = lower.indexOf(q); j !== -1; j = lower.indexOf(q, i)) {
        span.append(text.slice(i, j));
        const m = document.createElement("mark");
        m.textContent = text.slice(j, j + q.length);
        span.append(m);
        i = j + q.length;
      }
      span.append(text.slice(i));
    }
  }, [highlight, textReady, textLayer]);

  const w = size ? size.w * scale : 100;
  const h = size ? size.h * scale : 141;
  return (
    <div ref={wrap} className="page-canvas" style={{ width: w, height: h }}>
      <canvas ref={canvas} style={{ width: w, height: h }} />
      {textLayer && <div ref={textDiv} className="textLayer" />}
    </div>
  );
}
