// Abstracción de "firmante": un certificado y una función que firma bytes.
// Puede venir de un archivo .p12/.pfx (navegador) o de un DNIe/tarjeta/almacén del sistema (escritorio).
import forge from "node-forge";
import * as asn1js from "asn1js";
import * as pkijs from "pkijs";

export interface Signer {
  /** Certificado del firmante (DER). */
  certificate: Uint8Array;
  /** Cadena de certificados (DER), sin incluir el del firmante. */
  chain: Uint8Array[];
  keyType: "RSA" | "EC";
  /** Firma `data` con SHA-256 y devuelve la firma (RSA PKCS#1 v1.5, o ECDSA en DER). */
  sign: (data: Uint8Array) => Promise<Uint8Array>;
  /** Descripción para la interfaz. */
  label: string;
}

export interface CertInfo {
  subjectCN: string;
  subject: string;
  issuerCN: string;
  issuer: string;
  serial: string;
  notBefore: Date;
  notAfter: Date;
  /** NIF/NIE si aparece en el certificado (serialNumber del sujeto). */
  id?: string;
  org?: string;
  email?: string;
  selfSigned: boolean;
}

const OID_NAMES: Record<string, string> = {
  "2.5.4.3": "CN",
  "2.5.4.5": "serialNumber",
  "2.5.4.6": "C",
  "2.5.4.7": "L",
  "2.5.4.8": "ST",
  "2.5.4.10": "O",
  "2.5.4.11": "OU",
  "2.5.4.4": "SN",
  "2.5.4.42": "GN",
  "2.5.4.97": "organizationIdentifier",
  "1.2.840.113549.1.9.1": "E",
};

function nameToMap(name: pkijs.RelativeDistinguishedNames): Record<string, string> {
  const m: Record<string, string> = {};
  for (const tv of name.typesAndValues) {
    const k = OID_NAMES[tv.type] ?? tv.type;
    m[k] = (tv.value.valueBlock as { value?: string }).value ?? "";
  }
  return m;
}
const nameToString = (m: Record<string, string>) =>
  Object.entries(m)
    .map(([k, v]) => `${k}=${v}`)
    .join(", ");

export function parseCert(der: Uint8Array): pkijs.Certificate {
  return pkijs.Certificate.fromBER(der.slice().buffer);
}

export function certInfo(der: Uint8Array | pkijs.Certificate): CertInfo {
  const c = der instanceof Uint8Array ? parseCert(der) : der;
  const s = nameToMap(c.subject);
  const i = nameToMap(c.issuer);
  return {
    subjectCN: s.CN ?? s.O ?? "(sin nombre)",
    subject: nameToString(s),
    issuerCN: i.CN ?? i.O ?? "(sin nombre)",
    issuer: nameToString(i),
    serial: [...new Uint8Array(c.serialNumber.valueBlock.valueHexView)].map((b) => b.toString(16).padStart(2, "0")).join(":"),
    notBefore: c.notBefore.value,
    notAfter: c.notAfter.value,
    id: s.serialNumber?.replace(/^IDC[A-Z]{2}-/, ""),
    org: s.O,
    email: s.E,
    selfSigned: nameToString(s) === nameToString(i),
  };
}

const bin = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0));
const toBinStr = (u: Uint8Array) => {
  let s = "";
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000));
  return s;
};

/** Convierte una firma ECDSA de WebCrypto (r||s) a DER (SEQUENCE { r INTEGER, s INTEGER }). */
export function ecdsaRawToDer(raw: Uint8Array): Uint8Array {
  const half = raw.length / 2;
  const int = (b: Uint8Array) => {
    let i = 0;
    while (i < b.length - 1 && b[i] === 0) i++;
    let v = b.subarray(i);
    if (v[0] & 0x80) v = Uint8Array.from([0, ...v]);
    return new asn1js.Integer({ valueHex: v.slice().buffer });
  };
  return new Uint8Array(new asn1js.Sequence({ value: [int(raw.subarray(0, half)), int(raw.subarray(half))] }).toBER());
}

