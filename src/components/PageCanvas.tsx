import { useEffect, useRef, useState } from "react";
import { AnnotationMode, TextLayer } from "pdfjs-dist";
import type { PageViewport, RenderTask } from "pdfjs-dist";
import type { PageItem, Source } from "../lib/pdf";

interface Props {
  item: PageItem;
  source?: Source;
  scale: number;
  /** Con capa de texto (selección y búsqueda). Las miniaturas no la necesitan. */
  textLayer?: boolean;
  highlight?: string;
  rootMargin?: string;
  /** No pintar en el lienzo los campos de formulario (se muestran como controles HTML). */
  hideForms?: boolean;
  /** Capas superpuestas (anotaciones, formularios) en coordenadas del viewport. */
  children?: (viewport: PageViewport) => React.ReactNode;
}

/** Viewport de la página (escala CSS, con rotación aplicada). */
export function usePageViewport(item: PageItem, source: Source | undefined, scale: number): PageViewport | null {
  const [base, setBase] = useState<PageViewport | null>(null);
  useEffect(() => {
    let alive = true;
    if (item.kind === "blank") {
      setBase(new SimpleViewport([0, 0, item.width, item.height], 1, item.rotation) as unknown as PageViewport);
    } else if (source) {
      source.doc.getPage(item.index + 1).then((page) => {
        if (alive) setBase(page.getViewport({ scale: 1, rotation: (page.rotate + item.rotation) % 360 }));
      });
    }
    return () => {
      alive = false;
    };
  }, [item, source]);
  if (!base) return null;
  return base.scale === scale ? base : base.clone({ scale });
}

export function PageCanvas({ item, source, scale, textLayer, highlight, rootMargin = "600px", hideForms, children }: Props) {
  const wrap = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const textDiv = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  const [textReady, setTextReady] = useState(0);
  const viewport = usePageViewport(item, source, scale);
  const vw = viewport?.width ?? 100;
  const vh = viewport?.height ?? 141;

  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const io = new IntersectionObserver(([e]) => setVisible(e.isIntersecting), { rootMargin });
    io.observe(el);
    return () => io.disconnect();
  }, [rootMargin]);

  useEffect(() => {
    if (!visible || !viewport || !canvas.current) return;
    const cv = canvas.current;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    let task: RenderTask | null = null;
    let tl: TextLayer | null = null;
    let cancelled = false;

    cv.width = Math.floor(viewport.width * dpr);
    cv.height = Math.floor(viewport.height * dpr);

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
      task = page.render({
        canvas: cv,
        viewport: viewport.clone({ scale: scale * dpr }),
        annotationMode: hideForms ? AnnotationMode.ENABLE_FORMS : AnnotationMode.ENABLE,
      });
      try {
        await task.promise;
      } catch {
        return; // render cancelado
      }
      if (cancelled || !textLayer || !textDiv.current) return;
      const div = textDiv.current;
      div.replaceChildren();
      div.style.setProperty("--total-scale-factor", String(scale));
      tl = new TextLayer({ textContentSource: page.streamTextContent(), container: div, viewport });
      await tl.render().catch(() => {});
      if (!cancelled) setTextReady((n) => n + 1);
    });

    return () => {
      cancelled = true;
      task?.cancel();
      tl?.cancel();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, vw, vh, scale, item, source, textLayer, hideForms]);

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

  return (
    <div ref={wrap} className="page-canvas" style={{ width: vw, height: vh }}>
      <canvas ref={canvas} style={{ width: vw, height: vh }} />
      {textLayer && <div ref={textDiv} className="textLayer" />}
      {visible && viewport && children?.(viewport)}
    </div>
  );
}

/** Viewport equivalente al de PDF.js para páginas en blanco (misma matemática). */
class SimpleViewport {
  viewBox: number[];
  scale: number;
  rotation: number;
  transform: number[];
  width: number;
  height: number;
  constructor(viewBox: number[], scale: number, rotation: number) {
    this.viewBox = viewBox;
    this.scale = scale;
    this.rotation = rotation = ((rotation % 360) + 360) % 360;
    const [x1, y1, x2, y2] = viewBox;
    const cx = (x1 + x2) / 2, cy = (y1 + y2) / 2;
    const [a, b, c, d] = rotation === 90 ? [0, 1, 1, 0] : rotation === 180 ? [-1, 0, 0, 1] : rotation === 270 ? [0, -1, -1, 0] : [1, 0, 0, -1];
    let ox: number, oy: number;
    if (a === 0) {
      ox = Math.abs(cy - y1) * scale;
      oy = Math.abs(cx - x1) * scale;
      this.width = Math.abs(y2 - y1) * scale;
      this.height = Math.abs(x2 - x1) * scale;
    } else {
      ox = Math.abs(cx - x1) * scale;
      oy = Math.abs(cy - y1) * scale;
      this.width = Math.abs(x2 - x1) * scale;
      this.height = Math.abs(y2 - y1) * scale;
    }
    this.transform = [a * scale, b * scale, c * scale, d * scale, ox - a * scale * cx - c * scale * cy, oy - b * scale * cx - d * scale * cy];
  }
  clone({ scale = this.scale, rotation = this.rotation }: { scale?: number; rotation?: number } = {}) {
    return new SimpleViewport(this.viewBox, scale, rotation);
  }
  convertToViewportPoint(x: number, y: number) {
    const t = this.transform;
    return [x * t[0] + y * t[2] + t[4], x * t[1] + y * t[3] + t[5]];
  }
  convertToPdfPoint(x: number, y: number) {
    const [a, b, c, d, e, f] = this.transform;
    const det = a * d - b * c;
    return [(d * (x - e) - c * (y - f)) / det, (-b * (x - e) + a * (y - f)) / det];
  }
}
