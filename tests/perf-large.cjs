// Tiempos con un PDF grande (navegador). Uso: node tests/perf-large.cjs <carpeta> (con vite preview en :4173)
const { chromium } = require("playwright");
const S = process.argv[2];
(async () => {
  const b = await chromium.launch();
  const p = await (await b.newContext({ acceptDownloads: true, viewport: { width: 1400, height: 900 } })).newPage();
  const errs = [];
  p.on("pageerror", (e) => errs.push(e.message));
  const t = async (name, fn) => {
    const t0 = Date.now();
    try { await fn(); console.log(name.padEnd(28), ((Date.now() - t0) / 1000).toFixed(1), "s"); }
    catch (e) { console.log(name.padEnd(28), "FALLO", e.message.split("\n")[0]); }
  };
  const idle = () => p.waitForSelector(".busy-overlay", { state: "detached", timeout: 180000 });
  const dl = (fn) => Promise.all([p.waitForEvent("download", { timeout: 180000 }), fn()]);
  await p.goto("http://localhost:4173");
  // Medir bloqueos del hilo principal (la interfaz "no responde").
  await p.evaluate(() => { window.__maxGap = 0; let last = performance.now(); const tick = () => { const n = performance.now(); window.__maxGap = Math.max(window.__maxGap, n - last); last = n; requestAnimationFrame(tick); }; requestAnimationFrame(tick); });
  const gap = async () => { const g = await p.evaluate(() => { const g = window.__maxGap; window.__maxGap = 0; return g; }); return Math.round(g); };
  await t("Abrir 200 páginas", async () => { await p.setInputFiles("input[type=file] >> nth=0", S + "/large.pdf"); await p.waitForSelector(".page .textLayer span"); });
  console.log("   bloqueo máx. interfaz:", await gap(), "ms");
  await t("Ir a la página 150", async () => { await p.fill(".pageno", "150"); await p.waitForTimeout(1500); });
  await t("Buscar en 200 páginas", async () => { await p.fill(".search input", "confidencial"); await p.press(".search input", "Enter"); await p.waitForSelector(".search .count", { timeout: 120000 }); });
  console.log("   bloqueo máx. interfaz:", await gap(), "ms");
  await t("Guardar sin cambios", async () => { await dl(() => p.keyboard.press("Control+s")); });
  await t("Rotar + guardar", async () => { await p.click("button.tbtn:has-text('Derecha')"); await dl(() => p.keyboard.press("Control+s")); });
  console.log("   bloqueo máx. interfaz:", await gap(), "ms");
  await t("Firmar (.p12)", async () => {
    await p.click(".tabs-nav button:has-text('Proteger')"); await p.click("button.tbtn:has-text('Firmar con certificado')");
    await p.setInputFiles(".modal input[type=file]", S + "/certs/legacy.p12"); await p.fill(".modal input[type=password]", "1234");
    await p.click(".modal button.primary"); await p.waitForSelector(".cert-card");
    await dl(() => p.click(".modal button.primary")); await idle();
  });
  await t("Verificar firma", async () => { await p.click("button.tbtn:has-text('Verificar firmas')"); await p.waitForSelector(".sig-report", { timeout: 120000 }); await p.click(".modal-head button"); });
  await t("Comprimir", async () => { await p.click(".tabs-nav button:has-text('Convertir')"); await p.click("button.tbtn:has-text('Comprimir')"); await p.click(".modal button.primary"); await p.waitForSelector(".modal p:has-text('→')", { timeout: 180000 }); await p.click(".modal-head button"); });
  await t("A Word", async () => { await p.click("button.tbtn:has-text('A Word')"); await dl(() => p.click(".modal button.primary")); await idle(); });
  console.log("   bloqueo máx. interfaz:", await gap(), "ms");
  console.log("errores:", errs);
  await b.close();
})();
