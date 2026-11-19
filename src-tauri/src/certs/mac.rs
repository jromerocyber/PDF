//! Llavero de macOS: identidades (certificado + clave privada), incluidas las de tarjetas (CryptoTokenKit).
//! macOS pide el permiso o el PIN con su propio diálogo.

use super::{parse, to_system_cert, KeyType, SystemCert};
use security_framework::identity::SecIdentity;
use security_framework::item::{ItemClass, ItemSearchOptions, Limit, Reference, SearchResult};
use security_framework::key::Algorithm;
use sha1::{Digest, Sha1};

fn identities() -> Vec<SecIdentity> {
    let Ok(results) = ItemSearchOptions::new().class(ItemClass::identity()).load_refs(true).limit(Limit::All).search() else {
        return vec![];
    };
    results
        .into_iter()
        .filter_map(|r| match r {
            SearchResult::Ref(Reference::Identity(id)) => Some(id),
            _ => None,
        })
        .collect()
}

pub fn list() -> Vec<SystemCert> {
    let mut out = Vec::new();
    for id in identities() {
        let Ok(cert) = id.certificate() else { continue };
        let der = cert.to_der();
        let sid = format!("mac:{}", hex::encode(Sha1::digest(&der)));
        if let Some(c) = to_system_cert(sid, &der, vec![], "Llavero de macOS", false) {
            out.push(c);
        }
    }
    out
}

pub fn sign(thumb: &str, data: &[u8]) -> Result<Vec<u8>, String> {
    for id in identities() {
        let Ok(cert) = id.certificate() else { continue };
        let der = cert.to_der();
        if hex::encode(Sha1::digest(&der)) != thumb {
            continue;
        }
        let key = id.private_key().map_err(|e| format!("No se pudo acceder a la clave privada: {e}"))?;
        let alg = match parse(&der).map(|p| p.key_type) {
            Some(KeyType::Ec) => Algorithm::ECDSASignatureMessageX962SHA256, // ya devuelve DER
            _ => Algorithm::RSASignatureMessagePKCS1v15SHA256,
        };
        return key.create_signature(alg, data).map_err(|e| format!("macOS no pudo firmar: {e}"));
    }
    Err("Certificado no encontrado en el llavero".into())
}
