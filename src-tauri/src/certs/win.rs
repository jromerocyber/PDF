//! Almacén de certificados de Windows ("Personal"). Incluye el DNIe y las tarjetas con minidriver:
//! Windows muestra su propio diálogo para pedir el PIN.

use super::{ecdsa_raw_to_der, parse, sha256, to_system_cert, KeyType, SystemCert};
use sha1::{Digest, Sha1};
use windows::core::w;
use windows::Win32::Security::Cryptography::*;

const CERT_KEY_PROV_INFO_PROP_ID: u32 = 2;

struct Store(HCERTSTORE);
impl Drop for Store {
    fn drop(&mut self) {
        unsafe {
            let _ = CertCloseStore(Some(self.0), 0);
        }
    }
}

fn open() -> Option<Store> {
    unsafe { CertOpenSystemStoreW(None, w!("MY")).ok().map(Store) }
}

fn cert_der(ctx: *const CERT_CONTEXT) -> Vec<u8> {
    unsafe { std::slice::from_raw_parts((*ctx).pbCertEncoded, (*ctx).cbCertEncoded as usize).to_vec() }
}

fn has_private_key(ctx: *const CERT_CONTEXT) -> bool {
    let mut size = 0u32;
    unsafe { CertGetCertificateContextProperty(ctx, CERT_KEY_PROV_INFO_PROP_ID, None, &mut size).is_ok() }
}

/// Recorre el almacén y llama a `f` con cada certificado. Si `f` devuelve Some, se detiene.
fn each<T>(mut f: impl FnMut(*const CERT_CONTEXT) -> Option<T>) -> Option<T> {
    let store = open()?;
    let mut prev: *mut CERT_CONTEXT = std::ptr::null_mut();
    loop {
        let cur = unsafe { CertEnumCertificatesInStore(store.0, if prev.is_null() { None } else { Some(prev as *const _) }) };
        if cur.is_null() {
            return None;
        }
        if let Some(r) = f(cur) {
            unsafe {
                let _ = CertFreeCertificateContext(Some(cur));
            }
            return Some(r);
        }
        prev = cur;
    }
}

pub fn list() -> Vec<SystemCert> {
    let mut out = Vec::new();
    each::<()>(|ctx| {
        if has_private_key(ctx) {
            let der = cert_der(ctx);
            let id = format!("win:{}", hex::encode(Sha1::digest(&der)));
            if let Some(c) = to_system_cert(id, &der, vec![], "Windows", false) {
                out.push(c);
            }
        }
        None
    });
    out
}

pub fn sign(thumb: &str, data: &[u8]) -> Result<Vec<u8>, String> {
    let r = each(|ctx| {
        let der = cert_der(ctx);
        if hex::encode(Sha1::digest(&der)) != thumb {
            return None;
        }
        Some(sign_with(ctx, &der, data))
    });
    r.unwrap_or_else(|| Err("Certificado no encontrado en el almacén de Windows".into()))
}

fn sign_with(ctx: *const CERT_CONTEXT, der: &[u8], data: &[u8]) -> Result<Vec<u8>, String> {
    let key_type = parse(der).map(|p| p.key_type).unwrap_or(KeyType::Rsa);
    let hash = sha256(data);
    unsafe {
        let mut handle = HCRYPTPROV_OR_NCRYPT_KEY_HANDLE::default();
        let mut spec = CERT_KEY_SPEC::default();
        let mut must_free = windows::core::BOOL::default();
        CryptAcquireCertificatePrivateKey(ctx, CRYPT_ACQUIRE_FLAGS(CRYPT_ACQUIRE_ONLY_NCRYPT_KEY_FLAG.0 | CRYPT_ACQUIRE_CACHE_FLAG.0), None, &mut handle, Some(&mut spec), Some(&mut must_free))
            .map_err(|e| format!("No se pudo acceder a la clave privada: {e}"))?;
        let key = NCRYPT_KEY_HANDLE(handle.0);
        let padding = BCRYPT_PKCS1_PADDING_INFO { pszAlgId: BCRYPT_SHA256_ALGORITHM };
        let (pad_ptr, flags) = if key_type == KeyType::Rsa {
            (Some(&padding as *const _ as *const core::ffi::c_void), NCRYPT_FLAGS(NCRYPT_PAD_PKCS1_FLAG.0))
        } else {
            (None, NCRYPT_FLAGS(0))
        };
        let mut size = 0u32;
        let res = NCryptSignHash(key, pad_ptr, &hash, None, &mut size, flags).and_then(|_| {
            let mut sig = vec![0u8; size as usize];
            NCryptSignHash(key, pad_ptr, &hash, Some(&mut sig), &mut size, flags).map(|_| {
                sig.truncate(size as usize);
                sig
            })
        });
        if must_free.as_bool() {
            let _ = NCryptFreeObject(NCRYPT_HANDLE(key.0));
        }
        let sig = res.map_err(|e| format!("Windows no pudo firmar: {e}"))?;
        Ok(if key_type == KeyType::Ec { ecdsa_raw_to_der(&sig) } else { sig })
    }
}
