# Native DWARF/C++ WebAssembly symbolizer (`SymbolsBackend`)

This builds the DWARF/C++ WebAssembly symbolizer as a **native executable**
(`SymbolsBackend`, `SymbolsBackend.exe` on Windows) instead of compiling it to
WebAssembly (`SymbolsBackend.wasm`).

It is the *same* symbolizer -- it compiles the unchanged cxx_debugging `lib/`
sources and lldb-eval -- but links native LLDB/LLVM/Clang and adds a small stdio
`--serve` shell (`serve.cc` / `native_host.cc`) so the extension can drive it
out-of-process. Because it is a normal native binary, it can be **debugged
directly** by attaching a native debugger (Visual Studio / WinDbg / lldb), and
it is **faster and more robust** than the Worker + ~57 MB WebAssembly module (it
starts as a plain child process and needs no `SharedArrayBuffer`).

At runtime `src/index.ts` prefers the bundled native binary at
`dist/bin/<platform>-<arch>/SymbolsBackend[.exe]`; if none is present it falls
back to the WebAssembly worker.

## How the build works

The native build is the native analogue of the Wasm `bootstrap.py` stage: it
drives **cxx_debugging's own CMake** with the host toolchain (no Emscripten).
cxx_debugging already builds LLVM+Clang+LLDB in-tree (`add_subdirectory` of
`third_party/llvm`) and enables the `clang;lldb` projects unconditionally -- it
only builds `lib/src/tests` in the WASM configuration. A native configure sets
`CXX_DEBUGGING_BUILD_WASM=FALSE`, and `scripts/build-native.mjs`:

1. **Syncs** the sources (`fetch devtools-frontend` + `gclient sync` with
   `checkout_cxx_debugging_extension_deps`), or uses an existing checkout.
2. **Patches** cxx_debugging's CMake (idempotent, targeted edits -- its native
   branch is otherwise Linux-only):
   - append `cxx-debugging-native.cmake` -- the native branch that builds `lib/`
     (`DWARFSymbols`) + our `SymbolsBackend` host (`native/CMakeLists.txt`);
   - make `LLVM_ON_WIN32/UNIX` platform-aware (it hardcodes UNIX);
   - use `/GR-` instead of `-fno-rtti` on MSVC.
3. **Configures + builds** the `SymbolsBackend` target (LLVM+Clang+LLDB in-tree,
   then `DWARFSymbols`, then the host).
4. **Stages** `SymbolsBackend[.exe]` (+ the in-tree `liblldb` shared lib) into
   `dist/bin/<platform>-<arch>/`.

`DWARFSymbols` links the in-tree `liblldb` (the SB API) directly, so there is
**no prebuilt LLVM, no `native.config` paths, and no SB-API archiving**.

## Prerequisites

- **A host C++ toolchain**: Visual Studio 2022 with the C++ workload (MSVC) on
  Windows; clang/gcc on macOS/Linux.
- **depot_tools + Python** on `PATH` (for `fetch` / `gclient sync`). Not needed
  if you point `cxxDebuggingSrc` at an already-synced checkout.
- **Node** (runs the build script) and **CMake + Ninja** (bundled with VS, or on
  `PATH`).

## Building

```
npm run build:native
```

Configuration (env var **or** `native/native.config.json`, copy
`native.config.example.json`):

| Config key / env var                       | Meaning                                                        |
| ------------------------------------------ | -------------------------------------------------------------- |
| `cxxDebuggingSrc` / `CXX_DEBUGGING_SRC`    | An existing synced `extensions/cxx_debugging` (with `third_party/llvm`). When set, the sync step is skipped. |
| `devtoolsCheckout` / `DEVTOOLS_CHECKOUT`   | Where to `fetch devtools-frontend` if the above is not set (default: `native/.devtools`). |

## Platform status

- **Windows (x64):** verified -- cxx_debugging's CMake builds LLVM+Clang+LLDB
  in-tree with MSVC (~8 min on a fast machine) and produces a working
  `SymbolsBackend.exe` (+ `liblldb.dll`). Output is two files because in-tree
  `liblldb` builds as a shared lib; a static `liblldb` for a single file is a
  possible follow-up.
- **macOS / Linux:** `native/CMakeLists.txt` has the platform branches; validate
  the per-host link recipe on those hosts.
