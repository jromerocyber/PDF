//! DNIe, tarjetas criptográficas y tokens USB mediante PKCS#11 (OpenSC, módulo oficial del DNIe, etc.).

use super::{digest_info_sha256, ecdsa_raw_to_der, parse, sha256, to_system_cert, KeyType, SystemCert};
use cryptoki::context::{CInitializeArgs, CInitializeFlags, Pkcs11};
use cryptoki::mechanism::{Mechanism, MechanismType};
use cryptoki::object::{Attribute, AttributeType, ObjectClass, ObjectHandle};
use cryptoki::session::{Session, UserType};
use cryptoki::types::AuthPin;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};

/// Rutas habituales de módulos PKCS#11. Se puede añadir más con la variable PDFSTUDIO_PKCS11.
fn candidate_modules() -> Vec<PathBuf> {
    let mut v: Vec<PathBuf> = Vec::new();
    if let Ok(extra) = std::env::var("PDFSTUDIO_PKCS11") {
        let sep = if cfg!(windows) { ';' } else { ':' };
        v.extend(extra.split(sep).filter(|s| !s.is_empty()).map(PathBuf::from));
    }
    #[cfg(target_os = "linux")]
    v.extend(
        [
            "/usr/lib/x86_64-linux-gnu/opensc-pkcs11.so",
            "/usr/lib/aarch64-linux-gnu/opensc-pkcs11.so",
            "/usr/lib64/opensc-pkcs11.so",
            "/usr/lib/opensc-pkcs11.so",
            "/usr/lib/libpkcs11-dnie.so",
            "/usr/lib/x86_64-linux-gnu/libpkcs11-dnie.so",
            "/usr/lib/libbit4xpki.so",
            "/usr/lib/libbit4ipki.so",
        ]
        .map(PathBuf::from),
    );
    #[cfg(target_os = "macos")]
    v.extend(
        [
            "/Library/OpenSC/lib/opensc-pkcs11.so",
            "/opt/homebrew/lib/opensc-pkcs11.so",
            "/usr/local/lib/opensc-pkcs11.so",
            "/Library/Libpkcs11-dnie/lib/libpkcs11-dnie.so",
            "/usr/local/lib/libpkcs11-dnie.so",
            "/usr/local/lib/libbit4xpki.dylib",
        ]
        .map(PathBuf::from),
    );
    #[cfg(windows)]
    v.extend(
        [
            r"C:\Program Files\OpenSC Project\OpenSC\pkcs11\opensc-pkcs11.dll",
            r"C:\Windows\System32\opensc-pkcs11.dll",
            r"C:\Windows\System32\bit4xpki.dll",
        ]
        .map(PathBuf::from),
    );
    let mut seen = std::collections::HashSet::new();
    v.into_iter().filter(|p| p.is_file()).filter(|p| seen.insert(p.canonicalize().unwrap_or_else(|_| p.clone()))).collect()
}

fn contexts() -> &'static Mutex<HashMap<PathBuf, Pkcs11>> {
    static C: OnceLock<Mutex<HashMap<PathBuf, Pkcs11>>> = OnceLock::new();
    C.get_or_init(|| Mutex::new(HashMap::new()))
}

fn with_module<T>(path: &PathBuf, f: impl FnOnce(&Pkcs11) -> Result<T, String>) -> Result<T, String> {
    let mut map = contexts().lock().map_err(|e| e.to_string())?;
    if !map.contains_key(path) {
        let ctx = Pkcs11::new(path).map_err(|e| format!("No se pudo cargar {}: {e}", path.display()))?;
        match ctx.initialize(CInitializeArgs::new(CInitializeFlags::OS_LOCKING_OK)) {
            Ok(()) => {}
            Err(cryptoki::error::Error::Pkcs11(cryptoki::error::RvError::CryptokiAlreadyInitialized, _)) => {}
            Err(e) => return Err(format!("No se pudo iniciar {}: {e}", path.display())),
        }
        map.insert(path.clone(), ctx);
    }
    f(map.get(path).unwrap())
}

