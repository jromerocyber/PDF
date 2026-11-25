// Formulario tipo "Datos del centro de trabajo": node tests/make-centro.mjs salida.pdf [aplanado]
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import fs from "fs";
const [out, flat] = process.argv.slice(2);
const d = await PDFDocument.create();
const f = await d.embedFont(StandardFonts.HelveticaBold), r = await d.embedFont(StandardFonts.Helvetica);
const p = d.addPage([595, 842]);
p.drawText("DATOS DEL CENTRO DE TRABAJO", { x: 40, y: 780, size: 16, font: f, color: rgb(0.1, 0.2, 0.5) });
const box = (x, y, w, h, label) => { p.drawRectangle({ x, y, width: w, height: h, borderWidth: 1, borderColor: rgb(0.3, 0.3, 0.3) }); p.drawText(label, { x: x + 4, y: y + h - 11, size: 8, font: r }); };
box(40, 720, 500, 42, "MUNICIPIO"); box(40, 672, 130, 42, "CÓDIGO POSTAL"); box(175, 672, 365, 42, "PAÍS");
const form = d.getForm();
const gray = rgb(0.9, 0.92, 0.96);
const mk = (name, x, y, w, val, opts = {}) => { const t = form.createTextField(name); if (opts.comb) { t.setMaxLength(5); t.enableCombing(); } t.setText(val); t.addToPage(p, { x, y, width: w, height: 20, backgroundColor: gray, borderWidth: 0 }); };
mk("municipio", 44, 724, 490, "MADRID");
mk("cp", 44, 676, 100, "28079", { comb: true });
mk("pais", 179, 676, 355, "ESPAÑA");
if (flat) form.flatten();
fs.writeFileSync(out, await d.save());
