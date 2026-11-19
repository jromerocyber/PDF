// Prueba en navegador: formularios, editar texto, redacción, firma, verificación y contraseña.
const { chromium } = require("playwright");
const S = process.argv[2];
const open = async (p, file) => {
  await p.setInputFiles("input[type=file] >> nth=0", file);
  await p.waitForSelector(".page .page-canvas canvas");
  await p.waitForTimeout(900);
};
const save = async (p, out) => {
  const [dl] = await Promise.all([p.waitForEvent("download"), p.keyboard.press("Control+s")]);
  await dl.saveAs(out);
};
(async () => {
  const b = await chromium.launch();
  const ctx = await b.newContext({ acceptDownloads: true, viewport: { width: 1440, height: 900 } });
  const p = await ctx.newPage();
  const errs = [];
  p.on("pageerror", (e) => errs.push(e.message));
  p.on("console", (m) => m.type() === "error" && errs.push(m.text()));
  p.on("dialog", (d) => d.accept(d.type() === "prompt" ? "user" : undefined));
  await p.goto("http://localhost:4173");

  // --- Formularios: rellenar y crear un campo nuevo
  await open(p, S + "/form.pdf");
  console.log("campos visibles:", await p.locator(".form-layer .fl-input, .form-layer .fl-check").count());
  await p.fill(".fl-input[title=nombre]", "María López");
  await p.check(".fl-check[title=acepto]");
  await p.selectOption("select[title=provincia]", "Valencia");
  await p.click("text=Formularios");
  await p.click("button.tbtn:has-text('Campo texto')");
  const pg = await p.locator(".page .page-canvas").first().boundingBox();
  await p.mouse.move(pg.x + 140, pg.y + 260);
  await p.mouse.down();
  await p.mouse.move(pg.x + 400, pg.y + 285, { steps: 4 });
  await p.mouse.up();
  await save(p, S + "/form-filled.pdf");

  // --- Editar texto existente + redacción
  await open(p, S + "/prueba.pdf");
  await p.click("text=Editar");
  await p.click("button.tbtn:has-text('Editar texto')");
  await p.locator(".page >> nth=0").locator(".textLayer span", { hasText: "Contrato de servicios" }).first().click();
  await p.keyboard.press("Control+a");
  await p.keyboard.type("Pagina 1 - Contrato MODIFICADO");
  await p.locator(".viewer").click({ position: { x: 5, y: 5 } });
  await p.click("text=Proteger y firmar");
  await p.click("button.tbtn:has-text('Buscar y redactar')");
  await p.fill(".modal input", "confidencialidad");
  await p.click(".modal button.primary");
  await p.waitForTimeout(400);
  await p.screenshot({ path: S + "/d1.png" });
  {
    const wait = p.waitForEvent("download");
    await p.keyboard.press("Control+s");
    await p.click(".modal:has-text('Aplicar redacciones') button.primary");
    await (await wait).saveAs(S + "/edited-redacted.pdf");
  }

  // --- Firma digital con certificado .p12
  await open(p, S + "/prueba.pdf");
  await p.click("text=Proteger y firmar");
  await p.click("button.tbtn:has-text('Firmar con certificado')");
  await p.setInputFiles(".modal input[type=file]", S + "/certs/legacy.p12");
  await p.fill(".modal input[type=password]", "1234");
  await p.click(".modal button.primary");
  await p.waitForSelector(".cert-card");
  console.log("certificado:", (await p.locator(".cert-card strong").textContent()));
  await p.fill(".modal input[placeholder='Ej.: Conforme']", "Conforme con el contrato");
  await p.fill(".modal input[placeholder='Ej.: Madrid']", "Valencia");
  const [sdl] = await Promise.all([p.waitForEvent("download"), p.click(".modal button.primary")]);
  await sdl.saveAs(S + "/ui-signed.pdf");
  await p.waitForTimeout(1200);
  await p.screenshot({ path: S + "/d2.png" });
  // Verificar
  await p.click("button.tbtn:has-text('Verificar firmas')");
  await p.waitForSelector(".sig-report");
  console.log("verificación:", (await p.locator(".sig-report .badge").textContent()), "|", (await p.locator(".sig-report li").first().textContent()));
  await p.click(".sig-report button.link:has-text('Confiar')");
  await p.click(".modal:has-text('Confiar en el emisor') button.primary");
  await p.waitForTimeout(800);
  console.log("tras confiar:", (await p.locator(".sig-report .badge").textContent()));
  await p.screenshot({ path: S + "/d3.png" });
  await p.click(".modal-head button");

  // --- Contraseña: proteger, y reabrir pidiendo contraseña
  await p.click("button.tbtn:has-text('Contraseña')");
  await p.fill(".modal input[type=password] >> nth=0", "user");
  await p.fill(".modal input[type=password] >> nth=1", "owner");
  const [edl] = await Promise.all([p.waitForEvent("download"), p.click(".modal button.primary")]);
  await edl.saveAs(S + "/ui-encrypted.pdf");
  await p.setInputFiles("input[type=file] >> nth=0", S + "/ui-encrypted.pdf");
  await p.waitForSelector(".modal:has-text('Documento protegido') input[type=password]");
  await p.fill(".modal input[type=password]", "user");
  await p.click(".modal button.primary");
  await p.waitForSelector(".page .page-canvas canvas");
  await p.waitForTimeout(900);
  console.log("cifrado reabierto, páginas:", await p.locator(".thumb").count());
  console.log("errores:", errs);
  await b.close();
})();
