// Prueba en navegador: anotaciones y guardado.
const { chromium } = require("playwright");
const S = process.argv[2];
(async () => {
  const b = await chromium.launch();
  const ctx = await b.newContext({ acceptDownloads: true, viewport: { width: 1440, height: 900 } });
  const p = await ctx.newPage();
  const errs = [];
  p.on("pageerror", (e) => errs.push(e.message));
  p.on("console", (m) => m.type() === "error" && errs.push(m.text()));
  await p.goto("http://localhost:4173");
  await p.setInputFiles("input[type=file] >> nth=0", S + "/prueba.pdf");
  await p.waitForSelector(".page .textLayer span");
  await p.waitForTimeout(800);
  await p.click("text=Comentar");
  // Resaltar: seleccionar texto arrastrando sobre la línea "Clausula de confidencialidad…"
  await p.click("button.tbtn:has-text('Resaltar')");
  const span = p.locator(".page >> nth=0").locator(".textLayer span", { hasText: "Clausula" }).first();
  const bb = await span.boundingBox();
  await p.mouse.move(bb.x + 2, bb.y + bb.height / 2);
  await p.mouse.down();
  await p.mouse.move(bb.x + bb.width - 2, bb.y + bb.height / 2, { steps: 8 });
  await p.mouse.up();
  await p.waitForTimeout(300);
  // Rectángulo
  const page0 = await p.locator(".page .page-canvas").first().boundingBox();
  await p.click("button.tbtn:has-text('Rectángulo')");
  await p.mouse.move(page0.x + 100, page0.y + 300);
  await p.mouse.down();
  await p.mouse.move(page0.x + 300, page0.y + 400, { steps: 5 });
  await p.mouse.up();
  // Lápiz
  await p.click("button.tbtn:has-text('Lápiz')");
  await p.mouse.move(page0.x + 350, page0.y + 300);
  await p.mouse.down();
  for (let i = 0; i < 20; i++) await p.mouse.move(page0.x + 350 + i * 6, page0.y + 300 + Math.sin(i / 2) * 20);
  await p.mouse.up();
  // Flecha
  await p.click("button.tbtn:has-text('Flecha')");
  await p.mouse.move(page0.x + 100, page0.y + 500);
  await p.mouse.down();
  await p.mouse.move(page0.x + 250, page0.y + 450, { steps: 5 });
  await p.mouse.up();
  // Cuadro de texto
  await p.click("button.tbtn:has-text('Texto')");
  await p.mouse.click(page0.x + 320, page0.y + 480);
  await p.keyboard.type("Revisar esta cláusula");
  await p.mouse.click(page0.x + 500, page0.y + 750); // fuera → confirma
  // Nota
  await p.click("button.tbtn:has-text('Nota')");
  await p.mouse.click(page0.x + 520, page0.y + 120);
  await p.fill(".note-popup textarea", "Comentario de prueba");
  await p.click(".note-popup button");
  // Sello
  await p.selectOption(".stamp-pick select", "APROBADO");
  await p.mouse.click(page0.x + 450, page0.y + 650);
  await p.waitForTimeout(500);
  await p.screenshot({ path: S + "/a1.png" });
  console.log("annots en pantalla:", await p.locator(".page >> nth=0").locator(".overlay .annot").count());
  // Deshacer / rehacer
  await p.keyboard.press("Control+z");
  const afterUndo = await p.locator(".page >> nth=0").locator(".overlay .annot").count();
  await p.keyboard.press("Control+y");
  console.log("tras deshacer:", afterUndo, "tras rehacer:", await p.locator(".page >> nth=0").locator(".overlay .annot").count());
  const [dl] = await Promise.all([p.waitForEvent("download"), p.keyboard.press("Control+s")]);
  await dl.saveAs(S + "/annots.pdf");
  console.log("errores:", errs);
  await b.close();
})();
