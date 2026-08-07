import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// Dev-parity CSP: Tauri's `app.security.csp` is only injected into the production
// bundle. In dev, Vite serves the HTML, so we replicate the lockdown here (with the
// HMR websocket allowance dev needs). Production CSP lives in tauri.conf.json.
const devCsp = [
  "default-src 'self'",
  "connect-src 'self' ipc: http://ipc.localhost ws://localhost:1420 http://localhost:1420",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self'",
  "media-src 'self' blob:",
  "object-src 'none'",
  "frame-src 'none'",
  "base-uri 'self'",
  "form-action 'none'",
].join("; ");

export default defineConfig({
  plugins: [react(), tailwindcss()],
  clearScreen: false,
  // Component tests need a DOM. Pure-logic suites do not care, and jsdom is
  // fast enough that splitting environments per file is not worth the config.
  test: {
    environment: "jsdom",
    globals: false,
  },
  server: {
    port: 1420,
    strictPort: true,
    headers: { "Content-Security-Policy": devCsp },
    watch: { ignored: ["**/src-tauri/**"] },
  },
  build: { target: "safari16" },
});
