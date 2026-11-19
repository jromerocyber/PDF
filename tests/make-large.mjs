// PDF grande para pruebas de rendimiento: node tests/make-large.mjs salida.pdf imagen.jpg [páginas]
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import fs from "fs";
const [out, imgPath, n = "200"] = process.argv.slice(2);
const d = await PDFDocument.create();
const f = await d.embedFont(StandardFonts.Helvetica);
const img = await d.embedJpg(fs.readFileSync(imgPath));
const lorem = "Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. ";
for (let i = 1; i <= Number(n); i++) {
  const p = d.addPage([595, 842]);
  p.drawText(`Capítulo ${i} - Informe anual`, { x: 50, y: 790, size: 20, font: f });
  for (let l = 0; l < 30; l++) p.drawText((lorem + (l === 5 ? "confidencial " : "")).slice(0, 95), { x: 50, y: 750 - l * 14, size: 10, font: f, color: rgb(0.1, 0.1, 0.1) });
  p.drawImage(img, { x: 50, y: 40, width: 495, height: 280 });
}
fs.writeFileSync(out, await d.save());
