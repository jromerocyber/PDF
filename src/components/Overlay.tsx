import { useEffect, useRef, useState } from "react";
import type { PageViewport } from "pdfjs-dist";
import type { Annot, Pt, Rect } from "../lib/model";
import { annotBounds, hasRect, moveAnnot, normRect } from "../lib/model";
import { uid } from "../lib/pdf";

export type Tool =
  | "select"
  | "hand"
  | "highlight"
  | "underline"
  | "strike"
  | "ink"
  | "rect"
  | "ellipse"
  | "line"
  | "arrow"
  | "text"
  | "note"
  | "place" // colocar imagen/sello/firma preparada
  | "edit"
  | "redact"
  | "field-text"
  | "field-multiline"
  | "field-check";

export interface Style {
  color: string;
  width: number;
  opacity: number;
  size: number;
  font: "Helvetica" | "Helvetica-Bold" | "Times-Roman" | "Courier";
  fill: string | null;
  author: string;
}

/** Imagen preparada para colocar con la herramienta "place". */
export interface Pending {
  dataUrl: string;
  w: number; // tamaño en puntos PDF
  h: number;
  kind: "image" | "signature" | "stamp";
}

interface Props {
  viewport: PageViewport;
  annots: Annot[];
  tool: Tool;
  style: Style;
  pending: Pending | null;
  selectedId: string | null;
  editingId: string | null;
  onAdd: (a: Annot, edit?: boolean) => void;
  onUpdate: (a: Annot) => void;
  onSelect: (id: string | null) => void;
  onEdit: (id: string | null) => void;
  onPlaced: () => void;
}

const DRAW_TOOLS: Tool[] = ["ink", "rect", "ellipse", "line", "arrow", "text", "note", "place", "redact", "field-text", "field-multiline", "field-check"];
const FONT_CSS: Record<Style["font"], string> = {
  Helvetica: "Helvetica, Arial, sans-serif",
  "Helvetica-Bold": "Helvetica, Arial, sans-serif",
  "Times-Roman": "'Times New Roman', Times, serif",
  Courier: "'Courier New', Courier, monospace",
};

type Drag =
  | { kind: "draw"; start: Pt; cur: Pt; path: Pt[] }
  | { kind: "move"; id: string; start: Pt; cur: Pt }
  | { kind: "resize"; id: string; fixed: Pt; cur: Pt };

