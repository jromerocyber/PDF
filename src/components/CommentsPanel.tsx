import type { PageItem } from "../lib/pdf";
import type { Annot } from "../lib/model";

const NAMES: Record<Annot["type"], string> = {
  highlight: "Resaltado",
  underline: "Subrayado",
  strike: "Tachado",
  ink: "Dibujo",
  rect: "Rectángulo",
  ellipse: "Elipse",
  line: "Línea",
  arrow: "Flecha",
  text: "Texto",
  note: "Nota",
  image: "Imagen",
  redact: "Redacción",
  field: "Campo",
};

interface Props {
  pages: PageItem[];
  annots: Record<string, Annot[]>;
  onGo: (pageKey: string, id: string) => void;
  onDelete: (pageKey: string, id: string) => void;
  onClose: () => void;
}

export function CommentsPanel({ pages, annots, onGo, onDelete, onClose }: Props) {
  const rows = pages.flatMap((p, i) => (annots[p.key] ?? []).map((a) => ({ a, page: i + 1, key: p.key })));
  const exportCsv = () => {
    const esc = (s: string) => `"${s.replace(/"/g, '""')}"`;
    const csv = ["Página;Tipo;Autor;Fecha;Texto", ...rows.map(({ a, page }) => [page, NAMES[a.type], esc(a.author ?? ""), a.created ? new Date(a.created).toLocaleString("es-ES") : "", esc("text" in a ? (a.text ?? "") : "")].join(";"))].join("\n");
    const url = URL.createObjectURL(new Blob(["﻿" + csv], { type: "text/csv" }));
    const l = document.createElement("a");
    l.href = url;
    l.download = "comentarios.csv";
    l.click();
  };
  return (
    <aside className="side-panel">
      <div className="side-head">
        <strong>Comentarios ({rows.length})</strong>
        <span>
          <button className="link" onClick={exportCsv} disabled={!rows.length}>CSV</button>
          <button onClick={onClose} aria-label="Cerrar">✕</button>
        </span>
      </div>
      {!rows.length && <p className="muted pad">Aún no hay comentarios. Usa la pestaña Comentar.</p>}
      {rows.map(({ a, page, key }) => (
        <div key={a.id} className="comment" onClick={() => onGo(key, a.id)}>
          <div className="comment-head">
            <span className="dot" style={{ background: a.color }} />
            <strong>{NAMES[a.type]}</strong>
            <span className="muted">pág. {page}</span>
            <button className="link" onClick={(e) => (e.stopPropagation(), onDelete(key, a.id))}>Borrar</button>
          </div>
          {"text" in a && a.text && <div className="comment-text">{a.text}</div>}
          <div className="muted small">
            {a.author || "Anónimo"} · {a.created ? new Date(a.created).toLocaleString("es-ES") : ""}
          </div>
        </div>
      ))}
    </aside>
  );
}
