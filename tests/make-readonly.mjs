import { PDFDocument, StandardFonts } from "pdf-lib";
import fs from "fs";
const d = await PDFDocument.create(); const f = await d.embedFont(StandardFonts.Helvetica);
const p = d.addPage([595, 842]); p.drawText("Formulario con campos bloqueados", { x: 60, y: 780, size: 18, font: f });
const form = d.getForm();
const t = form.createTextField("nif"); t.setText("12345678Z"); t.addToPage(p, { x: 140, y: 712, width: 200, height: 22 }); t.enableReadOnly();
const c = form.createCheckBox("conforme"); c.addToPage(p, { x: 140, y: 672, width: 16, height: 16 }); c.check(); c.enableReadOnly();
const n = form.createTextField("nombre"); n.addToPage(p, { x: 140, y: 632, width: 200, height: 22 });
fs.writeFileSync(process.argv[2], await d.save());