function ecCurve(pkcs8: Uint8Array): string {
  const info = pkijs.PrivateKeyInfo.fromBER(pkcs8.slice().buffer);
  const params = info.privateKeyAlgorithm.algorithmParams as asn1js.ObjectIdentifier;
  const oid = params?.valueBlock?.toString();
  return oid === "1.3.132.0.34" ? "P-384" : oid === "1.3.132.0.35" ? "P-521" : "P-256";
}

/** Abre un certificado .p12/.pfx con su contraseña. */
export async function signerFromP12(bytes: Uint8Array, password: string): Promise<Signer> {
  let p12: forge.pkcs12.Pkcs12Pfx;
  try {
    p12 = forge.pkcs12.pkcs12FromAsn1(forge.asn1.fromDer(toBinStr(bytes)), password);
  } catch (e) {
    const msg = String((e as Error).message ?? e);
    if (/mac|password|invalid/i.test(msg)) throw new Error("Contraseña del certificado incorrecta");
    throw new Error("No se pudo leer el certificado: " + msg);
  }
  const keyBags = [
    ...(p12.getBags({ bagType: forge.pki.oids.pkcs8ShroudedKeyBag })[forge.pki.oids.pkcs8ShroudedKeyBag] ?? []),
    ...(p12.getBags({ bagType: forge.pki.oids.keyBag })[forge.pki.oids.keyBag] ?? []),
  ];
  const certBags = p12.getBags({ bagType: forge.pki.oids.certBag })[forge.pki.oids.certBag] ?? [];
  if (!keyBags.length) throw new Error("El archivo no contiene una clave privada");
  if (!certBags.length) throw new Error("El archivo no contiene certificados");

  const keyBag = keyBags[0];
  const certDer = (b: forge.pkcs12.Bag) => bin(forge.asn1.toDer(b.cert ? forge.pki.certificateToAsn1(b.cert) : (b.asn1 as forge.asn1.Asn1)).getBytes());
  const certs = certBags.map((b) => ({ der: certDer(b), localKeyId: b.attributes?.localKeyId?.[0] }));
  // Certificado del firmante: el que comparte localKeyId con la clave, o el que no es CA.
  const kid = keyBag.attributes?.localKeyId?.[0];
  let leaf = certs.find((c) => kid && c.localKeyId === kid);
  if (!leaf) leaf = certs.find((c) => !certInfo(c.der).selfSigned) ?? certs[0];
  const chain = certs.filter((c) => c !== leaf).map((c) => c.der);

  let pkcs8: Uint8Array;
  let keyType: Signer["keyType"];
  if (keyBag.key) {
    const rsa = forge.pki.wrapRsaPrivateKey(forge.pki.privateKeyToAsn1(keyBag.key as forge.pki.rsa.PrivateKey));
    pkcs8 = bin(forge.asn1.toDer(rsa).getBytes());
    keyType = "RSA";
  } else if (keyBag.asn1) {
    pkcs8 = bin(forge.asn1.toDer(keyBag.asn1 as forge.asn1.Asn1).getBytes());
    keyType = "EC";
  } else throw new Error("Tipo de clave no compatible");

  const key =
    keyType === "RSA"
      ? await crypto.subtle.importKey("pkcs8", pkcs8 as BufferSource, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"])
      : await crypto.subtle.importKey("pkcs8", pkcs8 as BufferSource, { name: "ECDSA", namedCurve: ecCurve(pkcs8) }, false, ["sign"]);
  const info = certInfo(leaf.der);
  return {
    certificate: leaf.der,
    chain,
    keyType,
    label: info.subjectCN,
    sign: async (data) => {
      if (keyType === "RSA") return new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, data as BufferSource));
      return ecdsaRawToDer(new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, data as BufferSource)));
    },
  };
}
