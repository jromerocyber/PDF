//! Parte nativa de PDF Studio (Tauri): firma con DNIe/tarjetas/almacén del sistema,
//! peticiones a servidores de sellado de tiempo y diálogo nativo de guardado.

mod certs;

use base64::{engine::general_purpose::STANDARD as B64, Engine};
use serde::Serialize;
use std::sync::Mutex;
#[allow(unused_imports)]
use tauri::{Manager, State};
use tauri_plugin_dialog::DialogExt;

#[derive(Default)]
struct OpenedFile(Mutex<Option<std::path::PathBuf>>);

#[derive(Serialize)]
struct FilePayload {
    name: String,
    data: String,
}

#[tauri::command]
async fn list_certificates() -> Result<Vec<certs::SystemCert>, String> {
    tauri::async_runtime::spawn_blocking(certs::list_all).await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn sign_with_certificate(id: String, pin: String, data: String) -> Result<String, String> {
    let bytes = B64.decode(data).map_err(|e| e.to_string())?;
    let sig = tauri::async_runtime::spawn_blocking(move || certs::sign(&id, &pin, &bytes)).await.map_err(|e| e.to_string())??;
    Ok(B64.encode(sig))
}

#[tauri::command]
async fn http_post(url: String, body: String, content_type: String) -> Result<String, String> {
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        return Err("URL no válida".into());
    }
    let body = B64.decode(body).map_err(|e| e.to_string())?;
    let res = tauri::async_runtime::spawn_blocking(move || -> Result<Vec<u8>, String> {
        let client = reqwest::blocking::Client::builder()
            .timeout(std::time::Duration::from_secs(30))
            .user_agent("PDF Studio")
            .build()
            .map_err(|e| e.to_string())?;
        let r = client.post(&url).header("Content-Type", content_type).body(body).send().map_err(|e| e.to_string())?;
        if !r.status().is_success() {
            return Err(format!("El servidor respondió {}", r.status()));
        }
        r.bytes().map(|b| b.to_vec()).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())??;
    Ok(B64.encode(res))
}

#[tauri::command]
async fn save_file(app: tauri::AppHandle, name: String, data: String) -> Result<bool, String> {
    let bytes = B64.decode(data).map_err(|e| e.to_string())?;
    // Pruebas automáticas: guardar sin diálogo en la carpeta indicada.
    if let Ok(dir) = std::env::var("PDFSTUDIO_SAVE_DIR") {
        std::fs::write(std::path::Path::new(&dir).join(&name), bytes).map_err(|e| e.to_string())?;
        return Ok(true);
    }
    let ext = std::path::Path::new(&name).extension().and_then(|e| e.to_str()).unwrap_or("pdf").to_string();
    let path = app.dialog().file().set_file_name(&name).add_filter(ext.to_uppercase(), &[ext.as_str()]).blocking_save_file();
    match path {
        Some(p) => {
            let p = p.into_path().map_err(|e| e.to_string())?;
            std::fs::write(&p, bytes).map_err(|e| format!("No se pudo guardar: {e}"))?;
            Ok(true)
        }
        None => Ok(false),
    }
}

#[tauri::command]
fn initial_file(state: State<OpenedFile>) -> Result<Option<FilePayload>, String> {
    let path = state.0.lock().unwrap().take().or_else(|| {
        std::env::args_os().skip(1).map(std::path::PathBuf::from).find(|p| p.extension().map(|e| e.eq_ignore_ascii_case("pdf")).unwrap_or(false) && p.is_file())
    });
    let Some(path) = path else { return Ok(None) };
    let data = std::fs::read(&path).map_err(|e| e.to_string())?;
    Ok(Some(FilePayload { name: path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| "documento.pdf".into()), data: B64.encode(data) }))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(OpenedFile::default())
        .invoke_handler(tauri::generate_handler![list_certificates, sign_with_certificate, http_post, save_file, initial_file])
        .build(tauri::generate_context!())
        .expect("error al iniciar PDF Studio");
    app.run(|_handle, _event| {
        // macOS: archivo abierto desde el Finder ("Abrir con").
        #[cfg(target_os = "macos")]
        if let tauri::RunEvent::Opened { urls } = &_event {
            if let Some(path) = urls.iter().find_map(|u| u.to_file_path().ok()) {
                *_handle.state::<OpenedFile>().0.lock().unwrap() = Some(path);
            }
        }
    });
}
