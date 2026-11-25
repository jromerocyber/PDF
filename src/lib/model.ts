// Modelo de anotaciones y objetos añadidos por el usuario.
// Todas las coordenadas están en el espacio de usuario PDF de la página (origen abajo-izquierda, sin rotar).
import type { PageItem } from "./pdf";

export type Pt = [number, number];
export type Rect = [number, number, number, number]; // x1, y1, x2, y2 (normalizado: x1<x2, y1<y2)

interface Base {
  id: string;
  color: string; // #rrggbb
  opacity: number; // 0..1
  author?: string;
  created?: number;
}

export type Annot =
  | (Base & { type: "highlight" | "underline" | "strike"; quads: Rect[]; text?: string })
  | (Base & { type: "ink"; paths: Pt[][]; width: number })
  | (Base & { type: "rect" | "ellipse"; rect: Rect; width: number; fill?: string })
  | (Base & { type: "line" | "arrow"; a: Pt; b: Pt; width: number })
  | (Base & {
      type: "text";
      rect: Rect;
      text: string;
      size: number;
      font: FontKey;
      /** Fondo opaco (p. ej. blanco para "editar texto": tapa el original). */
      bg?: string;
      border?: boolean;
      /** Se dibuja en el contenido de la página (no como anotación). */
      flatten?: boolean;
    })
  | (Base & { type: "note"; at: Pt; text: string })
  | (Base & { type: "image"; rect: Rect; dataUrl: string; kind: "image" | "signature" | "stamp" })
  | (Base & { type: "redact"; rect: Rect })
  | (Base & { type: "field"; rect: Rect; field: "text" | "checkbox" | "multiline"; name: string });

export type AnnotType = Annot["type"];
export type FontKey = "Helvetica" | "Helvetica-Bold" | "Times-Roman" | "Courier";

export interface DocState {
  pages: PageItem[];
  /** Anotaciones por clave de página. */
  annots: Record<string, Annot[]>;
  /** Valores de campos de formulario existentes, por `${srcId}|${nombreCampo}`. */
  forms: Record<string, string | boolean>;
  /** Campos de solo lectura desbloqueados para editarlos (se guardan ya editables). */
  unlockForms?: boolean;
}

export const emptyState = (): DocState => ({ pages: [], annots: {}, forms: {} });

export function normRect(a: Pt, b: Pt): Rect {
  return [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1])];
}

/** Rectángulo que contiene la anotación (para selección y BBox). */
export function annotBounds(a: Annot): Rect {
  switch (a.type) {
    case "highlight":
    case "underline":
    case "strike":
      return union(a.quads);
    case "ink": {
      const pts = a.paths.flat();
      const r = union(pts.map(([x, y]) => [x, y, x, y] as Rect));
      return pad(r, a.width / 2 + 1);
    }
    case "line":
    case "arrow":
      return pad(normRect(a.a, a.b), a.width * 3 + 2);
    case "note":
      return [a.at[0], a.at[1] - 20, a.at[0] + 20, a.at[1]];
    default:
      return a.rect;
  }
}

export function union(rs: Rect[]): Rect {
  if (!rs.length) return [0, 0, 0, 0];
  return rs.reduce((u, r) => [Math.min(u[0], r[0]), Math.min(u[1], r[1]), Math.max(u[2], r[2]), Math.max(u[3], r[3])]);
}
export const pad = (r: Rect, p: number): Rect => [r[0] - p, r[1] - p, r[2] + p, r[3] + p];

/** Desplaza una anotación dx, dy (en puntos PDF). */
export function moveAnnot(a: Annot, dx: number, dy: number): Annot {
  const mv = (p: Pt): Pt => [p[0] + dx, p[1] + dy];
  const mr = (r: Rect): Rect => [r[0] + dx, r[1] + dy, r[2] + dx, r[3] + dy];
  switch (a.type) {
    case "highlight":
    case "underline":
    case "strike":
      return { ...a, quads: a.quads.map(mr) };
    case "ink":
      return { ...a, paths: a.paths.map((p) => p.map(mv)) };
    case "line":
    case "arrow":
      return { ...a, a: mv(a.a), b: mv(a.b) };
    case "note":
      return { ...a, at: mv(a.at) };
    default:
      return { ...a, rect: mr(a.rect) };
  }
}

export function hasRect(a: Annot): a is Extract<Annot, { rect: Rect }> {
  return "rect" in a;
}

export function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.replace("#", ""), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}
