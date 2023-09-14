const esbuild = require("esbuild");
const { promises: fs } = require("fs");

(async () => {
  await fs.mkdir("dist", { recursive: true });
  await Promise.all([
    fs.copyFile(
      "chrome-cxx/mnt/extension/SymbolsBackend.wasm",
      "dist/SymbolsBackend.wasm"
    ),

    esbuild.build({
      entryPoints: ["src/index.ts", "src/worker.ts"],
      bundle: true,
      platform: "node",
      target: ["node18"],
      outdir: "dist",
      external: ["ws"],
      inject: ["src/inject.ts"],
      define: {
        "import.meta.url": "import_meta_url",
      },
    }),
  ]);
})();
