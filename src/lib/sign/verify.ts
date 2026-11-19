// Verificación de firmas digitales de un PDF.
import * as asn1js from "asn1js";
import * as pkijs from "pkijs";
import { OID, sha256 } from "./cms";
import { certInfo } from "./signer";
import type { CertInfo } from "./signer";

export interface SigReport {
  field: string;
  signer: CertInfo | null;
  chain: CertInfo[];
  subFilter: string;
  signedAt: Date | null;
  timestamp: { time: Date; tsa: string; valid: boolean } | null;
  reason?: string;
  location?: string;
  /** El resumen y la firma criptográfica coinciden. */
  integrity: boolean;
  /** La firma cubre todo el archivo (no hay cambios posteriores). */
  coversWholeFile: boolean;
  /** Revisión firmada (bytes) — para poder extraer la versión firmada. */
  revisionLength: number;
  certValidAtSigning: boolean;
  trusted: boolean;
  certified: number | null;
  errors: string[];
}

const latin1 = (u: Uint8Array) => new TextDecoder("latin1").decode(u);
const hexToBytes = (h: string) => {
  const clean = h.replace(/[^0-9a-f]/gi, "");
  const out = new Uint8Array(clean.length >> 1);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.substr(i * 2, 2), 16);
  return out;
};
const buf = (u: Uint8Array) => u.slice().buffer;

// ---------- Lista de certificados de confianza (raíces) guardada por el usuario ----------
const TRUST_KEY = "pdfstudio.trusted";
export function trustedRoots(): string[] {
  try {
    return JSON.parse(localStorage.getItem(TRUST_KEY) || "[]");
  } catch {
    return [];
  }
}
export function addTrustedRoot(derB64: string) {
  const list = new Set(trustedRoots());
  list.add(derB64);
  try {
    localStorage.setItem(TRUST_KEY, JSON.stringify([...list]));
  } catch {
    /* sin almacenamiento */
  }
}
export function removeTrustedRoot(derB64: string) {
  try {
    localStorage.setItem(TRUST_KEY, JSON.stringify(trustedRoots().filter((x) => x !== derB64)));
  } catch {
    /* sin almacenamiento */
  }
}
export const b64 = (u: Uint8Array) => btoa(String.fromCharCode(...u));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

/** Busca los diccionarios de firma en el PDF (en bruto, para que funcione con cualquier estructura). */
function findSignatures(bytes: Uint8Array) {
  const text = latin1(bytes);
  const out: { byteRange: number[]; contents: Uint8Array; dict: string }[] = [];
  const re = /\/ByteRange\s*\[\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*\]/g;
  const seen = new Set<string>();
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const br = m.slice(1, 5).map(Number);
    const key = br.join(",");
    if (seen.has(key)) continue;
    seen.add(key);
    // /Contents está exactamente entre br[1] y br[2].
    const hex = text.slice(br[1] + 1, br[2] - 1);
    if (text[br[1]] !== "<" || text[br[2] - 1] !== ">") continue;
    // Diccionario aproximado alrededor.
    const start = text.lastIndexOf("obj", m.index);
    const end = text.indexOf("endobj", br[2]);
    const dict = text.slice(start, br[1]) + text.slice(br[2], end);
    let contents = hexToBytes(hex);
    // Quitar el relleno de ceros: la longitud real viene en la cabecera DER.
    try {
      const len = asn1js.fromBER(buf(contents)).offset;
      if (len > 0) contents = contents.subarray(0, len);
    } catch {
      /* se deja como está */
    }
    out.push({ byteRange: br, contents, dict });
  }
  return out;
}

function decodePdfString(dict: string, key: string): string | undefined {
  const hex = new RegExp(`/${key}\\s*<([0-9A-Fa-f\\s]*)>`).exec(dict);
  if (hex) {
    const b = hexToBytes(hex[1]);
    if (b[0] === 0xfe && b[1] === 0xff) {
      let s = "";
      for (let i = 2; i + 1 < b.length; i += 2) s += String.fromCharCode((b[i] << 8) | b[i + 1]);
      return s;
    }
    return latin1(b);
  }
  const lit = new RegExp(`/${key}\\s*\\(((?:\\\\.|[^\\\\)])*)\\)`).exec(dict);
  return lit ? lit[1].replace(/\\(.)/g, "$1") : undefined;
}

