// qpdf (Apache-2.0) compilado a WebAssembly: cifrado/descifrado, reparación y optimización.
import createModule from "@neslinesli93/qpdf-wasm";
import wasmUrl from "@neslinesli93/qpdf-wasm/dist/qpdf.wasm?url";

export interface QpdfResult {
  code: number;
  output: Uint8Array | null;
  log: string[];
}

/** Ejecuta qpdf: `qpdf /in.pdf ...args /out.pdf`. Cada llamada usa una instancia nueva. */
export async function qpdf(input: Uint8Array, args: string[], withOutput = true): Promise<QpdfResult> {
  const log: string[] = [];
  const m: any = await createModule({
    locateFile: () => wasmUrl,
    noInitialRun: true,
    print: (t: string) => log.push(t),
    printErr: (t: string) => log.push(t),
  } as never);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  m.FS.writeFile("/in.pdf", input);
  let code = 0;
  try {
    code = m.callMain(["/in.pdf", ...args, ...(withOutput ? ["/out.pdf"] : [])]);
  } catch (e) {
    code = (e as { status?: number }).status ?? 1;
  }
  let output: Uint8Array | null = null;
  if (withOutput) {
    try {
      output = m.FS.readFile("/out.pdf");
    } catch {
      output = null;
    }
  }
  // Código 3 = avisos (el resultado es válido).
  return { code, output: code === 0 || code === 3 ? output : null, log };
}

/** ¿Está cifrado? Comprobación rápida buscando /Encrypt en el tráiler. */
export function looksEncrypted(bytes: Uint8Array): boolean {
  const tail = new TextDecoder("latin1").decode(bytes.subarray(Math.max(0, bytes.length - 4096)));
  if (/\/Encrypt\s/.test(tail)) return true;
  // En PDFs con xref stream el /Encrypt puede estar más arriba.
  const head = new TextDecoder("latin1").decode(bytes.subarray(0, Math.min(bytes.length, 2_000_000)));
  return /\/Encrypt\s+\d+\s+\d+\s+R/.test(head);
}

/** Descifra con la contraseña (de usuario o de propietario). Devuelve null si la contraseña no es válida. */
export async function decryptPdf(bytes: Uint8Array, password: string): Promise<Uint8Array | null> {
  const r = await qpdf(bytes, [`--password=${password}`, "--decrypt"]);
  return r.output;
}

export interface Permissions {
  print: boolean;
  modify: boolean;
  copy: boolean;
  annotate: boolean;
  forms: boolean;
  assemble: boolean;
}

/** Cifra con AES-256. */
export async function encryptPdf(bytes: Uint8Array, userPw: string, ownerPw: string, perms: Permissions): Promise<Uint8Array> {
  const owner = ownerPw || userPw || crypto.getRandomValues(new Uint32Array(4)).join("");
  const args = [
    "--encrypt",
    userPw,
    owner,
    "256",
    `--print=${perms.print ? "full" : "none"}`,
    `--modify=${perms.modify ? "all" : perms.assemble ? "assembly" : perms.forms ? "form" : perms.annotate ? "annotate" : "none"}`,
    `--extract=${perms.copy ? "y" : "n"}`,
    `--annotate=${perms.annotate ? "y" : "n"}`,
    `--form=${perms.forms ? "y" : "n"}`,
    `--assemble=${perms.assemble ? "y" : "n"}`,
    "--",
  ];
  const r = await qpdf(bytes, args);
  if (!r.output) throw new Error("No se pudo cifrar: " + r.log.join(" "));
  return r.output;
}

/** Optimiza: flujos de objetos y recompresión. */
export async function optimizePdf(bytes: Uint8Array): Promise<Uint8Array> {
  const r = await qpdf(bytes, ["--object-streams=generate", "--compress-streams=y", "--recompress-flate", "--compression-level=9"]);
  return r.output ?? bytes;
}

/** Repara un PDF dañado reescribiéndolo. */
export async function repairPdf(bytes: Uint8Array): Promise<Uint8Array | null> {
  return (await qpdf(bytes, [])).output;
}
