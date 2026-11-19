import { useEffect, useRef, useState } from "react";
import { imageFromFile } from "../lib/stamps";
import { Modal } from "./Modal";

export interface SavedSig {
  dataUrl: string;
  w: number;
  h: number;
}

const KEY = "pdfstudio.signatures";
export function loadSaved(): SavedSig[] {
  try {
    return JSON.parse(localStorage.getItem(KEY) || "[]");
  } catch {
    return [];
  }
}
function storeSaved(list: SavedSig[]) {
  try {
    localStorage.setItem(KEY, JSON.stringify(list.slice(0, 6)));
  } catch {
    /* almacenamiento no disponible */
  }
}

/** Recorta los bordes transparentes de un lienzo y devuelve PNG. */
function trimCanvas(cv: HTMLCanvasElement): SavedSig | null {
  const c = cv.getContext("2d")!;
  const { width, height } = cv;
  const data = c.getImageData(0, 0, width, height).data;
  let x1 = width, y1 = height, x2 = -1, y2 = -1;
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++)
      if (data[(y * width + x) * 4 + 3] > 10) {
        if (x < x1) x1 = x;
        if (x > x2) x2 = x;
        if (y < y1) y1 = y;
        if (y > y2) y2 = y;
      }
  if (x2 < 0) return null;
  const p = 6;
  x1 = Math.max(0, x1 - p);
  y1 = Math.max(0, y1 - p);
  x2 = Math.min(width - 1, x2 + p);
  y2 = Math.min(height - 1, y2 + p);
  const out = document.createElement("canvas");
  out.width = x2 - x1 + 1;
  out.height = y2 - y1 + 1;
  out.getContext("2d")!.drawImage(cv, x1, y1, out.width, out.height, 0, 0, out.width, out.height);
  // Tamaño final: unos 150 pt de ancho máximo.
  const k = Math.min(150 / out.width, 60 / out.height);
  return { dataUrl: out.toDataURL("image/png"), w: out.width * k, h: out.height * k };
}

export function SignaturePad({ onDone, onClose }: { onDone: (s: SavedSig) => void; onClose: () => void }) {
  const [tab, setTab] = useState<"draw" | "type" | "image" | "saved">(loadSaved().length ? "saved" : "draw");
  const [color, setColor] = useState("#0b2a6f");
  const [name, setName] = useState("");
  const [fontIdx, setFontIdx] = useState(0);
  const [saved, setSaved] = useState(loadSaved);
  const [remember, setRemember] = useState(true);
  const cv = useRef<HTMLCanvasElement>(null);
  const drawing = useRef(false);
  const last = useRef<[number, number] | null>(null);
  const fonts = ["'Segoe Script', 'Brush Script MT', cursive", "'Lucida Handwriting', 'Apple Chancery', cursive", "Georgia, serif", "'Comic Sans MS', cursive"];

  useEffect(() => {
    if (tab !== "draw" || !cv.current) return;
    const c = cv.current;
    c.width = c.clientWidth * 2;
    c.height = c.clientHeight * 2;
  }, [tab]);

  const pos = (e: React.PointerEvent): [number, number] => {
    const r = cv.current!.getBoundingClientRect();
    return [(e.clientX - r.left) * 2, (e.clientY - r.top) * 2];
  };
  const line = (a: [number, number], b: [number, number], pressure: number) => {
    const c = cv.current!.getContext("2d")!;
    c.strokeStyle = color;
    c.lineCap = "round";
    c.lineJoin = "round";
    c.lineWidth = 4 + 3 * (pressure || 0.5);
    c.beginPath();
    c.moveTo(...a);
    c.lineTo(...b);
    c.stroke();
  };

  const finish = (s: SavedSig | null) => {
    if (!s) return;
    if (remember && tab !== "saved") {
      const list = [s, ...saved.filter((x) => x.dataUrl !== s.dataUrl)];
      storeSaved(list);
    }
    onDone(s);
  };

  const accept = async () => {
    if (tab === "draw" && cv.current) finish(trimCanvas(cv.current));
    if (tab === "type" && name.trim()) {
      const c = document.createElement("canvas");
      c.width = 1200;
      c.height = 300;
      const x = c.getContext("2d")!;
      x.fillStyle = color;
      x.font = `110px ${fonts[fontIdx]}`;
      x.textBaseline = "middle";
      x.fillText(name.trim(), 20, 150);
      finish(trimCanvas(c));
    }
  };

  return (
    <Modal title="Firma manuscrita" onClose={onClose} wide>
      <div className="tabs">
        {(["saved", "draw", "type", "image"] as const).map((t) => (
          <button key={t} className={tab === t ? "on" : ""} onClick={() => setTab(t)} disabled={t === "saved" && !saved.length}>
            {{ saved: "Guardadas", draw: "Dibujar", type: "Escribir", image: "Imagen" }[t]}
          </button>
        ))}
      </div>
      {tab === "saved" && (
        <div className="sig-list">
          {saved.map((s, i) => (
            <div key={i} className="sig-item">
              <img src={s.dataUrl} onClick={() => onDone(s)} alt="Firma guardada" />
              <button
                className="link"
                onClick={() => {
                  const l = saved.filter((_, j) => j !== i);
                  storeSaved(l);
                  setSaved(l);
                }}
              >
                Borrar
              </button>
            </div>
          ))}
        </div>
      )}
      {tab === "draw" && (
        <>
          <canvas
            ref={cv}
            className="sig-canvas"
            onPointerDown={(e) => {
              drawing.current = true;
              last.current = pos(e);
              (e.target as Element).setPointerCapture(e.pointerId);
            }}
            onPointerMove={(e) => {
              if (!drawing.current) return;
              const p = pos(e);
              line(last.current!, p, e.pressure);
              last.current = p;
            }}
            onPointerUp={() => (drawing.current = false)}
          />
          <div className="row">
            <button onClick={() => cv.current!.getContext("2d")!.clearRect(0, 0, cv.current!.width, cv.current!.height)}>Borrar</button>
          </div>
        </>
      )}
      {tab === "type" && (
        <div className="col">
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Tu nombre" autoFocus />
          <div className="sig-fonts">
            {fonts.map((f, i) => (
              <button key={f} className={i === fontIdx ? "on" : ""} style={{ fontFamily: f, fontSize: 26, color }} onClick={() => setFontIdx(i)}>
                {name || "Tu nombre"}
              </button>
            ))}
          </div>
        </div>
      )}
      {tab === "image" && (
        <div className="col">
          <p className="muted">Sube una imagen de tu firma (PNG con fondo transparente queda mejor).</p>
          <input type="file" accept="image/*" onChange={async (e) => e.target.files?.[0] && finish(await imageFromFile(e.target.files[0], 150))} />
        </div>
      )}
      {(tab === "draw" || tab === "type") && (
        <div className="row between">
          <span className="row">
            Color <input type="color" value={color} onChange={(e) => setColor(e.target.value)} />
            <label className="row">
              <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} /> Recordar firma
            </label>
          </span>
          <button className="primary" onClick={accept}>Usar firma</button>
        </div>
      )}
    </Modal>
  );
}
