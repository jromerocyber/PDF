import fs from "fs";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { Document, Packer, Paragraph, TextRun, HeadingLevel, Table, TableRow, TableCell } from "docx";
const S = process.argv[2];
const d = await PDFDocument.create(); const f = await d.embedFont(StandardFonts.Helvetica);
const p = d.addPage([595, 842]); p.drawText("Formulario de solicitud", { x: 60, y: 780, size: 20, font: f });
p.drawText("Nombre:", { x: 60, y: 720, size: 12, font: f }); p.drawText("Acepto:", { x: 60, y: 680, size: 12, font: f }); p.drawText("Provincia:", { x: 60, y: 640, size: 12, font: f });
const form = d.getForm();
form.createTextField("nombre").addToPage(p, { x: 140, y: 712, width: 250, height: 22 });
form.createCheckBox("acepto").addToPage(p, { x: 140, y: 676, width: 16, height: 16 });
const dd = form.createDropdown("provincia"); dd.addOptions(["Madrid", "Barcelona", "Valencia"]); dd.addToPage(p, { x: 140, y: 632, width: 150, height: 22 });
fs.writeFileSync(S + "/form.pdf", await d.save());
const doc = new Document({ sections: [{ children: [
  new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun("Informe trimestral")] }),
  new Paragraph({ children: [new TextRun("Este es un párrafo con "), new TextRun({ text: "negrita", bold: true }), new TextRun(" y "), new TextRun({ text: "cursiva", italics: true }), new TextRun(".")] }),
  new Paragraph({ bullet: { level: 0 }, children: [new TextRun("Primer punto")] }),
  new Paragraph({ bullet: { level: 0 }, children: [new TextRun("Segundo punto")] }),
  new Table({ rows: [new TableRow({ children: [new TableCell({ children: [new Paragraph("Concepto")] }), new TableCell({ children: [new Paragraph("Importe")] })] }), new TableRow({ children: [new TableCell({ children: [new Paragraph("Ventas")] }), new TableCell({ children: [new Paragraph("12.500 €")] })] })] }),
] }] });
fs.writeFileSync(S + "/informe.docx", Buffer.from(await (await Packer.toBlob(doc)).arrayBuffer()));