fn attr_bytes(session: &Session, obj: ObjectHandle, t: AttributeType) -> Option<Vec<u8>> {
    session.get_attributes(obj, &[t]).ok()?.into_iter().find_map(|a| match a {
        Attribute::Value(v) | Attribute::Id(v) => Some(v),
        _ => None,
    })
}

/// Certificados con clave privada de todos los módulos/tarjetas presentes.
pub fn list() -> Vec<SystemCert> {
    let mut out = Vec::new();
    for (mi, path) in candidate_modules().iter().enumerate() {
        let r = with_module(path, |ctx| {
            let mut found = Vec::new();
            for slot in ctx.get_slots_with_token().map_err(|e| e.to_string())? {
                let label = ctx.get_token_info(slot).map(|t| t.label().trim().to_string()).unwrap_or_default();
                let Ok(session) = ctx.open_ro_session(slot) else { continue };
                let certs = session.find_objects(&[Attribute::Class(ObjectClass::CERTIFICATE)]).unwrap_or_default();
                let mut all: Vec<(Vec<u8>, Vec<u8>)> = Vec::new(); // (der, id)
                for c in certs {
                    let Some(der) = attr_bytes(&session, c, AttributeType::Value) else { continue };
                    let id = attr_bytes(&session, c, AttributeType::Id).unwrap_or_default();
                    all.push((der, id));
                }
                // Las claves privadas suelen ser privadas (no visibles sin PIN): identificamos el certificado
                // del firmante por su uso (firma digital / no repudio) y por no ser de CA.
                let chain: Vec<Vec<u8>> = all.iter().filter(|(d, _)| parse(d).map(|p| p.is_ca).unwrap_or(false)).map(|(d, _)| d.clone()).collect();
                for (der, id) in &all {
                    let sid = format!("p11:{mi}:{}:{}", slot.id(), hex::encode(id));
                    let source = if label.is_empty() { "Tarjeta / DNIe".to_string() } else { format!("Tarjeta: {label}") };
                    if let Some(c) = to_system_cert(sid, der, chain.clone(), &source, true) {
                        found.push(c);
                    }
                }
            }
            Ok(found)
        });
        if let Ok(v) = r {
            out.extend(v);
        }
    }
    out
}

/// Firma con la clave de la tarjeta. `id` = "módulo:slot:idHex".
pub fn sign(id: &str, pin: &str, data: &[u8]) -> Result<Vec<u8>, String> {
    let mut parts = id.splitn(3, ':');
    let mi: usize = parts.next().and_then(|s| s.parse().ok()).ok_or("Id no válido")?;
    let slot_id: u64 = parts.next().and_then(|s| s.parse().ok()).ok_or("Id no válido")?;
    let key_id = hex::decode(parts.next().unwrap_or("")).map_err(|e| e.to_string())?;
    let modules = candidate_modules();
    let path = modules.get(mi).ok_or("La tarjeta ya no está disponible")?;
    with_module(path, |ctx| {
        let slot = ctx.get_slots_with_token().map_err(|e| e.to_string())?.into_iter().find(|s| s.id() == slot_id).ok_or("Inserta la tarjeta o el DNIe")?;
        let session = ctx.open_ro_session(slot).map_err(|e| e.to_string())?;
        let auth = AuthPin::new(pin.to_string().into());
        match session.login(UserType::User, Some(&auth)) {
            Ok(()) => {}
            Err(cryptoki::error::Error::Pkcs11(cryptoki::error::RvError::UserAlreadyLoggedIn, _)) => {}
            Err(cryptoki::error::Error::Pkcs11(cryptoki::error::RvError::PinIncorrect, _)) => return Err("PIN incorrecto".into()),
            Err(cryptoki::error::Error::Pkcs11(cryptoki::error::RvError::PinLocked, _)) => return Err("PIN bloqueado".into()),
            Err(e) => return Err(format!("No se pudo acceder a la tarjeta: {e}")),
        }
        let mut tpl = vec![Attribute::Class(ObjectClass::PRIVATE_KEY)];
        if !key_id.is_empty() {
            tpl.push(Attribute::Id(key_id.clone()));
        }
        let key = *session.find_objects(&tpl).map_err(|e| e.to_string())?.first().ok_or("No se encontró la clave privada en la tarjeta")?;
        // Tipo de clave y si exige PIN por cada firma.
        let attrs = session.get_attributes(key, &[AttributeType::KeyType, AttributeType::AlwaysAuthenticate]).unwrap_or_default();
        let mut kt = KeyType::Rsa;
        let mut always = false;
        for a in attrs {
            match a {
                Attribute::KeyType(t) if t == cryptoki::object::KeyType::EC => kt = KeyType::Ec,
                Attribute::AlwaysAuthenticate(b) => always = b,
                _ => {}
            }
        }
        let mechs = ctx.get_mechanism_list(slot).unwrap_or_default();
        let res = match kt {
            KeyType::Rsa => {
                if mechs.contains(&MechanismType::SHA256_RSA_PKCS) {
                    sign_parts(&session, &Mechanism::Sha256RsaPkcs, key, data, always, &auth)
                } else {
                    let di = digest_info_sha256(&sha256(data));
                    single(&session, &Mechanism::RsaPkcs, key, &di, always, &auth)
                }
            }
            KeyType::Ec => {
                let raw = if mechs.contains(&MechanismType::ECDSA_SHA256) {
                    sign_parts(&session, &Mechanism::EcdsaSha256, key, data, always, &auth)?
                } else {
                    single(&session, &Mechanism::Ecdsa, key, &sha256(data), always, &auth)?
                };
                Ok(if raw.first() == Some(&0x30) && raw.len() % 2 == 1 { raw } else { ecdsa_raw_to_der(&raw) })
            }
        };
        let _ = session.logout();
        res
    })
}

