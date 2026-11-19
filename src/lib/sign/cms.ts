// Construcción de la firma CMS (CAdES-BES, PAdES Baseline B/T) con pkijs (BSD-3).
import * as asn1js from "asn1js";
import * as pkijs from "pkijs";
import type { Signer } from "./signer";
import { parseCert } from "./signer";

export const OID = {
  data: "1.2.840.113549.1.7.1",
  signedData: "1.2.840.113549.1.7.2",
  contentType: "1.2.840.113549.1.9.3",
  messageDigest: "1.2.840.113549.1.9.4",
  signingTime: "1.2.840.113549.1.9.5",
  signingCertificateV2: "1.2.840.113549.1.9.16.2.47",
  timeStampToken: "1.2.840.113549.1.9.16.2.14",
  tstInfo: "1.2.840.113549.1.9.16.1.4",
  sha256: "2.16.840.1.101.3.4.2.1",
  rsa: "1.2.840.113549.1.1.1",
  sha256WithRSA: "1.2.840.113549.1.1.11",
  ecdsaSha256: "1.2.840.10045.4.3.2",
};

export const sha256 = async (data: Uint8Array | ArrayBuffer) => new Uint8Array(await crypto.subtle.digest("SHA-256", data as BufferSource));
const buf = (u: Uint8Array) => u.slice().buffer;

/** Función para hacer peticiones HTTP (en escritorio se sustituye por una sin restricciones CORS). */
export type HttpPost = (url: string, body: Uint8Array, contentType: string) => Promise<Uint8Array>;

export const browserPost: HttpPost = async (url, body, contentType) => {
  const r = await fetch(url, { method: "POST", headers: { "Content-Type": contentType }, body: body as BodyInit });
  if (!r.ok) throw new Error(`El servidor respondió ${r.status}`);
  return new Uint8Array(await r.arrayBuffer());
};

let httpPost: HttpPost = browserPost;
export const setHttpPost = (f: HttpPost) => (httpPost = f);
export const getHttpPost = () => httpPost;

function compareBytes(a: Uint8Array, b: Uint8Array) {
  for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return a[i] - b[i];
  return a.length - b.length;
}

/** Pide un sello de tiempo RFC 3161 sobre `data` a la TSA indicada y devuelve el token (ContentInfo DER). */
export async function requestTimestamp(tsaUrl: string, data: Uint8Array): Promise<Uint8Array> {
  const digest = await sha256(data);
  const nonce = crypto.getRandomValues(new Uint8Array(8));
  nonce[0] &= 0x7f;
  const req = new pkijs.TimeStampReq({
    version: 1,
    messageImprint: new pkijs.MessageImprint({
      hashAlgorithm: new pkijs.AlgorithmIdentifier({ algorithmId: OID.sha256 }),
      hashedMessage: new asn1js.OctetString({ valueHex: buf(digest) }),
    }),
    nonce: new asn1js.Integer({ valueHex: buf(nonce) }),
    certReq: true,
  });
  let resBytes: Uint8Array;
  try {
    resBytes = await httpPost(tsaUrl, new Uint8Array(req.toSchema().toBER()), "application/timestamp-query");
  } catch (e) {
    throw new Error(
      `No se pudo contactar con el servidor de sellado de tiempo (${tsaUrl}). ` +
        `En el navegador muchos servidores lo bloquean; usa la app de escritorio o firma sin sello de tiempo. Detalle: ${(e as Error).message}`,
    );
  }
  const res = pkijs.TimeStampResp.fromBER(buf(resBytes));
  if (res.status.status !== 0 && res.status.status !== 1) {
    throw new Error(`La TSA rechazó la petición (estado ${res.status.status})`);
  }
  if (!res.timeStampToken) throw new Error("La TSA no devolvió sello de tiempo");
  // Comprobar que el sello corresponde a nuestra firma.
  const sd = new pkijs.SignedData({ schema: res.timeStampToken.content });
  const tst = pkijs.TSTInfo.fromBER(sd.encapContentInfo.eContent!.getValue());
  const got = new Uint8Array(tst.messageImprint.hashedMessage.getValue());
  if (compareBytes(got, digest) !== 0) throw new Error("El sello de tiempo no corresponde a la firma");
  return new Uint8Array(res.timeStampToken.toSchema().toBER());
}

