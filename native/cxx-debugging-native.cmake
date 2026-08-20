# Native symbolizer build support for @vscode/dwarf-debugging.
#
# This file is APPENDED to cxx_debugging's top-level CMakeLists.txt after
# `gclient sync` (see scripts/build-native.mjs). cxx_debugging already builds
# LLVM+Clang+LLDB in-tree (add_subdirectory of third_party/llvm) and enables the
# clang;lldb projects unconditionally; it only builds lib/src/tests in the WASM
# configuration. This branch adds the equivalent for a NATIVE configuration:
# build lib/ (DWARFSymbols) and the native SymbolsBackend host, reusing that same
# in-tree LLVM/LLDB.
#
# CXX_DEBUGGING_BUILD_WASM is TRUE only when the Emscripten toolchain is used, so
# a plain native configure lands here. The host sources + <emscripten/val.h>
# shim live in the extension; their locations are passed in as cache variables.
if (NOT CXX_DEBUGGING_BUILD_WASM AND DEFINED CXX_DEBUGGING_NATIVE_HOST_DIR)
  # The shim makes lib/'s <emscripten/val.h> resolve to the native
  # DebuggerBackend; it must precede any other include path.
  include_directories(BEFORE ${CXX_DEBUGGING_NATIVE_SHIM})
  add_subdirectory(lib)
  add_subdirectory(${CXX_DEBUGGING_NATIVE_HOST_DIR} native_host_build)
endif()
