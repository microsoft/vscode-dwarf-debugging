// Host-driven NATIVE build for the DWARF/C++ Wasm symbolizer -- NO Docker.
//
// This mirrors what the Wasm build does (sync sources, build LLVM+LLDB, produce
// SymbolsBackend), but NATIVELY: it drives cxx_debugging's OWN CMake with the
// host toolchain (no Emscripten), so it builds LLVM+Clang+LLDB in-tree and links
// them directly, building everything from the synced sources.
//
// Prerequisites (documented in native/README.md):
//   * A host C++ toolchain: Visual Studio 2022 (MSVC) on Windows; clang/gcc on
//     macOS/Linux.
//   * depot_tools + Python (for `fetch`/`gclient sync`), unless you point
//     cxxDebuggingSrc at an already-synced tree.
//   * Node (this script) and CMake + Ninja (bundled with VS, or on PATH).
//
// Config precedence: env vars > native/native.config.json > example.
//   * CXX_DEBUGGING_SRC / cxxDebuggingSrc : a synced
//       devtools-frontend/extensions/cxx_debugging (with third_party/llvm). When
//       set + present, the sync step is skipped.
//   * DEVTOOLS_CHECKOUT / devtoolsCheckout : where to fetch devtools-frontend if
//       the above is not available (default: native/.devtools).

import { execFileSync, spawnSync } from 'node:child_process';
import {
  existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync,
} from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const extRoot = resolve(scriptDir, '..');
const nativeDir = join(extRoot, 'native');

const CONFIG_KEYS = {
  CXX_DEBUGGING_SRC: 'cxxDebuggingSrc',
  DEVTOOLS_CHECKOUT: 'devtoolsCheckout',
};

function loadConfig() {
  const files = [
    join(nativeDir, 'native.config.example.json'),
    join(nativeDir, 'native.config.json'),
  ];
  let cfg = {};
  for (const f of files) {
    if (existsSync(f)) cfg = { ...cfg, ...JSON.parse(readFileSync(f, 'utf8')) };
  }
  for (const [envKey, cfgKey] of Object.entries(CONFIG_KEYS)) {
    if (process.env[envKey]) cfg[cfgKey] = process.env[envKey];
  }
  return cfg;
}

const triple = () => `${process.platform}-${process.arch}`;
const run = (cmd, args, opts = {}) => {
  const r = spawnSync(cmd, args, { stdio: 'inherit', ...opts });
  if (r.status !== 0) throw new Error(`\`${cmd} ${args.join(' ')}\` failed (exit ${r.status})`);
};

// --- Windows toolchain discovery (vswhere) -----------------------------------
function findVs() {
  const vswhere =
    'C:\\Program Files (x86)\\Microsoft Visual Studio\\Installer\\vswhere.exe';
  let installPath = null;
  if (existsSync(vswhere)) {
    try {
      installPath = execFileSync(
        vswhere, ['-latest', '-products', '*', '-property', 'installationPath'],
        { encoding: 'utf8' }).trim();
    } catch { /* fall through */ }
  }
  for (const p of [installPath,
    'C:\\Program Files\\Microsoft Visual Studio\\18\\Enterprise',
    'C:\\Program Files\\Microsoft Visual Studio\\2022\\Enterprise',
    'C:\\Program Files\\Microsoft Visual Studio\\2022\\Community']) {
    if (p && existsSync(p)) { installPath = p; break; }
  }
  if (!installPath) throw new Error('Visual Studio 2022 not found (install the C++ workload).');
  const vcvars = join(installPath, 'VC', 'Auxiliary', 'Build', 'vcvars64.bat');
  const ninja = join(installPath, 'Common7', 'IDE', 'CommonExtensions', 'Microsoft',
    'CMake', 'Ninja', 'ninja.exe');
  const cmake = ['C:\\Program Files\\CMake\\bin\\cmake.exe',
    join(installPath, 'Common7', 'IDE', 'CommonExtensions', 'Microsoft', 'CMake',
      'CMake', 'bin', 'cmake.exe')].find(existsSync) || 'cmake';
  return { vcvars, ninja, cmake };
}