/// Firma en varias partes (permite el login "context-specific" entre el inicio y la firma).
fn sign_parts(s: &Session, m: &Mechanism, key: ObjectHandle, data: &[u8], always: bool, pin: &AuthPin) -> Result<Vec<u8>, String> {
    if !always {
        return s.sign(m, key, data).map_err(|e| format!("La tarjeta no pudo firmar: {e}"));
    }
    s.sign_init(m, key).map_err(|e| e.to_string())?;
    s.login(UserType::ContextSpecific, Some(pin)).map_err(|e| format!("PIN de firma: {e}"))?;
    s.sign_update(data).map_err(|e| e.to_string())?;
    s.sign_final().map_err(|e| format!("La tarjeta no pudo firmar: {e}"))
}

fn single(s: &Session, m: &Mechanism, key: ObjectHandle, data: &[u8], always: bool, pin: &AuthPin) -> Result<Vec<u8>, String> {
    let r = s.sign(m, key, data);
    match r {
        Err(cryptoki::error::Error::Pkcs11(cryptoki::error::RvError::UserNotLoggedIn, _)) if always => {
            // Algunos módulos aceptan el login de contexto justo antes de reintentar.
            let _ = s.login(UserType::ContextSpecific, Some(pin));
            s.sign(m, key, data).map_err(|e| format!("La tarjeta no pudo firmar: {e}"))
        }
        other => other.map_err(|e| format!("La tarjeta no pudo firmar: {e}")),
    }
}

#[cfg(test)]
mod tests {
    /// Prueba con un token real (SoftHSM). Ejecutar con:
    /// PDFSTUDIO_PKCS11=/usr/lib/softhsm/libsofthsm2.so SOFTHSM2_CONF=... cargo test -- --ignored
    #[test]
    #[ignore]
    fn sign_with_token() {
        let certs = super::list();
        assert!(!certs.is_empty(), "no se encontraron certificados");
        let c = &certs[0];
        println!("{} | {} | {} | cadena: {}", c.subject, c.issuer, c.source, c.chain.len());
        let data = b"datos de prueba para firmar";
        let sig = super::sign(c.id.strip_prefix("p11:").unwrap(), "1234", data).expect("firma");
        std::fs::write(std::env::var("OUT_SIG").unwrap_or("/tmp/sig.bin".into()), &sig).unwrap();
        assert!(matches!(super::sign(c.id.strip_prefix("p11:").unwrap(), "0000", data), Err(e) if e.contains("PIN")));
    }
}
