import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import './styles.css'

const mode = new URLSearchParams(window.location.search).get('mode') === 'widget' ? 'widget' : 'main'
document.documentElement.dataset.mode = mode
document.body.dataset.mode = mode

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App mode={mode} />
  </StrictMode>,
)