export function Overlay(p: Props) {
  const svg = useRef<SVGSVGElement>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const vp = p.viewport;
  const toV = (x: number, y: number) => vp.convertToViewportPoint(x, y) as [number, number];
  const toPdf = (e: { clientX: number; clientY: number }): Pt => {
    const r = svg.current!.getBoundingClientRect();
    return vp.convertToPdfPoint(e.clientX - r.left, e.clientY - r.top) as Pt;
  };
  const vRect = (r: Rect) => {
    const [ax, ay] = toV(r[0], r[1]);
    const [bx, by] = toV(r[2], r[3]);
    return { x: Math.min(ax, bx), y: Math.min(ay, by), w: Math.abs(bx - ax), h: Math.abs(by - ay) };
  };
  const scale = vp.scale;
  const rot = vp.rotation;
  const capture = DRAW_TOOLS.includes(p.tool);

  const base = () => ({ id: uid("a"), color: p.style.color, opacity: p.style.opacity, author: p.style.author, created: Date.now() });

  const onDown = (e: React.PointerEvent) => {
    if (!capture || e.button !== 0) return;
    e.preventDefault();
    (e.target as Element).setPointerCapture(e.pointerId);
    const pt = toPdf(e);
    if (p.tool === "note") {
      p.onAdd({ ...base(), color: p.style.color === "#e11d48" || p.style.color === "#000000" ? "#ffd400" : p.style.color, opacity: 1, type: "note", at: pt, text: "" }, true);
      return;
    }
    if (p.tool === "place" && p.pending) {
      const { w, h, dataUrl, kind } = p.pending;
      p.onAdd({ ...base(), opacity: 1, type: "image", kind, dataUrl, rect: [pt[0] - w / 2, pt[1] - h / 2, pt[0] + w / 2, pt[1] + h / 2] });
      p.onPlaced();
      return;
    }
    setDrag({ kind: "draw", start: pt, cur: pt, path: [pt] });
  };

  const onMove = (e: React.PointerEvent) => {
    if (!drag) return;
    const pt = toPdf(e);
    if (drag.kind === "draw") setDrag({ ...drag, cur: pt, path: p.tool === "ink" ? [...drag.path, pt] : drag.path });
    else setDrag({ ...drag, cur: pt });
  };

  const onUp = () => {
    if (!drag) return;
    const d = drag;
    setDrag(null);
    if (d.kind === "move") {
      const a = p.annots.find((x) => x.id === d.id);
      const dx = d.cur[0] - d.start[0], dy = d.cur[1] - d.start[1];
      if (a && (Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5)) p.onUpdate(moveAnnot(a, dx, dy));
      return;
    }
    if (d.kind === "resize") {
      const a = p.annots.find((x) => x.id === d.id);
      if (a && hasRect(a)) {
        const r = normRect(d.fixed, d.cur);
        if (r[2] - r[0] > 4 && r[3] - r[1] > 4) p.onUpdate({ ...a, rect: r } as Annot);
      }
      return;
    }
    const tiny = Math.hypot(d.cur[0] - d.start[0], d.cur[1] - d.start[1]) < 3;
    const s = p.style;
    let r = normRect(d.start, d.cur);
    switch (p.tool) {
      case "ink":
        p.onAdd({ ...base(), type: "ink", paths: [simplify(d.path, 0.6 / scale)], width: s.width });
        break;
      case "rect":
      case "ellipse":
        if (!tiny) p.onAdd({ ...base(), type: p.tool, rect: r, width: s.width, fill: s.fill ?? undefined });
        break;
      case "line":
      case "arrow":
        if (!tiny) p.onAdd({ ...base(), type: p.tool, a: d.start, b: d.cur, width: s.width });
        break;
      case "text":
        if (tiny) r = [d.start[0], d.start[1] - s.size * 2, d.start[0] + 200, d.start[1]];
        p.onAdd({ ...base(), opacity: 1, type: "text", rect: r, text: "", size: s.size, font: s.font, border: false }, true);
        break;
      case "redact":
        if (!tiny) p.onAdd({ ...base(), color: "#000000", opacity: 1, type: "redact", rect: r });
        break;
      case "field-text":
      case "field-multiline":
      case "field-check": {
        if (tiny) {
          const w = p.tool === "field-check" ? 14 : 160, h = p.tool === "field-check" ? 14 : p.tool === "field-multiline" ? 60 : 20;
          r = [d.start[0], d.start[1] - h, d.start[0] + w, d.start[1]];
        }
        const field = p.tool === "field-check" ? "checkbox" : p.tool === "field-multiline" ? "multiline" : "text";
        p.onAdd({ ...base(), color: "#2563eb", opacity: 1, type: "field", field, rect: r, name: `${field === "checkbox" ? "casilla" : "campo"}_${Date.now().toString(36).slice(-4)}` });
        break;
      }
    }
  };

  const startMove = (e: React.PointerEvent, a: Annot) => {
    if (p.tool !== "select" || e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    p.onSelect(a.id);
    (e.target as Element).setPointerCapture(e.pointerId);
    const pt = toPdf(e);
    setDrag({ kind: "move", id: a.id, start: pt, cur: pt });
  };
  const startResize = (e: React.PointerEvent, a: Annot) => {
    if (!hasRect(a)) return;
    e.stopPropagation();
    e.preventDefault();
    (e.target as Element).setPointerCapture(e.pointerId);
    // Esquina fija: la que se ve arriba a la izquierda.
    const v = vRect(a.rect);
    const fixed = vp.convertToPdfPoint(v.x, v.y) as Pt;
    setDrag({ kind: "resize", id: a.id, fixed, cur: toPdf(e) });
  };

  // Anotación con el arrastre en curso aplicado (vista previa).
  const live = (a: Annot): Annot => {
    if (drag?.kind === "move" && drag.id === a.id) return moveAnnot(a, drag.cur[0] - drag.start[0], drag.cur[1] - drag.start[1]);
    if (drag?.kind === "resize" && drag.id === a.id && hasRect(a)) return { ...a, rect: normRect(drag.fixed, drag.cur) } as Annot;
    return a;
  };

  /** Grupo transformado para dibujar contenido "derecho" respecto a la página (texto, imágenes). */
  const boxGroup = (r: Rect) => {
    const [x, y] = toV(r[0], r[3]); // esquina superior izquierda en PDF
    return { transform: `translate(${x} ${y}) rotate(${rot})`, w: (r[2] - r[0]) * scale, h: (r[3] - r[1]) * scale };
  };

  const renderAnnot = (orig: Annot) => {
    const a = live(orig);
    const sel = p.selectedId === a.id;
    const common = {
      key: a.id,
      onPointerDown: (e: React.PointerEvent) => startMove(e, orig),
      onDoubleClick: () => (a.type === "text" || a.type === "note") && p.onEdit(a.id),
      className: `annot ${p.tool === "select" ? "hit" : ""}`,
      opacity: a.opacity,
    };
    let body: React.ReactNode = null;
    switch (a.type) {
      case "highlight":
        body = a.quads.map((q, i) => {
          const r = vRect(q);
          return <rect key={i} x={r.x} y={r.y} width={r.w} height={r.h} fill={a.color} style={{ mixBlendMode: "multiply" }} />;
        });
        break;
      case "underline":
      case "strike":
        body = a.quads.map((q, i) => {
          const h = q[3] - q[1];
          const y = a.type === "underline" ? q[1] + h * 0.06 : q[1] + h * 0.45;
          const [x1, y1] = toV(q[0], y), [x2, y2] = toV(q[2], y);
          const r = vRect(q);
          return (
            <g key={i}>
              <rect x={r.x} y={r.y} width={r.w} height={r.h} fill="transparent" />
              <line x1={x1} y1={y1} x2={x2} y2={y2} stroke={a.color} strokeWidth={Math.max(0.8, h * 0.07) * scale} />
            </g>
          );
        });
        break;
      case "ink":
        body = a.paths.map((path, i) => (
          <polyline key={i} points={path.map(([x, y]) => toV(x, y).join(",")).join(" ")} fill="none" stroke={a.color} strokeWidth={a.width * scale} strokeLinecap="round" strokeLinejoin="round" />
        ));
        break;
      case "rect":
      case "ellipse": {
        const r = vRect(a.rect);
        const sw = a.width * scale;
        body =
          a.type === "rect" ? (
            <rect x={r.x + sw / 2} y={r.y + sw / 2} width={Math.max(0, r.w - sw)} height={Math.max(0, r.h - sw)} stroke={a.color} strokeWidth={sw} fill={a.fill ?? "transparent"} />
          ) : (
            <ellipse cx={r.x + r.w / 2} cy={r.y + r.h / 2} rx={Math.max(0, (r.w - sw) / 2)} ry={Math.max(0, (r.h - sw) / 2)} stroke={a.color} strokeWidth={sw} fill={a.fill ?? "transparent"} />
          );
        break;
      }
      case "line":
      case "arrow": {
        const [x1, y1] = toV(...a.a), [x2, y2] = toV(...a.b);
        const sw = a.width * scale;
        const ang = Math.atan2(y2 - y1, x2 - x1);
        const len = Math.max(8, a.width * 4) * scale;
        body = (
          <>
            <line x1={x1} y1={y1} x2={x2} y2={y2} stroke="transparent" strokeWidth={Math.max(sw, 10)} />
            <line x1={x1} y1={y1} x2={x2} y2={y2} stroke={a.color} strokeWidth={sw} strokeLinecap="round" />
            {a.type === "arrow" &&
              [Math.PI - 0.45, Math.PI + 0.45].map((d) => (
                <line key={d} x1={x2} y1={y2} x2={x2 + len * Math.cos(ang + d)} y2={y2 + len * Math.sin(ang + d)} stroke={a.color} strokeWidth={sw} strokeLinecap="round" />
              ))}
          </>
        );
        break;
      }
      case "text": {
        const g = boxGroup(a.rect);
        const editing = p.editingId === a.id;
        body = (
          <g transform={g.transform}>
            <foreignObject width={g.w} height={g.h} style={{ overflow: "visible" }}>
              <div
                className={`ftext ${editing ? "editing" : ""}`}
                style={{
                  width: g.w,
                  height: g.h,
                  fontFamily: FONT_CSS[a.font],
                  fontWeight: a.font === "Helvetica-Bold" ? 700 : 400,
                  fontSize: a.size * scale,
                  lineHeight: 1.2,
                  color: a.color,
                  background: a.bg ?? "transparent",
                  border: a.border ? `${scale}px solid ${a.color}` : undefined,
                  padding: a.bg && a.flatten ? 0 : 3 * scale,
                }}
              >
                {editing ? (
                  <textarea
                    autoFocus
                    defaultValue={a.text}
                    style={{ font: "inherit", color: "inherit", lineHeight: "inherit" }}
                    onPointerDown={(e) => e.stopPropagation()}
                    onBlur={(e) => {
                      p.onUpdate({ ...orig, text: e.target.value } as Annot);
                      p.onEdit(null);
                    }}
                    onKeyDown={(e) => {
                      e.stopPropagation();
                      if (e.key === "Escape") (e.target as HTMLTextAreaElement).blur();
                    }}
                  />
                ) : (
                  a.text || <span className="placeholder">Escribe aquí…</span>
                )}
              </div>
            </foreignObject>
          </g>
        );
        break;
      }
      case "note": {
        const [x, y] = toV(...a.at);
        const s = 20 * scale;
        body = (
          <g transform={`translate(${x} ${y}) rotate(${rot})`}>
            <rect x={0} y={0} width={s} height={s * 0.8} rx={2} fill={a.color} stroke="#555" strokeWidth={1} />
            {[0.25, 0.45, 0.65].map((f) => (
              <line key={f} x1={s * 0.2} x2={s * 0.8} y1={s * f} y2={s * f} stroke="#555" strokeWidth={1} />
            ))}
          </g>
        );
        break;
      }
      case "image": {
        const g = boxGroup(a.rect);
        body = (
          <g transform={g.transform}>
            <image href={a.dataUrl} width={g.w} height={g.h} preserveAspectRatio="none" />
          </g>
        );
        break;
      }
      case "redact": {
        const r = vRect(a.rect);
        body = <rect x={r.x} y={r.y} width={r.w} height={r.h} fill="rgba(0,0,0,0.35)" stroke="#d00" strokeWidth={1.5} strokeDasharray="4 3" />;
        break;
      }
      case "field": {
        const r = vRect(a.rect);
        body = (
          <>
            <rect x={r.x} y={r.y} width={r.w} height={r.h} fill="rgba(37,99,235,0.08)" stroke="#2563eb" strokeWidth={1} strokeDasharray="3 2" />
            <text x={r.x + 3} y={r.y + Math.min(r.h - 3, 11)} fontSize={9} fill="#2563eb">
              {a.field === "checkbox" ? "☐" : a.name}
            </text>
          </>
        );
        break;
      }
    }
    const b = vRect(annotBounds(a));
    return (
      <g {...common}>
        {body}
        {sel && (
          <>
            <rect className="sel-box" x={b.x - 2} y={b.y - 2} width={b.w + 4} height={b.h + 4} />
            {hasRect(a) && <rect className="handle" x={b.x + b.w - 4} y={b.y + b.h - 4} width={9} height={9} onPointerDown={(e) => startResize(e, orig)} />}
          </>
        )}
      </g>
    );
  };

  // Vista previa del dibujo en curso.
  let preview: React.ReactNode = null;
  if (drag?.kind === "draw") {
    const s = p.style;
    if (p.tool === "ink") {
      preview = <polyline points={drag.path.map(([x, y]) => toV(x, y).join(",")).join(" ")} fill="none" stroke={s.color} strokeWidth={s.width * scale} strokeLinecap="round" strokeLinejoin="round" opacity={s.opacity} />;
    } else if (p.tool === "line" || p.tool === "arrow") {
      const [x1, y1] = toV(...drag.start), [x2, y2] = toV(...drag.cur);
      preview = <line x1={x1} y1={y1} x2={x2} y2={y2} stroke={s.color} strokeWidth={s.width * scale} opacity={s.opacity} />;
    } else {
      const r = vRect(normRect(drag.start, drag.cur));
      preview =
        p.tool === "ellipse" ? (
          <ellipse cx={r.x + r.w / 2} cy={r.y + r.h / 2} rx={r.w / 2} ry={r.h / 2} stroke={s.color} strokeWidth={s.width * scale} fill={s.fill ?? "none"} opacity={s.opacity} />
        ) : (
          <rect x={r.x} y={r.y} width={r.w} height={r.h} stroke={p.tool === "rect" ? s.color : "#2563eb"} strokeWidth={p.tool === "rect" ? s.width * scale : 1} strokeDasharray={p.tool === "rect" ? undefined : "4 3"} fill={p.tool === "rect" ? (s.fill ?? "none") : "rgba(37,99,235,0.08)"} />
        );
    }
  }

  const editingNote = p.annots.find((a) => a.id === p.editingId && a.type === "note");

  return (
    <>
      <svg
        ref={svg}
        className={`overlay ${capture ? "capture" : ""} tool-${p.tool}`}
        width={vp.width}
        height={vp.height}
        onPointerDown={(e) => {
          if (capture) onDown(e);
          else if (p.tool === "select" && e.target === svg.current) p.onSelect(null);
        }}
        onPointerMove={onMove}
        onPointerUp={onUp}
      >
        {capture && <rect width={vp.width} height={vp.height} fill="transparent" />}
        {p.annots.map(renderAnnot)}
        {preview}
      </svg>
      {editingNote && editingNote.type === "note" && <NotePopup note={editingNote} pos={toV(...editingNote.at)} onSave={(text) => (p.onUpdate({ ...editingNote, text }), p.onEdit(null))} />}
    </>
  );
}

function NotePopup({ note, pos, onSave }: { note: Extract<Annot, { type: "note" }>; pos: [number, number]; onSave: (t: string) => void }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => ref.current?.focus(), []);
  return (
    <div className="note-popup" style={{ left: pos[0] + 24, top: pos[1] }} onPointerDown={(e) => e.stopPropagation()}>
      <div className="note-head">{note.author || "Nota"}</div>
      <textarea ref={ref} defaultValue={note.text} onKeyDown={(e) => e.stopPropagation()} placeholder="Escribe tu comentario…" />
      <button className="primary" onClick={() => onSave(ref.current?.value ?? "")}>Guardar</button>
    </div>
  );
}

/** Simplificación de trazos (Ramer–Douglas–Peucker) para que el lápiz no genere miles de puntos. */
function simplify(pts: Pt[], eps: number): Pt[] {
  if (pts.length < 3) return pts;
  const [a, b] = [pts[0], pts[pts.length - 1]];
  let max = 0, idx = 0;
  for (let i = 1; i < pts.length - 1; i++) {
    const d = distToSeg(pts[i], a, b);
    if (d > max) (max = d), (idx = i);
  }
  if (max <= eps) return [a, b];
  return [...simplify(pts.slice(0, idx + 1), eps).slice(0, -1), ...simplify(pts.slice(idx), eps)];
}
function distToSeg(p: Pt, a: Pt, b: Pt) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const l = dx * dx + dy * dy;
  const t = l ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l)) : 0;
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
}
