const esbuild = require("esbuild");
const { promises: fs, existsSync } = require("fs");

// The WebAssembly worker + module are produced by the (optional) Docker Wasm
// build. When present, bundle the worker and ship the Wasm as a fallback
// backend. When absent (native-only build), skip both; src/index.ts uses the
// bundled native SymbolsBackend binary instead.
const WASM_SRC = "chrome-cxx/mnt/extension/SymbolsBackend.wasm";

(async () => {
  await fs.mkdir("dist", { recursive: true });

  // Ship the vendored DevTools API types next to the emitted vendor/*.d.ts:
  // tsc emits declarations for the vendored .ts sources but does NOT copy input
  // .d.ts files, and vendor/WorkerRPC.d.ts references ./extension-api.
  await fs.mkdir("dist/vendor", { recursive: true });
  const tasks = [
    fs.copyFile("src/vendor/extension-api.d.ts", "dist/vendor/extension-api.d.ts"),
  ];

  const hasWasm = existsSync(WASM_SRC);
  const entryPoints = ["src/index.ts"];

  if (hasWasm) {
    entryPoints.push("src/worker.ts");
    tasks.push(fs.copyFile(WASM_SRC, "dist/SymbolsBackend.wasm"));
  } else {
    console.warn(
      `[esbuild] Wasm output not found (${WASM_SRC}); building native-only ` +
        `(no worker.js / SymbolsBackend.wasm fallback).`
    );
  }

  tasks.push(
    esbuild.build({
      entryPoints,
      bundle: true,
      platform: "node",
      target: ["node18"],
      outdir: "dist",
      external: ["ws"],
      inject: ["src/inject.ts"],
      define: {
        "import.meta.url": "import_meta_url",
      },
    })
  );

  await Promise.all(tasks);
})();