function parsePdfDate(s?: string): Date | null {
  const m = s && /D:(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?([+\-Z])?(\d{2})?'?(\d{2})?/.exec(s);
  if (!m) return null;
  const [, y, mo = "01", d = "01", h = "00", mi = "00", se = "00", tz, th = "00", tm = "00"] = m;
  const iso = `${y}-${mo}-${d}T${h}:${mi}:${se}${!tz || tz === "Z" ? "Z" : `${tz}${th}:${tm}`}`;
  const date = new Date(iso);
  return isNaN(+date) ? null : date;
}

export async function verifyPdf(bytes: Uint8Array): Promise<SigReport[]> {
  const sigs = findSignatures(bytes);
  const roots = trustedRoots().map((x) => pkijs.Certificate.fromBER(unb64(x).buffer));
  const reports: SigReport[] = [];
  let n = 0;
  for (const s of sigs) {
    n++;
    const errors: string[] = [];
    const [a, b, c, d] = s.byteRange;
    const signedBytes = new Uint8Array(b + d);
    signedBytes.set(bytes.subarray(a, a + b), 0);
    signedBytes.set(bytes.subarray(c, c + d), b);
    const subFilter = /\/SubFilter\s*\/([\w.]+)/.exec(s.dict)?.[1] ?? "?";
    const field = decodePdfString(s.dict, "T") ?? `Firma ${n}`;
    const report: SigReport = {
      field,
      signer: null,
      chain: [],
      subFilter,
      signedAt: parsePdfDate(decodePdfString(s.dict, "M")),
      timestamp: null,
      reason: decodePdfString(s.dict, "Reason"),
      location: decodePdfString(s.dict, "Location"),
      integrity: false,
      coversWholeFile: c + d === bytes.length || c + d === bytes.length - 1 || /^\s*$/.test(latin1(bytes.subarray(c + d))),
      revisionLength: c + d,
      certValidAtSigning: false,
      trusted: false,
      certified: /\/TransformMethod\s*\/DocMDP/.test(s.dict) ? Number(/\/P\s+(\d)/.exec(s.dict)?.[1] ?? 2) : null,
      errors,
    };
    try {
      if (subFilter === "adbe.x509.rsa_sha1") throw new Error("Formato de firma antiguo (adbe.x509.rsa_sha1) no compatible con la verificación");
      const ci = pkijs.ContentInfo.fromBER(buf(s.contents));
      const sd = new pkijs.SignedData({ schema: ci.content });
      const certs = (sd.certificates ?? []).filter((x): x is pkijs.Certificate => x instanceof pkijs.Certificate);
      const si = sd.signerInfos[0];
      const sid = si.sid as pkijs.IssuerAndSerialNumber;
      const signerCert =
        certs.find((x) => sid.serialNumber && x.serialNumber.isEqual(sid.serialNumber) && x.issuer.isEqual(sid.issuer)) ?? certs[0];
      if (signerCert) report.signer = certInfo(signerCert);
      report.chain = certs.filter((x) => x !== signerCert).map(certInfo);

      // Hora de firma: atributo signingTime si existe.
      const st = si.signedAttrs?.attributes.find((x) => x.type === OID.signingTime);
      if (st) report.signedAt = (st.values[0] as asn1js.UTCTime).toDate();

      // Integridad: resumen de los bytes + firma criptográfica.
      const v = await sd.verify({ signer: 0, data: buf(signedBytes), checkChain: false, extendedMode: true });
      report.integrity = !!v.signatureVerified;
      if (!report.integrity) errors.push(v.message || "La firma no coincide con el contenido");
      if (subFilter === "adbe.pkcs7.sha1") {
        // El contenido encapsulado es el SHA-1 de los datos.
        report.integrity = !!v.signatureVerified;
      }

      // Sello de tiempo.
      const tsAttr = si.unsignedAttrs?.attributes.find((x) => x.type === OID.timeStampToken);
      if (tsAttr) {
        try {
          const tci = new pkijs.ContentInfo({ schema: tsAttr.values[0] });
          const tsd = new pkijs.SignedData({ schema: tci.content });
          const tstRaw = tsd.encapContentInfo.eContent!.getValue();
          const tst = pkijs.TSTInfo.fromBER(tstRaw);
          const imprint = new Uint8Array(tst.messageImprint.hashedMessage.getValue());
          const sigVal = new Uint8Array(si.signature.getValue());
          const alg = tst.messageImprint.hashAlgorithm.algorithmId;
          const hashName = alg === OID.sha256 ? "SHA-256" : alg === "2.16.840.1.101.3.4.2.2" ? "SHA-384" : alg === "2.16.840.1.101.3.4.2.3" ? "SHA-512" : "SHA-1";
          const expect = new Uint8Array(await crypto.subtle.digest(hashName, sigVal));
          const tv = await tsd.verify({ signer: 0, data: buf(sigVal), checkChain: false, extendedMode: true });
          const tsaCert = (tsd.certificates ?? []).find((x): x is pkijs.Certificate => x instanceof pkijs.Certificate);
          report.timestamp = {
            time: tst.genTime,
            tsa: tsaCert ? certInfo(tsaCert).subjectCN : "TSA",
            valid: !!tv.signatureVerified && imprint.every((x, i) => x === expect[i]) && imprint.length === expect.length,
          };
          report.signedAt = tst.genTime;
        } catch (e) {
          errors.push("Sello de tiempo no válido: " + (e as Error).message);
        }
      }

      // Validez del certificado en el momento de la firma.
      const when = report.signedAt ?? new Date();
      if (signerCert) {
        report.certValidAtSigning = when >= signerCert.notBefore.value && when <= signerCert.notAfter.value;
        if (!report.certValidAtSigning) errors.push("El certificado no era válido en la fecha de firma");
        // Confianza: construir cadena hasta una raíz de confianza.
        if (roots.length) {
          try {
            const engine = new pkijs.CertificateChainValidationEngine({ trustedCerts: roots, certs: [...certs], checkDate: when });
            const r = await engine.verify();
            report.trusted = r.result;
          } catch {
            report.trusted = false;
          }
        }
      }
    } catch (e) {
      errors.push((e as Error).message);
    }
    reports.push(report);
  }
  return reports;
}

/** Certificados incluidos en una firma (para añadir la raíz a confianza). */
export function signatureCerts(bytes: Uint8Array, index: number): Uint8Array[] {
  const s = findSignatures(bytes)[index];
  if (!s) return [];
  const ci = pkijs.ContentInfo.fromBER(buf(s.contents));
  const sd = new pkijs.SignedData({ schema: ci.content });
  return (sd.certificates ?? []).filter((x): x is pkijs.Certificate => x instanceof pkijs.Certificate).map((x) => new Uint8Array(x.toSchema().toBER()));
}

export function hasSignatures(bytes: Uint8Array): boolean {
  return /\/ByteRange\s*\[/.test(latin1(bytes.subarray(0, Math.min(bytes.length, 50_000_000))));
}

void sha256;
