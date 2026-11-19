// Puente con la app de escritorio (Tauri). En el navegador `desktop.available` es false
// y todo funciona igual, salvo el acceso a DNIe/tarjetas/almacén de certificados del sistema.
import type { Signer } from "./sign/signer";

export interface SystemCert {
  id: string;
  subject: string;
  issuer: string;
  notAfter: string;
  source: string;
  needsPin: boolean;
  keyType: "RSA" | "EC";
  certDer: string; // base64
  chain: string[]; // base64
}

type Invoke = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;

const w = globalThis as unknown as { __TAURI_INTERNALS__?: { invoke: Invoke } };
const invoke: Invoke | null = w.__TAURI_INTERNALS__ ? (cmd, args) => w.__TAURI_INTERNALS__!.invoke(cmd, args) : null;

const b64 = (u: Uint8Array) => {
  let s = "";
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000));
  return btoa(s);
};
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

export const desktop = {
  available: !!invoke,

  async listCertificates(): Promise<SystemCert[]> {
    if (!invoke) return [];
    return invoke<SystemCert[]>("list_certificates");
  },

  async signer(id: string, pin: string): Promise<Signer> {
    if (!invoke) throw new Error("Solo disponible en la app de escritorio");
    const certs = await this.listCertificates();
    const c = certs.find((x) => x.id === id);
    if (!c) throw new Error("Certificado no encontrado");
    // Prueba de PIN/acceso: firmar un dato de prueba.
    await invoke<string>("sign_with_certificate", { id, pin, data: b64(new Uint8Array(32)) });
    return {
      certificate: unb64(c.certDer),
      chain: c.chain.map(unb64),
      keyType: c.keyType,
      label: c.subject,
      sign: async (data) => unb64(await invoke<string>("sign_with_certificate", { id, pin, data: b64(data) })),
    };
  },

  async httpPost(url: string, body: Uint8Array, contentType: string): Promise<Uint8Array> {
    if (!invoke) throw new Error("Solo disponible en la app de escritorio");
    return unb64(await invoke<string>("http_post", { url, body: b64(body), contentType }));
  },

  /** Guardar con el diálogo nativo. Devuelve false si el usuario cancela. */
  async saveFile(bytes: Uint8Array, name: string): Promise<boolean> {
    if (!invoke) return false;
    return invoke<boolean>("save_file", { name, data: b64(bytes) });
  },

  /** Archivo con el que se abrió la app (doble clic en un PDF). */
  async initialFile(): Promise<{ name: string; bytes: Uint8Array } | null> {
    if (!invoke) return null;
    const r = await invoke<{ name: string; data: string } | null>("initial_file");
    return r ? { name: r.name, bytes: unb64(r.data) } : null;
  },
};