export interface CmsOptions {
  tsaUrl?: string;
  /** Incluir signingTime en atributos firmados (no recomendado en PAdES). */
  signingTime?: Date;
}

/** Firma CMS separada (detached) del resumen `digest` (SHA-256 del rango de bytes del PDF). */
export async function buildCms(signer: Signer, digest: Uint8Array, opts: CmsOptions = {}): Promise<Uint8Array> {
  const cert = parseCert(signer.certificate);
  const certHash = await sha256(signer.certificate);

  // ESS signing-certificate-v2 (requerido por PAdES).
  const essCertIdV2 = new asn1js.Sequence({
    value: [
      new asn1js.OctetString({ valueHex: buf(certHash) }), // hashAlgorithm por defecto = SHA-256 (se omite)
      new asn1js.Sequence({
        value: [
          new asn1js.Sequence({ value: [new asn1js.Constructed({ idBlock: { tagClass: 3, tagNumber: 4 }, value: [cert.issuer.toSchema()] })] }),
          new asn1js.Integer({ valueHex: cert.serialNumber.valueBlock.valueHexView.slice().buffer }),
        ],
      }),
    ],
  });
  const signingCertV2 = new asn1js.Sequence({ value: [new asn1js.Sequence({ value: [essCertIdV2] })] });

  const attrs = [
    new pkijs.Attribute({ type: OID.contentType, values: [new asn1js.ObjectIdentifier({ value: OID.data })] }),
    new pkijs.Attribute({ type: OID.messageDigest, values: [new asn1js.OctetString({ valueHex: buf(digest) })] }),
    new pkijs.Attribute({ type: OID.signingCertificateV2, values: [signingCertV2] }),
  ];
  if (opts.signingTime) attrs.push(new pkijs.Attribute({ type: OID.signingTime, values: [new asn1js.UTCTime({ valueDate: opts.signingTime })] }));
  // DER: los elementos de un SET OF van ordenados por su codificación.
  attrs.sort((a, b) => compareBytes(new Uint8Array(a.toSchema().toBER()), new Uint8Array(b.toSchema().toBER())));

  const signedAttrs = new pkijs.SignedAndUnsignedAttributes({ type: 0, attributes: attrs });
  const toSign = new Uint8Array(signedAttrs.toSchema().toBER());
  toSign[0] = 0x31; // [0] IMPLICIT → SET para calcular la firma
  const signature = await signer.sign(toSign);

  const signerInfo = new pkijs.SignerInfo({
    version: 1,
    sid: new pkijs.IssuerAndSerialNumber({ issuer: cert.issuer, serialNumber: cert.serialNumber }),
    digestAlgorithm: new pkijs.AlgorithmIdentifier({ algorithmId: OID.sha256 }),
    signedAttrs,
    signatureAlgorithm:
      signer.keyType === "RSA"
        ? new pkijs.AlgorithmIdentifier({ algorithmId: OID.rsa, algorithmParams: new asn1js.Null() })
        : new pkijs.AlgorithmIdentifier({ algorithmId: OID.ecdsaSha256 }),
    signature: new asn1js.OctetString({ valueHex: buf(signature) }),
  });

  if (opts.tsaUrl) {
    const token = await requestTimestamp(opts.tsaUrl, signature);
    signerInfo.unsignedAttrs = new pkijs.SignedAndUnsignedAttributes({
      type: 1,
      attributes: [new pkijs.Attribute({ type: OID.timeStampToken, values: [asn1js.fromBER(buf(token)).result] })],
    });
  }

  const signed = new pkijs.SignedData({
    version: 1,
    digestAlgorithms: [new pkijs.AlgorithmIdentifier({ algorithmId: OID.sha256 })],
    encapContentInfo: new pkijs.EncapsulatedContentInfo({ eContentType: OID.data }),
    certificates: [cert, ...signer.chain.map(parseCert)],
    signerInfos: [signerInfo],
  });
  const ci = new pkijs.ContentInfo({ contentType: OID.signedData, content: signed.toSchema(true) });
  return new Uint8Array(ci.toSchema().toBER());
}
