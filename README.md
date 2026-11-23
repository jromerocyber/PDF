# PDF Studio

Editor de PDF propio, **100 % gratuito y sin licencias de pago**, para Windows, macOS, Linux y navegador.
Todo se procesa en el equipo del usuario: los documentos y certificados **nunca salen del ordenador** y no hace falta ningún servidor.

## Funciones

| Área | Qué hace |
|---|---|
| **Ver y organizar** | Abrir/arrastrar PDF e imágenes, miniaturas, zoom, búsqueda, rotar, eliminar, duplicar, reordenar arrastrando, insertar páginas en blanco, unir, dividir, extraer, recortar márgenes, marcadores, propiedades, imprimir, deshacer/rehacer |
| **Comentar** | Resaltar, subrayar, tachar, notas, cuadros de texto, lápiz, rectángulos, elipses, líneas, flechas, sellos (APROBADO, CONFIDENCIAL…), imágenes, firma manuscrita (dibujada, escrita o imagen), lista de comentarios con exportación CSV. Se guardan como anotaciones PDF estándar (editables en Acrobat/Foxit) o aplanadas |
| **Editar** | Editar texto existente, añadir texto e imágenes, marca de agua (texto o imagen), encabezados y pies con numeración, numeración Bates, color de fondo, adjuntos, comparar dos PDF |
| **Formularios** | Rellenar campos existentes (texto, casillas, opciones, listas), crear campos nuevos, exportar/importar datos (JSON/CSV) |
| **Firma digital** | Firma **PAdES** (ETSI.CAdES.detached, SHA-256) con certificado **.p12/.pfx** (FNMT, etc.); en escritorio también con **DNIe, tarjetas y tokens USB** (PKCS#11), el **almacén de certificados de Windows** y el **llavero de macOS**. Firma visible con firma manuscrita, **sello de tiempo** (RFC 3161), firma de **certificación** (DocMDP), varias firmas sin invalidar las anteriores, **verificación** de firmas con lista de autoridades de confianza |
| **Seguridad** | Abrir PDF con contraseña, proteger con **AES-256** y permisos, quitar protección, **redacción segura** (el texto se elimina de verdad), buscar y redactar (DNI/NIE, IBAN, teléfonos, correos, tarjetas), limpiar metadatos/JavaScript/adjuntos |
| **Convertir** | PDF → Word (.docx), imágenes (PNG/JPG), texto, HTML; Word/imágenes/texto/HTML → PDF; **OCR** en español e inglés sin conexión; comprimir |

## Instalación

### Escritorio (recomendado)
- **Windows**: ejecuta `PDF Studio_x.y.z_x64-setup.exe`. Al no estar firmado el instalador, Windows SmartScreen puede avisar: «Más información» → «Ejecutar de todas formas».
- **Linux (Debian/Ubuntu)**: `sudo apt install ./PDF\ Studio_x.y.z_amd64.deb`
- **macOS**: el `.dmg` se genera con GitHub Actions (ver abajo). Al no estar notarizado: clic derecho → Abrir la primera vez.

Para firmar con **DNIe o tarjeta criptográfica** hace falta el lector y su controlador:
- Windows: con el controlador oficial del DNIe/tarjeta, los certificados aparecen solos (almacén de Windows). Opcionalmente [OpenSC](https://github.com/OpenSC/OpenSC/releases).
- macOS: [OpenSC](https://github.com/OpenSC/OpenSC/releases) o el módulo oficial del DNIe.
- Linux: `sudo apt install opensc pcscd` (el paquete .deb ya instala OpenSC).
- Otros módulos PKCS#11: variable de entorno `PDFSTUDIO_PKCS11=/ruta/al/modulo.so`.

### Navegador
La carpeta `dist/` es una web estática: se puede subir a cualquier alojamiento (intranet, GitHub Pages gratis, etc.) sin configurar servidor.
En el navegador funcionan todas las funciones salvo el DNIe/tarjetas/almacén del sistema, y algunos servidores de sellado de tiempo que bloquean peticiones desde webs.

## Desarrollo

```bash
npm install
npm run dev            # web en http://localhost:5173
npx tauri dev          # app de escritorio
npm run build          # web en dist/
npx tauri build        # instalador para el sistema actual
```

Compilar los instaladores de todas las plataformas: sube el código a GitHub y crea una etiqueta (`git tag v1.0.0 && git push --tags`) o lanza el flujo **Instaladores** desde la pestaña Actions. El flujo **Web** comprueba en cada cambio que la app compila; para publicar la versión web en GitHub Pages, activa Pages (Settings → Pages → Source: «GitHub Actions») y lánzalo a mano desde Actions.

Pruebas automáticas en navegador (con `npx vite preview --port 4173` en marcha): `node tests/e2e-annots.cjs <carpeta>`, `tests/e2e-docs.cjs`, `tests/e2e-convert.cjs` (los archivos de prueba se generan con `tests/make-sample.mjs` y `tests/fixtures.mts`).

## Librerías (todas gratuitas, uso comercial permitido)

| Librería | Uso | Licencia |
|---|---|---|
| PDF.js | Renderizado, texto, formularios | Apache-2.0 |
| pdf-lib | Crear y modificar PDF | MIT |
| qpdf (WebAssembly) | Cifrado/descifrado, reparación, optimización | Apache-2.0 |
| pkijs, asn1js | Firma CMS/PAdES, sellos de tiempo, verificación | BSD-3 |
| node-forge | Lectura de certificados .p12/.pfx | BSD-3 |
| tesseract.js | OCR | Apache-2.0 |
| docx | Generar Word | MIT |
| mammoth | Leer Word | BSD-2 |
| fflate | ZIP | MIT |
| React, Vite | Interfaz | MIT |
| Tauri | App de escritorio | MIT/Apache-2.0 |
| cryptoki, windows, security-framework | DNIe/tarjetas, almacén de Windows, llavero de macOS | Apache-2.0/MIT |

## Limitaciones conocidas
- **Editar texto existente** tapa el texto original y escribe el nuevo encima con una fuente estándar (Helvetica/Times/Courier): no reutiliza la fuente original del documento.
- **Redacción segura**: las páginas con zonas redactadas se convierten en imagen (así el contenido desaparece de verdad); su texto deja de ser seleccionable salvo que se aplique OCR después.
- **Conversión a Word**: reconstruye párrafos, títulos y listas; maquetaciones complejas (columnas, tablas) pueden variar. **Word → PDF** admite títulos, párrafos, formato, listas, tablas e imágenes, no diseños avanzados.
- Tras una **firma de certificación**, los validadores estrictos solo admiten nuevas firmas en campos de firma ya existentes.
- La identidad del firmante se marca como verificada cuando su autoridad está en la lista de confianza (botón «Confiar en el emisor» en Verificar firmas).
