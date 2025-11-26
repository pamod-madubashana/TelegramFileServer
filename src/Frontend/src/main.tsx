import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.tsx'
import './index.css'

// Add logging for debugging
console.log('Starting Telegram File Server frontend application');

// Check if we're running in Tauri
const isTauri = !!(window as any).__TAURI__;
console.log('Running in Tauri environment:', isTauri);

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)