// --- Step 1: ensure a synced cxx_debugging tree ------------------------------
function ensureSources(cfg) {
  const isSynced = (d) => d &&
    existsSync(join(d, 'third_party', 'llvm', 'src', 'llvm', 'CMakeLists.txt'));
  if (isSynced(cfg.cxxDebuggingSrc)) return cfg.cxxDebuggingSrc;

  const checkout = resolve(extRoot, cfg.devtoolsCheckout || join('native', '.devtools'));
  const cxxDir = join(checkout, 'devtools-frontend', 'extensions', 'cxx_debugging');
  if (isSynced(cxxDir)) return cxxDir;

  // Sync via depot_tools. `fetch`/`gclient` must be on PATH.
  const has = (t) => spawnSync(t, ['--help'], { stdio: 'ignore', shell: true }).status !== null;
  if (!has('gclient')) {
    throw new Error(
      'No synced cxx_debugging tree found and depot_tools (`fetch`/`gclient`) is ' +
      'not on PATH.\nEither install depot_tools, or set CXX_DEBUGGING_SRC to an ' +
      'existing devtools-frontend/extensions/cxx_debugging checkout. See native/README.md.');
  }
  mkdirSync(checkout, { recursive: true });
  console.log(`== sync: fetching devtools-frontend into ${checkout} ==`);
  if (!existsSync(join(checkout, 'devtools-frontend'))) {
    // fetch may partially fail on the node chmod step; sync fixes it up.
    spawnSync('fetch', ['--nohistory', 'devtools-frontend'],
      { stdio: 'inherit', cwd: checkout, shell: true });
  }
  // Pull the cxx_debugging extension deps (llvm-project, lldb-eval, ...).
  const gclientFile = join(checkout, '.gclient');
  if (existsSync(gclientFile)) {
    let g = readFileSync(gclientFile, 'utf8');
    if (!g.includes('checkout_cxx_debugging_extension_deps')) {
      g = g.replace('"custom_deps": {}',
        '"custom_deps": {},"custom_vars":{"checkout_cxx_debugging_extension_deps":True}');
      writeFileSync(gclientFile, g);
    }
  }
  run('gclient', ['sync'], { cwd: join(checkout, 'devtools-frontend'), shell: true });
  if (!isSynced(cxxDir)) throw new Error(`sync completed but ${cxxDir} is not populated`);
  return cxxDir;
}

