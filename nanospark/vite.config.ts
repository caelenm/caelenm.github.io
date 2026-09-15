import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import wasm from "vite-plugin-wasm";

// The Spark SDK signs locally with a WASM FROST signer. Webpack cannot resolve
// its WASM URL (see README), so this project is Vite-only.
//
// No vite-plugin-top-level-await here on purpose: that plugin requires rollup
// and esbuild resolved from Vite's own tree, and Vite 8 ships rolldown/oxc
// instead. `target: "esnext"` below supports top-level await natively, which is
// the alternative the plugin exists to provide.
export default defineConfig({
  base: "./", // relative paths, so a build also runs from file:// or a subpath
  plugins: [react(), wasm()],
  build: {
    target: "esnext",
    sourcemap: false,
  },
  worker: {
    format: "es",
    plugins: () => [wasm()],
  },
  optimizeDeps: {
    // The SDK must be pre-bundled, not excluded: it pulls in CommonJS-only
    // dependencies (dayjs among them) whose default export the browser cannot
    // resolve from raw ESM.
    include: ["@buildonspark/spark-sdk"],
    rolldownOptions: { transform: { target: "esnext" } },
  },
  server: {
    port: 5173,
  },
});
