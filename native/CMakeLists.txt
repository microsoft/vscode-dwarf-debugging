# The native symbolizer executable (SymbolsBackend), built from our stdio shell
# (serve.cc + native_host.cc).
#
# cxx-debugging-native.cmake pulls this file in with add_subdirectory() when a
# native (non-Emscripten) build is configured. It links DWARFSymbols (the lib/
# library), which is built in the same tree and already links the LLDB libraries
# it depends on: liblldb (the LLDB SB API) plus the host and Wasm plugin
# libraries. The one extra library listed here is the ScriptInterpreterNone
# plugin, which the DefaultPluginsContext in native_host.cc registers.
add_executable(SymbolsBackend
  ${CMAKE_CURRENT_SOURCE_DIR}/serve.cc
  ${CMAKE_CURRENT_SOURCE_DIR}/native_host.cc)

target_link_libraries(SymbolsBackend PRIVATE
  DWARFSymbols
  lldbPluginScriptInterpreterNone)

if (MSVC)
  # Match LLVM's no-RTTI (/GR-); big templates need /bigobj. Silence a few noisy
  # LLVM/LLDB-header warnings (we don't build with /WX).
  target_compile_options(SymbolsBackend PRIVATE
    /GR- /bigobj /EHsc /wd4624 /wd4291 /wd4267 /wd4244 /wd4141 /wd4146 /wd4996)
  target_compile_definitions(SymbolsBackend PRIVATE _CRT_SECURE_NO_WARNINGS NOMINMAX)
  # GUI-subsystem: Windows never allocates a console window when the (GUI)
  # extension host spawns it; stdio pipes still work via the parent's handles.
  # /FORCE:MULTIPLE is the MSVC analogue of --allow-multiple-definition (below):
  # lib/ (WasmVendorPlugins.cc) provides Host/HostInfo overrides that also exist
  # in the in-tree lldbHost; let the linker take the first (lib/'s override).
  target_link_options(SymbolsBackend PRIVATE
    /SUBSYSTEM:WINDOWS /ENTRY:mainCRTStartup /FORCE:MULTIPLE)
else()
  target_compile_options(SymbolsBackend PRIVATE -fno-omit-frame-pointer)
  # lib/ ships HostInfo overrides that also exist in the in-tree lldbHost lib;
  # let the linker pick one.
  target_link_options(SymbolsBackend PRIVATE -Wl,--allow-multiple-definition)
endif()

set_target_properties(SymbolsBackend PROPERTIES
  RUNTIME_OUTPUT_DIRECTORY ${CMAKE_BINARY_DIR}/native)
