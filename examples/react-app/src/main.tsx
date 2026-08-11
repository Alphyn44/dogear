import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

// Extensionless, unlike the packages: this app uses bundler resolution, where Vite
// resolves the extension. The packages use nodenext, which requires the explicit `.js`.
import { App } from './App'

const container = document.getElementById('root')
if (container === null) {
  throw new Error('index.html is missing #root')
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
