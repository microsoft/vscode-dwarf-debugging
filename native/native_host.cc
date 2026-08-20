// Native host for the cxx_debugging symbolizer (lib/ = DWARFSymbols).
//
// With `--serve`, runs the stdio JSON-RPC protocol the extension drives (see
// serve.cc). With a WebAssembly file argument, runs a standalone self-check
// (loads the module, lists its DWARF sources, and probes a few source-line ->
// code mappings) -- useful for verifying a build or for debugging symbolization
// under a native debugger.

#include <cstdint>
#include <cstdio>
#include <string>
#include <vector>

#include "ApiContext.h"
#include "WasmVendorPlugins.h"
#include "serve.h"

#include "Plugins/Language/CPlusPlus/CPlusPlusLanguage.h"
#include "Plugins/ObjectFile/wasm/ObjectFileWasm.h"
#include "Plugins/ScriptInterpreter/None/ScriptInterpreterNone.h"
#include "Plugins/SymbolFile/DWARF/SymbolFileDWARF.h"
#include "Plugins/SymbolVendor/wasm/SymbolVendorWasm.h"
#include "Plugins/TypeSystem/Clang/TypeSystemClang.h"
#include "lldb/Core/Debugger.h"
#include "lldb/Host/FileSystem.h"

#ifdef _WIN32
#include <crtdbg.h>
#include "lldb/Host/windows/HostInfoWindows.h"
using HostInfoT = lldb_private::HostInfoWindows;
#elif defined(__APPLE__)
#include "lldb/Host/macosx/HostInfoMacOSX.h"
using HostInfoT = lldb_private::HostInfoMacOSX;
#else
#include "lldb/Host/linux/HostInfoLinux.h"
using HostInfoT = lldb_private::HostInfoPosix;
#endif

namespace {

struct DefaultPluginsContext
    : symbols_backend::PluginRegistryContext<
          // FileSystem must be initialized first (and therefore terminated
          // last): HostInfo's teardown (~HostInfoBaseFields) calls
          // FileSystem::Instance(). This matches LLDB's SystemInitializerCommon
          // initialization order.
          lldb_private::FileSystem,
          HostInfoT,
          symbols_backend::WasmPlatform,
          lldb_private::ScriptInterpreterNone,
          lldb_private::CPlusPlusLanguage,
          lldb_private::TypeSystemClang,
          lldb_private::wasm::ObjectFileWasm,
          lldb_private::wasm::SymbolVendorWasm,
          symbols_backend::WasmProcess,
          symbols_backend::SymbolFileWasmDWARF> {
  DefaultPluginsContext() : PluginRegistryContext() {
    lldb_private::Debugger::Initialize(nullptr);
  }
  ~DefaultPluginsContext() { lldb_private::Debugger::Terminate(); }
};

// Standalone self-check: load `wasm_path`, list its DWARF sources, and probe a
// few source-line -> code mappings. Returns a process exit code.
int RunSelfCheck(const char* wasm_path) {
  setvbuf(stdout, nullptr, _IONBF, 0);  // unbuffered: survive hard crashes
  printf("== SymbolsBackend self-check ==\nmodule: %s\n\n", wasm_path);

  DefaultPluginsContext plugins;
  symbols_backend::api::ApiContext api;

  auto add = api.AddRawModule("mod1", wasm_path);
  if (auto err = add.GetError()) {
    printf("AddRawModule ERROR: %s\n", err->GetMessage().c_str());
    return 1;
  }
  const std::vector<std::string> sources = add.GetSources();
  printf("AddRawModule OK: %zu source files\n", sources.size());
  for (size_t i = 0; i < sources.size() && i < 8; ++i) {
    printf("  src[%zu] = %s\n", i, sources[i].c_str());
  }
  if (sources.size() > 8) printf("  ... (%zu more)\n", sources.size() - 8);
  if (sources.empty()) {
    printf("\nNo sources; nothing to map.\n");
    return 0;
  }

  // Probe a few source-line -> code mappings. Scan sources (skipping headers
  // and assembly, which rarely carry standalone line tables) and lock onto the
  // first one that actually maps.
  auto ends_with = [](const std::string& s, const char* suf) {
    const std::string x(suf);
    return s.size() >= x.size() && s.compare(s.size() - x.size(), x.size(), x) == 0;
  };
  auto skip = [&](const std::string& p) {
    return ends_with(p, ".h") || ends_with(p, ".hpp") || ends_with(p, ".hh") ||
           ends_with(p, ".inc") || ends_with(p, ".S") || ends_with(p, ".s");
  };

  int mapped = 0;
  std::string probe;
  for (const auto& s : sources) {
    if (skip(s)) continue;
    for (int line = 1; line <= 500 && mapped < 5; ++line) {
      const auto ranges =
          api.SourceLocationToRawLocation("mod1", s, line, 0).GetRawLocationRanges();
      if (ranges.empty()) continue;
      if (probe.empty()) {
        probe = s;
        printf("\nprobing line mappings in: %s\n", s.c_str());
      }
      const int32_t off = ranges[0].GetStartOffset();
      printf("  %s:%d  ->  raw [0x%x, 0x%x)\n", s.c_str(), line, off,
             ranges[0].GetEndOffset());
      const auto fns = api.GetFunctionInfo("mod1", off).GetFunctionNames();
      for (const auto& f : fns) printf("      function: %s\n", f.c_str());
      const auto vlist = api.ListVariablesInScope("mod1", off, 0).GetVariable();
      printf("      variables in scope: %zu\n", vlist.size());
      ++mapped;
    }
    if (!probe.empty()) break;  // first source that mapped wins
  }
  if (mapped == 0) printf("\n(no line mappings found)\n");

  printf("\n== OK: DWARF parsed, %zu sources, %d line(s) mapped ==\n",
         sources.size(), mapped);
  return 0;
}

}  // namespace

int main(int argc, char** argv) {
#ifdef _WIN32
  // Route assertion failures to stderr instead of a modal dialog, so the tool
  // runs non-interactively and can be debugged cleanly (Visual Studio still
  // breaks on the assert).
  _CrtSetReportMode(_CRT_ASSERT, _CRTDBG_MODE_FILE);
  _CrtSetReportFile(_CRT_ASSERT, _CRTDBG_FILE_STDERR);
  _CrtSetReportMode(_CRT_ERROR, _CRTDBG_MODE_FILE);
  _CrtSetReportFile(_CRT_ERROR, _CRTDBG_FILE_STDERR);
#endif

  // Serve mode: stdio NDJSON RPC. No stray output on stdout -- that stream is
  // the protocol channel.
  if (argc > 1 && std::string(argv[1]) == "--serve") {
    DefaultPluginsContext plugins;
    symbols_backend::api::ApiContext api;
    return RunServe(api, argv[0]);
  }

  return RunSelfCheck(argc > 1 ? argv[1] : "app.wasm");
}