// --- Step 2: make cxx_debugging's CMake native-capable ------------------------
// Idempotent, targeted edits (cxx_debugging's native branch is otherwise
// Linux-only). Warn if the expected text isn't found (version drift).
function patchCMake(cxxDir) {
  const topPath = join(cxxDir, 'CMakeLists.txt');
  const libPath = join(cxxDir, 'lib', 'CMakeLists.txt');
  let top = readFileSync(topPath, 'utf8');
  let lib = readFileSync(libPath, 'utf8');

  // (a) Platform-aware LLVM_ON_*: cxx hardcodes UNIX in the non-WASM else().
  if (!top.includes('# @vscode/dwarf-debugging: platform-aware LLVM_ON')) {
    const from = '  set(LLVM_ON_WIN32 0)\n  set(LLVM_ON_UNIX 1)';
    const to =
      '  # @vscode/dwarf-debugging: platform-aware LLVM_ON (was Linux-only)\n' +
      '  if (WIN32)\n    set(LLVM_ON_WIN32 1)\n    set(LLVM_ON_UNIX 0)\n' +
      '  else()\n    set(LLVM_ON_WIN32 0)\n    set(LLVM_ON_UNIX 1)\n  endif()';
    if (top.includes(from)) top = top.replace(from, to);
    else console.warn('[patch] LLVM_ON_* block not found (skipped) -- CMake may have drifted.');
  }

  // (b) Append the native branch (build lib/ + host in the non-WASM config).
  if (!top.includes('CXX_DEBUGGING_NATIVE_HOST_DIR')) {
    top += '\n' + readFileSync(join(nativeDir, 'cxx-debugging-native.cmake'), 'utf8');
  }

  // (c) The extension's TypeScript bundle is only needed by the wasm build; a
  // native configure doesn't build src/, and can't run the Unix `tsc` script on
  // Windows. Guard the whole TS-compile step to the Emscripten (wasm) config.
  const tscAnchor = '# Compile typescript sources\nfind_program(TS_COMPILER tsc PATHS ${DEVTOOLS_SOURCE_DIR}/node_modules/.bin REQUIRED NO_DEFAULT_PATH)';
  const tscTarget = 'add_custom_target(TypescriptOutput DEPENDS ${TS_COMPILER_OUTPUTS})';
  if (top.includes(tscAnchor) && top.includes(tscTarget) &&
      !top.includes('@vscode/dwarf-debugging: TS bundle is wasm-only')) {
    top = top.replace(tscAnchor,
      'if (CMAKE_SYSTEM_NAME STREQUAL "Emscripten")  # @vscode/dwarf-debugging: TS bundle is wasm-only\n' + tscAnchor);
    top = top.replace(tscTarget, tscTarget + '\nendif()  # @vscode/dwarf-debugging TS guard');
  }
  // (e) Single-module LLDB: define LLDB_API empty so the SB API links statically
  // (no dllimport/dllexport) into one module. A SHARED liblldb.dll gives the exe
  // and the DLL each their own LLDB core + PluginManager, so plugins the host
  // registers aren't visible to the SB API's Target -> expression/value
  // evaluation returns empty/invalid types and crashes.
  if (!top.includes('@vscode/dwarf-debugging: LLDB_API')) {
    const llvmAnchor = 'add_subdirectory(${THIRD_PARTY_DIR}/llvm/src/llvm';
    if (top.includes(llvmAnchor)) {
      top = top.replace(llvmAnchor,
        '# @vscode/dwarf-debugging: LLDB_API empty -> single-module static LLDB.\n' +
        'add_compile_definitions(LLDB_API=)\n' + llvmAnchor);
    } else {
      console.warn('[patch] llvm add_subdirectory anchor not found (LLDB_API skipped).');
    }
  }
  writeFileSync(topPath, top);

  // (d) -fno-rtti -> /GR- on MSVC (lib/ uses the GCC flag unconditionally).
  const rtti = 'target_compile_options(DWARFSymbols PUBLIC -fno-rtti)';
  if (lib.includes(rtti) && !lib.includes('/GR-')) {
    lib = lib.replace(rtti,
      'if (MSVC)\n    target_compile_options(DWARFSymbols PUBLIC /GR-)\n' +
      '  else()\n    ' + rtti + '\n  endif()');
    writeFileSync(libPath, lib);
  }

  // (f) Build liblldb STATIC. As SHARED it becomes a separate module
  // (liblldb.dll) that duplicates the LLDB core also linked into the host exe;
  // see (e). Static -> one copy -> one PluginManager/type-system state.
  const apiPath = join(cxxDir, 'third_party', 'llvm', 'src', 'lldb',
    'source', 'API', 'CMakeLists.txt');
  if (existsSync(apiPath)) {
    let api = readFileSync(apiPath, 'utf8');
    if (api.includes('add_lldb_library(liblldb SHARED')) {
      api = api.replace('add_lldb_library(liblldb SHARED',
        'add_lldb_library(liblldb STATIC');
      writeFileSync(apiPath, api);
    }
  }

  // (g) lldb-eval expression parser: the in-tree LLVM is configured without a
  // default target triple, so getDefaultTargetTriple() is empty and
  // CreateTargetInfo() returns null (null-deref). Every module we inspect is
  // wasm32, so fall back to that.
  const parserPath = join(cxxDir, 'third_party', 'lldb-eval', 'src',
    'lldb-eval', 'parser.cc');
  if (existsSync(parserPath)) {
    let parser = readFileSync(parserPath, 'utf8');
    const tripleFrom = 'tOpts->Triple = llvm::sys::getDefaultTargetTriple();';
    if (parser.includes(tripleFrom) && !parser.includes('wasm32-unknown-unknown')) {
      parser = parser.replace(tripleFrom, tripleFrom +
        '\n  if (tOpts->Triple.empty())  // @vscode/dwarf-debugging: native LLVM has no default triple\n' +
        '    tOpts->Triple = "wasm32-unknown-unknown";');
      writeFileSync(parserPath, parser);
    }
  }
}

// Apply the RTTI dynamic-type resolver to lib/Expressions.cc (a code change, so
// carried as a git patch rather than an inline string edit). Idempotent: skipped
// if already present. Enables `Base*` -> `Derived*` display via the Itanium ABI
// (vptr -> type_info -> demangled name -> FindType).
function patchExpressions(cxxDir) {
  const exprPath = join(cxxDir, 'lib', 'Expressions.cc');
  if (!existsSync(exprPath)) return;
  if (readFileSync(exprPath, 'utf8').includes('DemangleTypeInfoName')) return;
  const patch = join(nativeDir, 'patches', 'expressions-rtti.patch');
  if (!existsSync(patch)) {
    console.warn('[patch] expressions-rtti.patch missing -- RTTI dynamic types disabled.');
    return;
  }
  // The patch has repo-root-relative paths and `git apply` resolves them from
  // the repository top level, so run it there (not in the cxx_debugging subdir).
  const top = spawnSync('git', ['-C', cxxDir, 'rev-parse', '--show-toplevel'],
    { encoding: 'utf8' });
  const repoRoot = (top.status === 0 && top.stdout) ? top.stdout.trim() : cxxDir;
  const r = spawnSync('git', ['apply', patch], { cwd: repoRoot, stdio: 'inherit' });
  if (r.status !== 0) {
    console.warn('[patch] expressions-rtti.patch did not apply cleanly (context drift?) -- RTTI dynamic types disabled.');
  }
}

