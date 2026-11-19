import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { desktop } from './lib/desktop'
import { setHttpPost } from './lib/sign/cms'

// En escritorio las peticiones a la TSA se hacen desde la parte nativa (sin bloqueo CORS).
if (desktop.available) setHttpPost((url, body, type) => desktop.httpPost(url, body, type))

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
