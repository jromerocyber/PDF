// Sellos generados como imagen PNG (se ven igual en cualquier lector).
export const STAMPS: { label: string; color: string }[] = [
  { label: "APROBADO", color: "#15803d" },
  { label: "REVISADO", color: "#1d4ed8" },
  { label: "CONFIDENCIAL", color: "#b91c1c" },
  { label: "BORRADOR", color: "#6b7280" },
  { label: "RECHAZADO", color: "#b91c1c" },
  { label: "URGENTE", color: "#c2410c" },
  { label: "PAGADO", color: "#15803d" },
  { label: "COPIA", color: "#6b7280" },
  { label: "RECIBIDO", color: "#1d4ed8" },
  { label: "ANULADO", color: "#b91c1c" },
];

/** Dibuja un sello y devuelve dataUrl + tamaño en puntos PDF. */
export function makeStamp(label: string, color: string, withDate = true, author = "") {
  const scale = 3;
  const font = "bold 28px Helvetica, Arial, sans-serif";
  const sub = "13px Helvetica, Arial, sans-serif";
  const now = new Date();
  const line2 = withDate ? `${author ? author + " · " : ""}${now.toLocaleDateString("es-ES")} ${now.toLocaleTimeString("es-ES", { hour: "2-digit", minute: "2-digit" })}` : "";
  const m = document.createElement("canvas").getContext("2d")!;
  m.font = font;
  const w1 = m.measureText(label).width;
  m.font = sub;
  const w2 = line2 ? m.measureText(line2).width : 0;
  const w = Math.max(w1, w2) + 32;
  const h = line2 ? 64 : 46;
  const cv = document.createElement("canvas");
  cv.width = w * scale;
  cv.height = h * scale;
  const c = cv.getContext("2d")!;
  c.scale(scale, scale);
  c.strokeStyle = color;
  c.fillStyle = color;
  c.lineWidth = 3;
  roundRect(c, 2, 2, w - 4, h - 4, 8);
  c.stroke();
  c.lineWidth = 1;
  roundRect(c, 6, 6, w - 12, h - 12, 5);
  c.stroke();
  c.textAlign = "center";
  c.font = font;
  c.fillText(label, w / 2, line2 ? 34 : 33);
  if (line2) {
    c.font = sub;
    c.fillText(line2, w / 2, 52);
  }
  return { dataUrl: cv.toDataURL("image/png"), w: w * 0.75, h: h * 0.75 };
}

function roundRect(c: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  c.beginPath();
  c.moveTo(x + r, y);
  c.arcTo(x + w, y, x + w, y + h, r);
  c.arcTo(x + w, y + h, x, y + h, r);
  c.arcTo(x, y + h, x, y, r);
  c.arcTo(x, y, x + w, y, r);
  c.closePath();
}

/** Carga una imagen y devuelve dataUrl + tamaño razonable en puntos. */
export async function imageFromFile(file: File, maxPt = 300) {
  const dataUrl = await new Promise<string>((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result as string);
    r.onerror = rej;
    r.readAsDataURL(file);
  });
  const img = await loadImage(dataUrl);
  // Reconvertimos a PNG/JPEG (pdf-lib solo admite esos dos formatos).
  let url = dataUrl;
  if (!/^data:image\/(png|jpeg)/.test(dataUrl)) {
    const cv = document.createElement("canvas");
    cv.width = img.naturalWidth;
    cv.height = img.naturalHeight;
    cv.getContext("2d")!.drawImage(img, 0, 0);
    url = cv.toDataURL("image/png");
  }
  const k = Math.min(1, maxPt / Math.max(img.naturalWidth, img.naturalHeight));
  return { dataUrl: url, w: img.naturalWidth * k, h: img.naturalHeight * k };
}

export function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((res, rej) => {
    const img = new Image();
    img.onload = () => res(img);
    img.onerror = rej;
    img.src = src;
  });
}
