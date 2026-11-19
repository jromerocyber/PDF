//! Acceso a certificados con clave privada: DNIe/tarjetas (PKCS#11), almacén de Windows y llavero de macOS.
//! La interfaz web solo recibe el certificado y pide firmar un bloque de datos: la clave privada nunca sale
//! del dispositivo o del sistema operativo.

pub mod pkcs11;
#[cfg(windows)]
pub mod win;
#[cfg(target_os = "macos")]
pub mod mac;

use base64::{engine::general_purpose::STANDARD as B64, Engine};
use serde::Serialize;
use sha2::{Digest, Sha256};

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SystemCert {
    pub id: String,
    pub subject: String,
    pub issuer: String,
    pub not_after: String,
    pub source: String,
    pub needs_pin: bool,
    pub key_type: String,
    pub cert_der: String,
    pub chain: Vec<String>,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum KeyType {
    Rsa,
    Ec,
}

/// Información legible de un certificado DER.
pub struct Parsed {
    pub subject: String,
    pub issuer: String,
    pub not_after: String,
    pub key_type: KeyType,
    pub can_sign: bool,
    pub is_ca: bool,
}

pub fn parse(der: &[u8]) -> Option<Parsed> {
    use x509_parser::prelude::*;
    let (_, cert) = X509Certificate::from_der(der).ok()?;
    let cn = |n: &X509Name| {
        n.iter_common_name()
            .next()
            .and_then(|a| a.as_str().ok().map(str::to_string))
            .or_else(|| n.iter_organization().next().and_then(|a| a.as_str().ok().map(str::to_string)))
            .unwrap_or_else(|| n.to_string())
    };
    let key_type = if cert.public_key().algorithm.algorithm.to_id_string() == "1.2.840.10045.2.1" { KeyType::Ec } else { KeyType::Rsa };
    let mut can_sign = true;
    if let Ok(Some(ku)) = cert.key_usage() {
        can_sign = ku.value.digital_signature() || ku.value.non_repudiation();
    }
    let is_ca = cert.is_ca();
    let not_after = cert.validity().not_after.to_rfc2822().unwrap_or_default();
    Some(Parsed { subject: cn(cert.subject()), issuer: cn(cert.issuer()), not_after, key_type, can_sign, is_ca })
}

pub fn to_system_cert(id: String, der: &[u8], chain: Vec<Vec<u8>>, source: &str, needs_pin: bool) -> Option<SystemCert> {
    let p = parse(der)?;
    if p.is_ca || !p.can_sign {
        return None;
    }
    Some(SystemCert {
        id,
        subject: p.subject,
        issuer: p.issuer,
        not_after: p.not_after,
        source: source.to_string(),
        needs_pin,
        key_type: if p.key_type == KeyType::Ec { "EC".into() } else { "RSA".into() },
        cert_der: B64.encode(der),
        chain: chain.iter().map(|c| B64.encode(c)).collect(),
    })
}

pub fn sha256(data: &[u8]) -> Vec<u8> {
    Sha256::digest(data).to_vec()
}

/// DigestInfo de SHA-256 (para firmar con mecanismos RSA "en bruto" PKCS#1 v1.5).
pub fn digest_info_sha256(hash: &[u8]) -> Vec<u8> {
    let mut v = vec![0x30, 0x31, 0x30, 0x0d, 0x06, 0x09, 0x60, 0x86, 0x48, 0x01, 0x65, 0x03, 0x04, 0x02, 0x01, 0x05, 0x00, 0x04, 0x20];
    v.extend_from_slice(hash);
    v
}

/// Convierte una firma ECDSA r||s en DER (SEQUENCE { INTEGER r, INTEGER s }).
pub fn ecdsa_raw_to_der(raw: &[u8]) -> Vec<u8> {
    let half = raw.len() / 2;
    let int = |b: &[u8]| {
        let mut i = 0;
        while i < b.len() - 1 && b[i] == 0 {
            i += 1;
        }
        let mut v = b[i..].to_vec();
        if v[0] & 0x80 != 0 {
            v.insert(0, 0);
        }
        let mut out = vec![0x02];
        push_len(&mut out, v.len());
        out.extend(v);
        out
    };
    let mut body = int(&raw[..half]);
    body.extend(int(&raw[half..]));
    let mut out = vec![0x30];
    push_len(&mut out, body.len());
    out.extend(body);
    out
}

fn push_len(out: &mut Vec<u8>, len: usize) {
    if len < 0x80 {
        out.push(len as u8);
    } else if len < 0x100 {
        out.extend([0x81, len as u8]);
    } else {
        out.extend([0x82, (len >> 8) as u8, len as u8]);
    }
}

/// Lista todos los certificados disponibles en el sistema.
pub fn list_all() -> Vec<SystemCert> {
    let mut out = Vec::new();
    #[cfg(windows)]
    out.extend(win::list());
    #[cfg(target_os = "macos")]
    out.extend(mac::list());
    out.extend(pkcs11::list());
    // Quitar duplicados (p. ej. el DNIe visto por el almacén de Windows y por PKCS#11): preferimos el del sistema.
    let mut seen = std::collections::HashSet::new();
    out.retain(|c| seen.insert(c.cert_der.clone()));
    out
}

/// Firma `data` (SHA-256 + clave del certificado). Devuelve la firma (RSA PKCS#1 v1.5, o ECDSA en DER).
pub fn sign(id: &str, pin: &str, data: &[u8]) -> Result<Vec<u8>, String> {
    if let Some(rest) = id.strip_prefix("p11:") {
        return pkcs11::sign(rest, pin, data);
    }
    #[cfg(windows)]
    if let Some(rest) = id.strip_prefix("win:") {
        return win::sign(rest, data);
    }
    #[cfg(target_os = "macos")]
    if let Some(rest) = id.strip_prefix("mac:") {
        return mac::sign(rest, data);
    }
    let _ = (pin, data);
    Err("Certificado no disponible".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn der_ecdsa() {
        let mut raw = vec![0u8; 64];
        raw[0] = 0x80;
        raw[63] = 1;
        let der = ecdsa_raw_to_der(&raw);
        assert_eq!(der[0], 0x30);
        assert_eq!(der[2], 0x02);
        assert_eq!(der[3], 33); // con 0x00 delante
    }
}
