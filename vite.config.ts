import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

/**
 * LibRaw-Wasm is a pthreads build, and ONNX Runtime uses threads for its WASM
 * backend: both need SharedArrayBuffer, which needs a cross-origin isolated page.
 * Any production host must send the same two headers (see docs/DEPLOYMENT.md).
 */
const isolation = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
};

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  server: { headers: isolation },
  preview: { headers: isolation },
  worker: { format: "es" },
  // These packages locate their worker and .wasm with `new URL(..., import.meta.url)`;
  // pre-bundling would move the module away from those files.
  optimizeDeps: {
    exclude: ["libraw-wasm", "@huggingface/transformers"],
    include: ["exifr", "utif2", "idb", "zustand/vanilla", "@tanstack/react-virtual", "fflate"],
  },
  build: { target: "es2023", sourcemap: true },
});
