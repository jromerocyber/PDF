// Prueba en navegador: conversiones, OCR, compresión y herramientas de página.
const { chromium } = require("playwright");
const S = process.argv[2];
const tool = async (p, tab, label) => {
  await p.click(`.tabs-nav button:has-text('${tab}')`);
  await p.click(`button.tbtn:has-text('${label}')`);
};
const dl = async (p, action, out) => {
  const [d] = await Promise.all([p.waitForEvent("download", { timeout: 120000 }), action()]);
  await d.saveAs(out);
};
(async () => {
  const b = await chromium.launch();
  const ctx = await b.newContext({ acceptDownloads: true, viewport: { width: 1440, height: 900 } });
  const p = await ctx.newPage();
  const errs = [];
  p.on("pageerror", (e) => errs.push(e.message));
  p.on("console", (m) => m.type() === "error" && !/invalid password/.test(m.text()) && errs.push(m.text()));
  p.on("dialog", (d) => d.accept());
  await p.goto("http://localhost:4173");

  // Word → PDF
  await tool(p, "Convertir", "Desde Word");
  await p.setInputFiles(".modal input[type=file]", S + "/informe.docx");
  await p.waitForSelector(".page .textLayer span");
  await p.waitForTimeout(800);
  await p.screenshot({ path: S + "/c1.png" });
  await dl(p, () => p.keyboard.press("Control+s"), S + "/from-word.pdf");

  // Imágenes escaneadas → PDF, y OCR
  await p.setInputFiles("input[type=file] >> nth=0", [S + "/scan-1.jpg", S + "/scan-2.jpg"]);
  await p.waitForFunction(() => document.querySelectorAll(".thumb").length === 2);
  await tool(p, "Convertir", "OCR");
  await p.click(".modal button.primary");
  await p.waitForSelector(".modal", { state: "detached", timeout: 180000 });
  await p.waitForTimeout(1500);
  await p.fill(".search input", "confidencialidad");
  await p.press(".search input", "Enter");
  await p.waitForTimeout(1500);
  console.log("OCR: búsqueda tras OCR ->", await p.locator(".search .count").textContent());
  await dl(p, () => p.keyboard.press("Control+s"), S + "/ocr.pdf");

  // PDF → Word / texto / imágenes
  await p.setInputFiles("input[type=file] >> nth=0", S + "/prueba.pdf");
  await p.waitForSelector(".page .textLayer span");
  await tool(p, "Convertir", "A Word");
  await dl(p, () => p.click(".modal button.primary"), S + "/to-word.docx");
  await tool(p, "Convertir", "A imágenes");
  await dl(p, () => p.click(".modal button.primary"), S + "/to-images.zip");
  await tool(p, "Convertir", "A HTML");
  await dl(p, () => p.click(".modal button.primary"), S + "/to-html.html");

  // Marca de agua + encabezado/pie + propiedades
  await tool(p, "Editar", "Marca de agua");
  await p.click(".modal button.primary");
  await p.waitForSelector(".modal", { state: "detached" });
  await tool(p, "Editar", "Encabezado y pie");
  await p.click(".modal button.primary");
  await p.waitForSelector(".modal", { state: "detached" });
  await tool(p, "Inicio", "Propiedades");
  await p.waitForSelector(".modal input");
  await p.fill(".modal .field:has-text('Título') input", "Contrato de prueba");
  await p.fill(".modal .field:has-text('Autor') input", "Departamento Legal");
  await p.click(".modal button.primary");
  await p.waitForSelector(".modal", { state: "detached" });
  // Marcadores
  await tool(p, "Inicio", "Marcadores");
  await p.click(".modal button:has-text('Editar marcadores')");
  await p.click(".modal button:has-text('Añadir')");
  await p.fill(".outline-edit input >> nth=0", "Portada");
  await p.click(".modal button.primary");
  await p.waitForSelector(".modal", { state: "detached" });
  await p.waitForTimeout(800);
  await p.screenshot({ path: S + "/c2.png" });
  await dl(p, () => p.keyboard.press("Control+s"), S + "/tools.pdf");

  // Comprimir
  await tool(p, "Convertir", "Comprimir");
  await p.click(".modal button.primary");
  await p.waitForSelector(".modal p:has-text('→')", { timeout: 60000 });
  console.log("compresión:", await p.locator(".modal p:has-text('→')").textContent());
  await p.click(".modal-head button");

  // Comparar con otro PDF
  await tool(p, "Editar", "Comparar");
  await p.setInputFiles(".modal input[type=file]", S + "/edited-redacted.pdf");
  await p.waitForSelector(".diff", { timeout: 60000 });
  console.log("comparar: páginas con diferencias =", await p.locator(".diff-page").count());
  console.log("errores:", errs);
  await b.close();
})();
