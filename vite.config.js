import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Host 0.0.0.0 so a phone on the same Wi-Fi can hit the dev server during testing.
export default defineConfig({
  plugins: [react()],
  // GitHub Pages serves from /<repo>/; the deploy workflow sets BASE_PATH. Local
  // dev + root-domain hosts (Vercel/Netlify) use '/'.
  base: process.env.BASE_PATH || '/',
  server: { host: true, port: 5173 },
})
