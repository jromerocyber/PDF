// Prueba de la APP DE ESCRITORIO (Tauri) con WebDriver: recorre las funciones y detecta las que se cuelgan.
// Requisitos (Linux): webkit2gtk-driver, `cargo install tauri-driver`, Xvfb.
// Uso: tauri-driver & ; node tests/desktop-e2e.cjs <carpeta-fixtures> <binario>
const { Builder, By, until, Key } = require("selenium-webdriver");
const S = process.argv[2];
const APP = process.argv[3];
const results = [];

async function step(name, fn, timeout = 60000) {
  const t0 = Date.now();
  try {
    await Promise.race([fn(), new Promise((_, rej) => setTimeout(() => rej(new Error("COLGADO (sin respuesta en " + timeout / 1000 + " s)")), timeout))]);
    results.push([name, "OK", ((Date.now() - t0) / 1000).toFixed(1) + " s"]);
  } catch (e) {
    results.push([name, "FALLO", String(e.message || e).split("\n")[0].slice(0, 160)]);
    if (global.__driver) {
      try {
        require("fs").writeFileSync(`${S}/fallo-${results.length}.png`, await global.__driver.takeScreenshot(), "base64");
        const html = await global.__driver.executeScript("const e=document.elementFromPoint(arguments[0],arguments[1]);return e?e.outerHTML.slice(0,300):''", 0, 0);
        void html;
      } catch {}
    }
  }
}

