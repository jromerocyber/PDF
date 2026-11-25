// Campos de solo lectura: aviso al pulsarlos, desbloquear, editar y guardar editables.
const { chromium } = require("playwright");
const S = process.argv[2];
(async () => {
  const b = await chromium.launch();
  const p = await (await b.newContext({ acceptDownloads: true, viewport: { width: 1400, height: 900 } })).newPage();
  const errs = [];
  p.on("pageerror", (e) => errs.push(e.message));
  await p.goto("http://localhost:4173");
  await p.setInputFiles("input[type=file] >> nth=0", S + "/readonly.pdf");
  await p.waitForSelector(".fl-input[title=nif]");
  console.log("nif bloqueado:", await p.locator(".fl-input[title=nif]").isDisabled(), "| nombre editable:", !(await p.locator(".fl-input[title=nombre]").isDisabled()));
  await p.click(".fl-locked >> nth=0");
  console.log("aviso:", await p.locator(".notice").textContent());
  await p.click(".tabs-nav button:has-text('Formularios')");
  await p.click("button.tbtn:has-text('Desbloquear campos')");
  await p.waitForTimeout(300);
  console.log("tras desbloquear, nif bloqueado:", await p.locator(".fl-input[title=nif]").isDisabled(), "| capas de bloqueo:", await p.locator(".fl-locked").count());
  await p.fill(".fl-input[title=nif]", "87654321X");
  console.log("casilla marcada al abrir:", await p.locator(".fl-check[title=conforme]").isChecked());
  await p.uncheck(".fl-check[title=conforme]");
  await p.fill(".fl-input[title=nombre]", "Ana Ruiz");
  // Ctrl+S con el cursor todavía dentro del campo: debe guardar incluyendo lo escrito.
  const [d] = await Promise.all([p.waitForEvent("download"), p.keyboard.press("Control+s")]);
  await d.saveAs(S + "/readonly-edited.pdf");
  console.log("errores:", errs);
  await b.close();
})();
