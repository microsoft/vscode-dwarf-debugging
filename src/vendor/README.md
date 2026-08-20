# Vendored DevTools RPC sources

These files are vendored (copied) from Chromium's devtools-frontend at
`extensions/cxx_debugging/`, so the **native symbolizer path** (`src/index.ts`)
can be built and type-checked **without** the Docker/emscripten build output in
`chrome-cxx/mnt`.

| File                     | Upstream source                                   |
| ------------------------ | ------------------------------------------------- |
| `WorkerRPC.ts`           | `extensions/cxx_debugging/src/WorkerRPC.ts`       |
| `WasmTypes.ts`           | `extensions/cxx_debugging/src/WasmTypes.ts`       |
| `ModuleConfiguration.ts` | `extensions/cxx_debugging/src/ModuleConfiguration.ts` (types only) |
| `extension-api.d.ts`     | DevTools extension API types (`Chrome.DevTools.*`) |

Only the module import paths were adjusted (to reference the sibling vendored
files); runtime behaviour is byte-for-byte identical to upstream. They define the
package's public RPC contract (`WorkerRPC`, `AsyncHostInterface`,
`WorkerInterface`, `Channel`), which is re-exported from `src/index.ts`.

The Wasm worker (`src/worker.ts`) still imports its RPC glue
(`DevToolsPluginWorker`, `MEMFSResourceLoader`) from the Docker output, because
that path also needs the emscripten-generated bindings; it is only built when
that output is present (see `esbuild.js`).

To refresh these against a newer devtools-frontend: re-copy the four files and
re-apply the import-path edits (drop `.js` extensions; point `Chrome`,
`ModuleConfigurations`, and the WasmTypes imports at the sibling vendored files).
