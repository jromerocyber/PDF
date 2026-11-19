// Genera un PDF de prueba de 5 páginas: node tests/make-sample.mjs salida.pdf
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import fs from "fs";
const d = await PDFDocument.create();
const f = await d.embedFont(StandardFonts.Helvetica);
for (let i = 1; i <= 5; i++) {
  const p = d.addPage([595, 842]);
  p.drawText(`Pagina ${i} - Contrato de servicios`, { x: 60, y: 760, size: 24, font: f });
  p.drawText(i % 2 ? "Clausula de confidencialidad firmada por ambas partes." : "Texto normal de relleno.", { x: 60, y: 700, size: 14, font: f });
  p.drawRectangle({ x: 60, y: 300, width: 200, height: 150, color: rgb(0.2, 0.4, 0.8) });
}
fs.writeFileSync(process.argv[2], await d.save());
