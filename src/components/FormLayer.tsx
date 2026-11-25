import { Fragment, useEffect, useState } from "react";
import type { PageViewport } from "pdfjs-dist";
import type { Source } from "../lib/pdf";

interface Widget {
  id: string;
  fieldName: string;
  fieldType: "Tx" | "Btn" | "Ch" | "Sig";
  rect: [number, number, number, number];
  fieldValue?: string | string[];
  exportValue?: string;
  buttonValue?: string;
  checkBox?: boolean;
  radioButton?: boolean;
  pushButton?: boolean;
  multiLine?: boolean;
  combo?: boolean;
  multiSelect?: boolean;
  options?: { exportValue: string; displayValue: string }[];
  readOnly?: boolean;
  maxLen?: number;
  textAlignment?: number;
  password?: boolean;
}

const widgetCache = new WeakMap<Source, Map<number, Promise<Widget[]>>>();

export function getWidgets(source: Source, index: number): Promise<Widget[]> {
  let m = widgetCache.get(source);
  if (!m) widgetCache.set(source, (m = new Map()));
  let w = m.get(index);
  if (!w) {
    w = source.doc
      .getPage(index + 1)
      .then((pg) => pg.getAnnotations())
      .then((as) => as.filter((a) => a.subtype === "Widget" && a.fieldName && !a.hidden) as Widget[]);
    m.set(index, w);
  }
  return w;
}

interface Props {
  viewport: PageViewport;
  source: Source;
  index: number;
  values: Record<string, string | boolean>;
  onChange: (key: string, value: string | boolean) => void;
  /** Permitir editar los campos de solo lectura. */
  unlock?: boolean;
  /** Se ha pulsado un campo bloqueado. */
  onLocked?: (fieldName: string) => void;
}

export function FormLayer({ viewport, source, index, values, onChange, unlock, onLocked }: Props) {
  const [widgets, setWidgets] = useState<Widget[]>([]);
  useEffect(() => {
    let alive = true;
    getWidgets(source, index).then((w) => alive && setWidgets(w));
    return () => {
      alive = false;
    };
  }, [source, index]);

  if (!widgets.length) return null;
  const s = viewport.scale;
  return (
    <div className="form-layer">
      {widgets.map((w) => {
        const key = `${source.id}|${w.fieldName}`;
        const [ax, ay] = viewport.convertToViewportPoint(w.rect[0], w.rect[1]);
        const [bx, by] = viewport.convertToViewportPoint(w.rect[2], w.rect[3]);
        const style: React.CSSProperties = {
          left: Math.min(ax, bx),
          top: Math.min(ay, by),
          width: Math.abs(bx - ax),
          height: Math.abs(by - ay),
          fontSize: Math.max(8, Math.min(Math.abs(by - ay) * 0.7, 12 * s)),
        };
        const stored = values[key];
        const locked = w.readOnly && !unlock && w.fieldType !== "Sig";
        const lockCover = locked ? (
          <div key={w.id + "-lock"} className="fl-locked" style={style} title={`${w.fieldName} (solo lectura)`} onClick={() => onLocked?.(w.fieldName)} />
        ) : null;
        if (w.fieldType === "Sig") {
          return <div key={w.id} className="fl-sig" style={style} title="Campo de firma: usa la herramienta Firmar">Firma</div>;
        }
        if (w.fieldType === "Tx") {
          const value = stored !== undefined ? String(stored) : typeof w.fieldValue === "string" ? w.fieldValue : "";
          const props = {
            className: "fl-input",
            style: { ...style, textAlign: (["left", "center", "right"] as const)[w.textAlignment ?? 0] },
            value,
            disabled: w.readOnly && !unlock,
            maxLength: w.maxLen || undefined,
            title: w.fieldName,
            onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => onChange(key, e.target.value),
          };
          return (
            <Fragment key={w.id}>
              {w.multiLine ? <textarea {...props} /> : <input type={w.password ? "password" : "text"} {...props} />}
              {lockCover}
            </Fragment>
          );
        }
        if (w.fieldType === "Btn" && w.checkBox) {
          const checked = stored !== undefined ? !!stored : !!w.fieldValue && w.fieldValue !== "Off";
          return <Fragment key={w.id}><input type="checkbox" className="fl-check" style={style} checked={checked} disabled={w.readOnly && !unlock} title={w.fieldName} onChange={(e) => onChange(key, e.target.checked)} />{lockCover}</Fragment>;
        }
        if (w.fieldType === "Btn" && w.radioButton) {
          const current = stored !== undefined ? String(stored) : String(w.fieldValue ?? "");
          return (
            <Fragment key={w.id}><input type="radio" className="fl-check" style={style} name={key} checked={current === w.buttonValue} disabled={w.readOnly && !unlock} title={w.fieldName} onChange={() => onChange(key, w.buttonValue ?? "")} />{lockCover}</Fragment>
          );
        }
        if (w.fieldType === "Ch") {
          const current = stored !== undefined ? String(stored) : Array.isArray(w.fieldValue) ? (w.fieldValue[0] ?? "") : (w.fieldValue ?? "");
          return (
            <Fragment key={w.id}><select className="fl-input" style={style} value={current} disabled={w.readOnly && !unlock} title={w.fieldName} onChange={(e) => onChange(key, e.target.value)}>
              {!w.options?.some((o) => o.exportValue === current) && <option value={current}>{current}</option>}
              {w.options?.map((o) => (
                <option key={o.exportValue} value={o.displayValue}>
                  {o.displayValue}
                </option>
              ))}
            </select>{lockCover}</Fragment>
          );
        }
        return null;
      })}
    </div>
  );
}
