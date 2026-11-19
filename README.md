# PDF Studio

Editor de PDF propio, 100 % gratuito y con licencias libres (sin costes de licencia).
Funciona en navegador y, más adelante, como app de escritorio para Windows, macOS y Linux (Tauri).

## Funciones actuales (fases 1 y 2)
- Abrir o arrastrar PDFs, ver en scroll continuo, zoom, ajustar al ancho
- Miniaturas, selección múltiple (Ctrl/Mayús), reordenar arrastrando
- Buscar texto con resaltado, seleccionar y copiar texto
- Rotar, eliminar, insertar página en blanco, unir PDFs, extraer páginas, dividir en ZIP
- Deshacer/rehacer y atajos (Ctrl+O, Ctrl+S, Ctrl+F, Ctrl+Z, Supr)
- Todo se procesa en el equipo del usuario: el archivo no se sube a ningún servidor

## Arrancar
    npm install
    npm run dev

## Librerías (todas gratuitas, uso comercial permitido)
| Librería | Uso | Licencia |
|---|---|---|
| PDF.js (pdfjs-dist) | Renderizar y extraer texto | Apache-2.0 |
| pdf-lib | Crear y modificar PDFs | MIT |
| fflate | ZIP | MIT |
| React, Vite | Interfaz | MIT |