(async () => {
  const d = await new Builder().usingServer("http://127.0.0.1:4444/").withCapabilities({ "tauri:options": { application: APP }, browserName: "wry" }).build();
  global.__driver = d;
  const $ = (css) => d.findElement(By.css(css));
  const wait = (css, t = 30000) => d.wait(until.elementLocated(By.css(css)), t);
  const gone = async (css, t = 60000) => d.wait(async () => (await d.findElements(By.css(css))).length === 0, t);
  const click = async (css) => (await wait(css)).click();
  const tool = async (tab, label) => {
    await click(`.tabs-nav button:nth-child(${["Inicio", "Comentar", "Editar", "Formularios", "Proteger", "Convertir"].indexOf(tab) + 1})`);
    const btns = await d.findElements(By.css("button.tbtn"));
    for (const b of btns) if ((await b.getText()).replace(/\s+/g, " ").includes(label)) return b.click();
    throw new Error("Botón no encontrado: " + label);
  };
  const busyDone = async (t = 90000) => {
    await d.sleep(300);
    await d.wait(async () => (await d.findElements(By.css(".busy-overlay"))).length === 0, t);
    await d.wait(async () => {
      const n = await d.findElements(By.css(".notice"));
      if (!n.length) return true;
      const cls = await n[0].getAttribute("class");
      if (cls.includes("error")) throw new Error("Error mostrado: " + (await n[0].getText()));
      const txt = await n[0].getText();
      return !/…$/.test(txt.trim());
    }, t);
  };
  const open = async (file) => {
    await (await d.findElement(By.css("input[type=file]"))).sendKeys(file);
  };
  try {
    await d.wait(until.elementLocated(By.css(".empty-card")), 60000);
    await d.executeScript("window.__errs=[];const o=console.error;console.error=(...a)=>{window.__errs.push(a.join(' '));o(...a)};window.addEventListener('error',e=>window.__errs.push(String(e.message)));window.addEventListener('unhandledrejection',e=>window.__errs.push('rechazo: '+String(e.reason&&e.reason.message||e.reason)))");
    await step("Abrir PDF", async () => {
      await open(S + "/prueba.pdf");
      await wait(".page .textLayer span", 30000);
      await d.sleep(500);
    });
    await step("Buscar", async () => {
      const i = await $(".search input");
      await i.sendKeys("confidencialidad", Key.ENTER);
      await d.wait(async () => (await d.findElements(By.css(".search .count"))).length > 0, 20000);
    });
    await step("Rectángulo + guardar", async () => {
      await tool("Comentar", "Rectángulo");
      const c = await $(".page .page-canvas");
      await d.actions().move({ origin: c, x: -100, y: -100 }).press().move({ origin: c, x: 50, y: 0, duration: 200 }).release().perform();
      await $("body").sendKeys(Key.chord(Key.CONTROL, "s"));
      await busyDone();
    });
    const panel = (tab, label, run, t) =>
      step(`${tab} → ${label}`, async () => {
        await tool(tab, label);
        await wait(".modal");
        await run();
      }, t);
    const primary = async () => (await wait(".modal button.primary")).click();
    await panel("Editar", "Marca de agua", async () => (await primary(), await gone(".modal"), await busyDone()));
    await panel("Editar", "Encabezado", async () => (await primary(), await gone(".modal"), await busyDone()));
    await panel("Inicio", "Propiedades", async () => (await wait(".modal input"), await primary(), await gone(".modal"), await busyDone()));
    await panel("Inicio", "Marcadores", async () => (await d.sleep(800), await click(".modal-head button")));
    await panel("Editar", "Adjuntos", async () => (await d.sleep(800), await click(".modal-head button")));
    await panel("Formularios", "Datos", async () => (await d.sleep(800), await click(".modal-head button")));
    await panel("Convertir", "Comprimir", async () => (await primary(), await wait(".modal p", 60000), await d.wait(async () => (await $(".modal").getText()).includes("→"), 90000), await click(".modal-head button")), 120000);
    await panel("Convertir", "A Word", async () => (await primary(), await gone(".modal"), await busyDone()));
    await panel("Convertir", "A imágenes", async () => (await primary(), await gone(".modal"), await busyDone()));
    await panel("Convertir", "A texto", async () => (await wait(".modal textarea", 30000), await click(".modal-head button")));
    await panel("Convertir", "A HTML", async () => (await primary(), await gone(".modal"), await busyDone()));
    await panel("Proteger", "Contraseña", async () => {
      const pw = await d.findElements(By.css(".modal input[type=password]"));
      await pw[0].sendKeys("user");
      await pw[1].sendKeys("owner");
      await primary();
      await gone(".modal");
      await busyDone();
    });
    await panel("Proteger", "Buscar y redactar", async () => (await (await $(".modal input")).sendKeys("confidencialidad"), await primary(), await gone(".modal")));
    await panel("Proteger", "Firmar con certificado", async () => {
      const tabs = await d.findElements(By.css(".modal .tabs button"));
      if (tabs.length) await tabs[1].click();
      await (await wait(".modal input[type=file]")).sendKeys(S + "/certs/legacy.p12");
      await (await $(".modal input[type=password]")).sendKeys("1234");
      await primary();
      await wait(".cert-card", 30000);
      // sin sello de tiempo
      const sel = await d.findElements(By.css(".modal select"));
      for (const s of sel) {
        const opts = await s.findElements(By.css("option"));
        if ((await opts[0].getText()).includes("Sin sello")) await opts[0].click();
      }
      await primary();
      await gone(".modal", 60000);
      await busyDone();
    });
    await panel("Proteger", "Verificar", async () => (await wait(".sig-report", 30000), await click(".modal-head button")));
    await panel("Convertir", "OCR", async () => (await primary(), await gone(".modal", 240000), await busyDone()), 250000);
    await step("Abrir PDF protegido", async () => {
      await open(S + "/ui-encrypted.pdf");
      const before = await d.executeScript("return document.querySelector('.thumbs').innerText");
      await (await wait(".modal input[type=password]", 30000)).sendKeys("user", Key.ENTER);
      await gone(".modal");
      await busyDone();
      await wait(".page .page-canvas canvas", 30000);
      void before;
    });
    await panel("Convertir", "Desde Word", async () => (await (await wait(".modal input[type=file]")).sendKeys(S + "/informe.docx"), await gone(".modal", 30000), await wait(".page .textLayer span", 30000)));
    const errs = await d.executeScript("return window.__errs");
    console.table(results);
    console.log("Errores de consola:", errs);
    const shot = await d.takeScreenshot();
    require("fs").writeFileSync(S + "/desk-final.png", shot, "base64");
  } finally {
    await d.quit();
  }
})();
