// "Editar texto" sobre formularios: campos reales editables en ese modo, y campos aplanados.
const { chromium } = require("playwright");
const S = process.argv[2];
(async () => {
  const b = await chromium.launch();
  const p = await (await b.newContext({ acceptDownloads: true, viewport: { width: 1400, height: 900 } })).newPage();
  const errs = [];
  p.on("pageerror", (e) => errs.push(e.message));
  await p.goto("http://localhost:4173");
  const save = async (out) => { const [d] = await Promise.all([p.waitForEvent("download"), p.keyboard.press("Control+s")]); await d.saveAs(out); };
  // 1) Formulario con campos reales, en modo Editar texto
  await p.setInputFiles("input[type=file] >> nth=0", S + "/centro.pdf");
  await p.waitForSelector(".fl-input[title=municipio]");
  await p.click(".tabs-nav button:has-text('Editar')");
  await p.click("button.tbtn:has-text('Editar texto')");
  console.log("campos visibles en Editar texto:", await p.locator(".form-layer .fl-input").count());
  await p.fill(".fl-input[title=municipio]", "VALENCIA");
  await p.fill(".fl-input[title=cp]", "46001");
  await p.screenshot({ path: S + "/ef1.png", clip: { x: 300, y: 80, width: 800, height: 260 } });
  await save(S + "/centro-editado.pdf");
  // 2) Formulario aplanado: clic sobre el valor y sobre una zona sin texto
  await p.setInputFiles("input[type=file] >> nth=0", S + "/centro-aplanado.pdf");
  await p.waitForSelector(".page .textLayer span");
  await p.waitForTimeout(500);
  await p.keyboard.press("Escape"); // volver a Seleccionar antes de elegir otra vez la herramienta
  await p.click(".tabs-nav button:has-text('Editar')");
  await p.click("button.tbtn:has-text('Editar texto')");
  await p.locator(".page >> nth=0").locator(".textLayer span", { hasText: "MADRID" }).first().click();
  await p.keyboard.press("Control+a");
  await p.keyboard.type("SEVILLA");
  await p.locator(".viewer").click({ position: { x: 5, y: 5 } });
  const bg = await p.evaluate(() => getComputedStyle(document.querySelector(".ftext")).backgroundColor);
  console.log("fondo del texto editado:", bg);
  // zona sin texto dentro del recuadro de PAÍS (a la derecha de ESPAÑA)
  const pais = await p.locator(".page >> nth=0").locator(".textLayer span", { hasText: "ESPAÑA" }).first().boundingBox();
  await p.click(".tabs-nav button:has-text('Editar')");
  await p.click("button.tbtn:has-text('Editar texto')");
  await p.mouse.click(pais.x + pais.width + 120, pais.y + pais.height / 2);
  await p.keyboard.type("(Comunidad de Madrid)");
  await p.locator(".viewer").click({ position: { x: 5, y: 5 } });
  await p.screenshot({ path: S + "/ef2.png", clip: { x: 300, y: 80, width: 800, height: 260 } });
  await save(S + "/aplanado-editado.pdf");
  console.log("errores:", errs);
  await b.close();
})();
