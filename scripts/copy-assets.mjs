// Copia a public/ los recursos de OCR para que funcione sin conexión (sin servidores externos).
import fs from "fs";
import path from "path";
const root = path.dirname(path.dirname(new URL(import.meta.url).pathname));
const out = path.join(root, "public", "ocr");
fs.mkdirSync(path.join(out, "core"), { recursive: true });
fs.mkdirSync(path.join(out, "lang"), { recursive: true });
const nm = (...p) => path.join(root, "node_modules", ...p);
fs.copyFileSync(nm("tesseract.js", "dist", "worker.min.js"), path.join(out, "worker.min.js"));
for (const f of fs.readdirSync(nm("tesseract.js-core"))) {
  if (/lstm\.wasm\.js$/.test(f)) fs.copyFileSync(nm("tesseract.js-core", f), path.join(out, "core", f));
}
for (const lang of ["spa", "eng"]) {
  fs.copyFileSync(nm("@tesseract.js-data", lang, "4.0.0_best_int", `${lang}.traineddata.gz`), path.join(out, "lang", `${lang}.traineddata.gz`));
}
console.log("Recursos OCR copiados a public/ocr");
