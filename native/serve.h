// stdio JSON-RPC "serve" mode for the native symbolizer.
//
// Speaks newline-delimited JSON frames on stdin/stdout so a host (a Node
// process today; a VS Code provider later) can drive the ApiContext symbol API
// out-of-process, while the symbolizer calls back for engine state during
// evaluation. This is the native analog of the Wasm build's WorkerRPC, but
// async-only (no SharedArrayBuffer, which can't cross a process boundary): the
// synchronous symbolizer simply block-reads stdin for each state response.
#ifndef VSCODE_DWARF_DEBUGGING_NATIVE_SERVE_H_
#define VSCODE_DWARF_DEBUGGING_NATIVE_SERVE_H_

namespace symbols_backend {
namespace api {
class ApiContext;
}
}  // namespace symbols_backend

// Runs the serve loop until stdin EOF. Returns a process exit code. `exe_path`
// (argv[0]) is used to place the default log next to the executable.
int RunServe(symbols_backend::api::ApiContext& api, const char* exe_path);

#endif  // VSCODE_DWARF_DEBUGGING_NATIVE_SERVE_H_