function patchVariables(cxxDir) {
  const modPath = join(cxxDir, 'lib', 'WasmModule.cc');
  if (!existsSync(modPath)) return;
  // Idempotency guard: skip if the artificial-symbol filter is already present.
  if (readFileSync(modPath, 'utf8').includes('Itanium ABI symbols')) return;
  const patch = join(nativeDir, 'patches', 'variables-filter.patch');
  if (!existsSync(patch)) {
    console.warn('[patch] variables-filter.patch missing -- "vtable for X" globals not filtered.');
    return;
  }
  // Repo-root-relative paths: apply from the repository top level.
  const top = spawnSync('git', ['-C', cxxDir, 'rev-parse', '--show-toplevel'],
    { encoding: 'utf8' });
  const repoRoot = (top.status === 0 && top.stdout) ? top.stdout.trim() : cxxDir;
  const r = spawnSync('git', ['apply', patch], { cwd: repoRoot, stdio: 'inherit' });
  if (r.status !== 0) {
    console.warn('[patch] variables-filter.patch did not apply cleanly (context drift?) -- "vtable for X" globals not filtered.');
  }
}

// --- Step 3/4: configure + build ---------------------------------------------
function buildNative(cxxDir, buildDir) {
  const defs = [
    `-DCXX_DEBUGGING_NATIVE_HOST_DIR=${nativeDir.replace(/\\/g, '/')}`,
    `-DCXX_DEBUGGING_NATIVE_SHIM=${join(nativeDir, 'shim').replace(/\\/g, '/')}`,
    '-DCMAKE_BUILD_TYPE=Release',
  ];
  if (process.platform === 'win32') {
    const { vcvars, ninja, cmake } = findVs();
    const cfg = [`"${cmake}"`, '-G', 'Ninja', `-DCMAKE_MAKE_PROGRAM="${ninja}"`,
      '-DCMAKE_C_COMPILER=cl', '-DCMAKE_CXX_COMPILER=cl',
      ...defs.map((d) => `"${d}"`),
      '-S', `"${cxxDir}"`, '-B', `"${buildDir}"`].join(' ');
    const bld = `"${cmake}" --build "${buildDir}" --target SymbolsBackend`;
    const bat = join(tmpdir(), `build-native-${process.pid}.bat`);
    writeFileSync(bat,
      `@echo off\r\ncall "${vcvars}" >nul\r\n${cfg}\r\nif errorlevel 1 exit /b 1\r\n${bld}\r\n`);
    run('cmd.exe', ['/c', bat]);
  } else {
    const gen = spawnSync('ninja', ['--version'], { stdio: 'ignore' }).status === 0
      ? ['-G', 'Ninja'] : [];
    run('cmake', [...gen, ...defs, '-S', cxxDir, '-B', buildDir]);
    run('cmake', ['--build', buildDir, '--target', 'SymbolsBackend', '-j']);
  }
}

// --- Step 5: stage the binary (+ liblldb shared lib) into dist/bin -----------
function stage(buildDir, outDir) {
  mkdirSync(outDir, { recursive: true });
  const exe = process.platform === 'win32' ? 'SymbolsBackend.exe' : 'SymbolsBackend';
  const builtExe = join(buildDir, 'native', exe);
  if (!existsSync(builtExe)) throw new Error(`build succeeded but ${builtExe} is missing`);
  copyFileSync(builtExe, join(outDir, exe));

  // in-tree liblldb is a shared lib; ship it next to the exe.
  const libName = process.platform === 'win32' ? 'liblldb.dll'
    : (process.platform === 'darwin' ? 'liblldb.dylib' : 'liblldb.so');
  const libDir = join(buildDir, 'third_party', 'llvm', 'src', 'llvm',
    process.platform === 'win32' ? 'bin' : 'lib');
  const builtLib = join(libDir, libName);
  if (existsSync(builtLib)) copyFileSync(builtLib, join(outDir, libName));
  else console.warn(`[stage] ${libName} not found at ${builtLib} (static liblldb? ok).`);

  const mb = (readFileSync(builtExe).length / (1024 * 1024)).toFixed(1);
  console.log(`\nOK: staged ${exe} (${mb} MB)${existsSync(builtLib) ? ` + ${libName}` : ''} -> ${outDir}`);
}

function main() {
  const cfg = loadConfig();
  const buildDir = join(nativeDir, 'build', triple());
  const outDir = join(extRoot, 'dist', 'bin', triple());
  console.log(`== native build (${triple()}) ==`);

  const cxxDir = ensureSources(cfg);
  console.log(`  cxx_debugging : ${cxxDir}`);
  patchCMake(cxxDir);
  patchExpressions(cxxDir);
  patchVariables(cxxDir);
  buildNative(cxxDir, buildDir);
  stage(buildDir, outDir);
}

try { main(); } catch (e) {
  console.error(`\nnative build error: ${e.message}`);
  process.exit(1);
}
