// WorkerRPC-envelope serve loop speaking the DevTools LanguageExtensionPlugin
// shapes, so the native symbolizer can drop in behind @vscode/dwarf-debugging's
// host-side WorkerRPC (see serve.h). Frames are newline-delimited JSON:
//   symbol request  (host -> us):  {requestId, request:{method, params:[...]}}
//   symbol response (us  -> host): {requestId, response} | {requestId, error}
//   state request   (us -> host):  {requestId, request:{method, params:[...]}}
//   state response  (host -> us):  {requestId, response} | {requestId, error}
// ArrayBuffers are carried as {"__arraybuffer__": "<base64>"} markers (the TS
// Channel does the ArrayBuffer<->marker transform).
#include "serve.h"

#include "ApiContext.h"
#include "api.h"
#include "emscripten/val.h"

#include "llvm/Support/Base64.h"
#include "llvm/ADT/SmallString.h"
#include "llvm/Support/Error.h"
#include "llvm/Support/FileSystem.h"
#include "llvm/Support/FormatVariadic.h"
#include "llvm/Support/JSON.h"

#include <algorithm>
#include <chrono>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <deque>
#include <fstream>
#include <iostream>
#include <map>
#include <string>
#include <variant>
#include <vector>

#ifdef _WIN32
#include <fcntl.h>
#include <io.h>
#include <winsock2.h>
#include <ws2tcpip.h>
#undef GetMessage  // winsock2.h -> windows.h macro clobbers Error::GetMessage
#else
#include <netdb.h>
#include <sys/socket.h>
#include <unistd.h>
#endif

namespace {

using symbols_backend::api::ApiContext;
namespace json = llvm::json;

// ---- NDJSON framing ---------------------------------------------------------

void WriteFrame(json::Object obj) {
  std::string s = llvm::formatv("{0}", json::Value(std::move(obj))).str();
  s.push_back('\n');
  fwrite(s.data(), 1, s.size(), stdout);
  fflush(stdout);
}

bool ReadFrame(json::Value& out) {
  std::string line;
  while (std::getline(std::cin, line)) {
    if (!line.empty() && line.back() == '\r') {
      line.pop_back();
    }
    if (line.empty()) {
      continue;
    }
    auto parsed = json::parse(line);
    if (!parsed) {
      llvm::consumeError(parsed.takeError());
      fprintf(stderr, "[serve] bad frame\n");
      continue;
    }
    out = std::move(*parsed);
    return true;
  }
  return false;
}

// ArrayBuffer marker helpers.
bool DecodeArrayBuffer(const json::Value& v, std::vector<char>& out) {
  if (auto* o = v.getAsObject()) {
    if (auto b64 = o->getString("__arraybuffer__")) {
      if (auto e = llvm::decodeBase64(*b64, out)) {
        llvm::consumeError(std::move(e));
        return false;
      }
      return true;
    }
  }
  return false;
}
json::Value MakeArrayBuffer(const void* data, size_t size) {
  json::Object o;
  o["__arraybuffer__"] =
      llvm::encodeBase64(llvm::ArrayRef<uint8_t>(
          static_cast<const uint8_t*>(data), size));
  return json::Value(std::move(o));
}

// Minimal cross-platform HTTP/1.x GET (no TLS). js-debug delivers the module as
// a { url } with no bytes; native fetches it itself so breakpoints work
// regardless of whether the shim also fetched. https urls have no native TLS
// and are handled by the shim (which injects `code`).
bool FetchHttp(const std::string& url, std::vector<char>& out) {
  auto scheme = url.find("://");
  if (scheme == std::string::npos) {
    return false;
  }
  std::string rest = url.substr(scheme + 3);
  auto slash = rest.find('/');
  std::string hostport = (slash == std::string::npos) ? rest : rest.substr(0, slash);
  std::string path = (slash == std::string::npos) ? "/" : rest.substr(slash);
  std::string host = hostport;
  std::string port = "80";
  auto colon = hostport.find(':');
  if (colon != std::string::npos) {
    host = hostport.substr(0, colon);
    port = hostport.substr(colon + 1);
  }

#ifdef _WIN32
  WSADATA wsa;
  if (WSAStartup(MAKEWORD(2, 2), &wsa) != 0) {
    return false;
  }
#endif
  bool ok = false;
  addrinfo hints = {};
  hints.ai_family = AF_UNSPEC;
  hints.ai_socktype = SOCK_STREAM;
  addrinfo* res = nullptr;
  if (getaddrinfo(host.c_str(), port.c_str(), &hints, &res) == 0) {
    for (addrinfo* a = res; a && !ok; a = a->ai_next) {
#ifdef _WIN32
      SOCKET s = socket(a->ai_family, a->ai_socktype, a->ai_protocol);
      if (s == INVALID_SOCKET) {
        continue;
      }
#else
      int s = socket(a->ai_family, a->ai_socktype, a->ai_protocol);
      if (s < 0) {
        continue;
      }
#endif
      if (connect(s, a->ai_addr, static_cast<int>(a->ai_addrlen)) == 0) {
        std::string req = "GET " + path + " HTTP/1.1\r\nHost: " + host +
                          "\r\nConnection: close\r\nUser-Agent: native-symbolizer\r\n\r\n";
        send(s, req.data(), static_cast<int>(req.size()), 0);
        std::string resp;
        char buf[16384];
        for (;;) {
          int n = recv(s, buf, sizeof(buf), 0);
          if (n <= 0) {
            break;
          }
          resp.append(buf, static_cast<size_t>(n));
        }
        auto hdrEnd = resp.find("\r\n\r\n");
        if (hdrEnd != std::string::npos &&
            (resp.compare(0, 12, "HTTP/1.1 200") == 0 ||
             resp.compare(0, 12, "HTTP/1.0 200") == 0)) {
          out.assign(resp.begin() + hdrEnd + 4, resp.end());
          ok = !out.empty();
        }
      }
#ifdef _WIN32
      closesocket(s);
#else
      close(s);
#endif
    }
    freeaddrinfo(res);
  }
#ifdef _WIN32
  WSACleanup();
#endif
  return ok;
}

const char* ScopeName(symbols_backend::api::Variable::Scope s) {
  switch (s) {
    case symbols_backend::api::Variable::Scope::kLocal:
      return "LOCAL";
    case symbols_backend::api::Variable::Scope::kParameter:
      return "PARAMETER";
    case symbols_backend::api::Variable::Scope::kGlobal:
      return "GLOBAL";
  }
  return "LOCAL";
}

// ---- protocol logging (opt-in via NATIVE_SYMBOLIZER_LOG=<file>) -------------

FILE* g_log = nullptr;
std::chrono::steady_clock::time_point g_log_start;

void LogInit(const std::string& exe_path) {
  (void)exe_path;
  g_log_start = std::chrono::steady_clock::now();
  // Opt-in only: set NATIVE_SYMBOLIZER_LOG=<file> to enable the RPC trace.
  // Silent by default so normal runs don't write logs.
  if (const char* p = std::getenv("NATIVE_SYMBOLIZER_LOG")) {
    g_log = fopen(p, "a");
    if (g_log) {
      fprintf(g_log, "\n=== native-symbolizer serve start ===\n");
      fflush(g_log);
    }
  }
}
void Log(const std::string& s) {
  if (!g_log) {
    return;  // logging disabled
  }
  auto ms = std::chrono::duration_cast<std::chrono::milliseconds>(
                std::chrono::steady_clock::now() - g_log_start)
                .count();
  char ts[24];
  std::snprintf(ts, sizeof(ts), "[%7lldms] ", static_cast<long long>(ms));
  fprintf(g_log, "%s%s\n", ts, s.c_str());
  fflush(g_log);
}
// Compact JSON, truncated so huge payloads (e.g. a module's base64 code) don't
// flood the log.
std::string BriefJson(const json::Value& v, size_t maxLen = 400) {
  std::string s = llvm::formatv("{0}", v).str();
  if (s.size() > maxLen) {
    s = s.substr(0, maxLen) + "...(" + std::to_string(s.size()) + " chars)";
  }
  return s;
}

struct StoredObject {
  std::string rawModuleId;
  int32_t codeOffset = 0;
  int32_t inlineFrameIndex = 0;
  std::string expression;
  json::Value stopId{nullptr};
};

// ---- Server -----------------------------------------------------------------

class Server;

// State-channel backend: turns DebuggerProxy reads/writes into state requests.
class RpcBackend : public emscripten::native::DebuggerBackend {
 public:
  explicit RpcBackend(Server& server) : server_(server) {}
  size_t ReadMemory(size_t address, void* buffer, size_t size) override;
  size_t WriteMemory(size_t address, const void* buffer, size_t size) override;
  emscripten::native::WasmValue GetLocal(size_t i) override;
  emscripten::native::WasmValue GetGlobal(size_t i) override;
  emscripten::native::WasmValue GetOperand(size_t i) override;

 private:
  emscripten::native::WasmValue GetVal(llvm::StringRef method, size_t index);
  Server& server_;
};

class Server {
 public:
  explicit Server(ApiContext& api, std::string exe_path)
      : api_(api),
        backend_(*this),
        proxy_(&backend_),
        exe_path_(std::move(exe_path)) {}

  int Run() {
#ifdef _WIN32
    _setmode(_fileno(stdout), _O_BINARY);
#endif
    LogInit(exe_path_);
    Log("ready (DevTools LanguageExtensionPlugin over stdio)");
    for (;;) {
      json::Value req{nullptr};
      if (!NextSymbolRequest(req)) {
        break;
      }
      auto* o = req.getAsObject();
      auto* request = o->getObject("request");
      int64_t id = 0;
      if (auto v = o->getInteger("requestId")) {
        id = *v;
      }
      llvm::StringRef method;
      if (auto m = request->getString("method")) {
        method = *m;
      }
      const json::Array* params = request->getArray("params");

      if (method == "addRawModule") {
        const json::Array* p = params;
        const json::Object* rm =
            (p && p->size() > 2) ? (*p)[2].getAsObject() : nullptr;
        std::string url = rm ? ObjStr(rm, "url") : std::string();
        std::string codeInfo = "none";
        std::string keys;
        if (rm) {
          for (const auto& kv : *rm) {
            keys += (keys.empty() ? "" : ",") + llvm::StringRef(kv.first).str();
          }
          if (const json::Value* c = rm->get("code")) {
            if (auto* co = c->getAsObject()) {
              if (auto b64 = co->getString("__arraybuffer__")) {
                codeInfo = "abmarker:" + std::to_string(b64->size()) + "b64";
              } else {
                codeInfo = "object";
              }
            } else if (auto s = c->getAsString()) {
              codeInfo = "string:" + std::to_string(s->size());
            } else if (auto* arr = c->getAsArray()) {
              codeInfo = "array:" + std::to_string(arr->size());
            } else {
              codeInfo = "other";
            }
          }
        }
        Log(">> addRawModule id=" + ArgStr(params, 0) + " symbolsURL=" +
            ArgStr(params, 1) + " rawModule.keys=[" + keys + "] url=" + url +
            " code=" + codeInfo);
      } else {
        Log(">> " + method.str() + " " +
            BriefJson(params ? json::Value(json::Array(*params))
                             : json::Value(nullptr)));
      }

      auto result = Dispatch(method, params);
      json::Object resp;
      resp["requestId"] = id;
      if (auto* err = std::get_if<std::string>(&result)) {
        Log("<< " + method.str() + " ERROR: " + *err);
        resp["error"] = *err;
      } else {
        json::Value& rv = std::get<json::Value>(result);
        Log("<< " + method.str() + " " + BriefJson(rv));
        resp["response"] = std::move(rv);
      }
      WriteFrame(std::move(resp));
    }
    Log("stdin closed, exiting");
    return 0;
  }

  // Called by RpcBackend: send a state request, block for its response.
  json::Value StateCall(llvm::StringRef method, json::Array params) {
    int id = next_state_id_++;
    Log("   -> " + method.str() + " " +
        BriefJson(json::Value(json::Array(params))));
    json::Object request;
    request["method"] = method;
    request["params"] = std::move(params);
    json::Object frame;
    frame["requestId"] = id;
    frame["request"] = std::move(request);
    WriteFrame(std::move(frame));

    json::Value f{nullptr};
    while (ReadFrame(f)) {
      auto* o = f.getAsObject();
      if (!o) {
        continue;
      }
      if (o->getObject("request")) {
        // A symbol request arrived while we were blocked: defer it.
        deferred_.push_back(std::move(f));
        continue;
      }
      // Otherwise it's a response/error to our state request.
      if (auto* e = o->get("error")) {
        Log("   <- " + method.str() + " ERROR: " + BriefJson(*e));
        return json::Value(nullptr);
      }
      if (auto* r = o->get("response")) {
        Log("   <- " + method.str() + " " + BriefJson(*r));
        return json::Value(*r);
      }
      return json::Value(nullptr);
    }
    return json::Value(nullptr);
  }

  const json::Value& stop_id() const { return stop_id_; }

 private:
  using DispatchResult = std::variant<json::Value, std::string>;

  bool NextSymbolRequest(json::Value& out) {
    if (!deferred_.empty()) {
      out = std::move(deferred_.front());
      deferred_.pop_front();
      return true;
    }
    while (ReadFrame(out)) {
      auto* o = out.getAsObject();
      if (o && o->getObject("request")) {
        return true;
      }
      // Ignore stray responses at top level.
    }
    return false;
  }

  static std::string ArgStr(const json::Array* p, size_t i) {
    if (p && p->size() > i) {
      if (auto s = (*p)[i].getAsString()) {
        return s->str();
      }
    }
    return {};
  }
  static int64_t ArgInt(const json::Array* p, size_t i) {
    if (p && p->size() > i) {
      if (auto n = (*p)[i].getAsInteger()) {
        return *n;
      }
    }
    return 0;
  }
  static const json::Object* ArgObj(const json::Array* p, size_t i) {
    if (p && p->size() > i) {
      return (*p)[i].getAsObject();
    }
    return nullptr;
  }
  static std::string ObjStr(const json::Object* o, const char* k) {
    if (o) {
      if (auto s = o->getString(k)) {
        return s->str();
      }
    }
    return {};
  }
  static int64_t ObjInt(const json::Object* o, const char* k) {
    if (o) {
      if (auto n = o->getInteger(k)) {
        return *n;
      }
    }
    return 0;
  }

  symbols_backend::api::RawLocation RawLoc(const json::Object* o) {
    symbols_backend::api::RawLocation loc;
    loc.SetRawModuleId(ObjStr(o, "rawModuleId"))
        .SetCodeOffset(static_cast<int32_t>(ObjInt(o, "codeOffset")))
        .SetInlineFrameIndex(static_cast<int32_t>(ObjInt(o, "inlineFrameIndex")));
    return loc;
  }

  DispatchResult Dispatch(llvm::StringRef method, const json::Array* params) {
    if (method == "hello") {
      return json::Value(nullptr);
    }
    if (method == "addRawModule") {
      return AddRawModule(params);
    }
    if (method == "removeRawModule") {
      std::string id = ArgStr(params, 0);
      api_.RemoveRawModule(id);
      auto it = module_temp_paths_.find(id);
      if (it != module_temp_paths_.end()) {
        llvm::sys::fs::remove(it->second);
        module_temp_paths_.erase(it);
      }
      return json::Value(nullptr);
    }
    if (method == "sourceLocationToRawLocation") {
      const json::Object* sl = ArgObj(params, 0);
      auto resp = api_.SourceLocationToRawLocation(
          ObjStr(sl, "rawModuleId"), ObjStr(sl, "sourceFileURL"),
          static_cast<int32_t>(ObjInt(sl, "lineNumber")),
          static_cast<int32_t>(ObjInt(sl, "columnNumber")));
      if (auto e = resp.GetError()) {
        return e->GetMessage();
      }
      json::Array ranges;
      for (const auto& r : resp.GetRawLocationRanges()) {
        json::Object o;
        o["rawModuleId"] = r.GetRawModuleId();
        o["startOffset"] = r.GetStartOffset();
        o["endOffset"] = r.GetEndOffset();
        ranges.push_back(std::move(o));
      }
      return json::Value(std::move(ranges));
    }
    if (method == "rawLocationToSourceLocation") {
      auto resp = api_.RawLocationToSourceLocation(
          ObjStr(ArgObj(params, 0), "rawModuleId"),
          static_cast<int32_t>(ObjInt(ArgObj(params, 0), "codeOffset")),
          static_cast<int32_t>(ObjInt(ArgObj(params, 0), "inlineFrameIndex")));
      if (auto e = resp.GetError()) {
        return e->GetMessage();
      }
      json::Array locs;
      for (const auto& sl : resp.GetSourceLocation()) {
        json::Object o;
        o["rawModuleId"] = sl.GetRawModuleId();
        o["sourceFileURL"] = sl.GetSourceFile();
        o["lineNumber"] = sl.GetLineNumber();
        o["columnNumber"] = sl.GetColumnNumber();
        locs.push_back(std::move(o));
      }
      return json::Value(std::move(locs));
    }
    if (method == "listVariablesInScope") {
      const json::Object* rl = ArgObj(params, 0);
      auto resp = api_.ListVariablesInScope(
          ObjStr(rl, "rawModuleId"),
          static_cast<int32_t>(ObjInt(rl, "codeOffset")),
          static_cast<int32_t>(ObjInt(rl, "inlineFrameIndex")));
      if (auto e = resp.GetError()) {
        return e->GetMessage();
      }
      json::Array vars;
      for (const auto& v : resp.GetVariable()) {
        json::Object o;
        o["scope"] = ScopeName(v.GetScope());
        o["name"] = v.GetName();
        o["type"] = v.GetType();
        vars.push_back(std::move(o));
      }
      return json::Value(std::move(vars));
    }
    if (method == "getFunctionInfo") {
      const json::Object* rl = ArgObj(params, 0);
      auto resp = api_.GetFunctionInfo(
          ObjStr(rl, "rawModuleId"),
          static_cast<int32_t>(ObjInt(rl, "codeOffset")));
      json::Object out;
      json::Array frames;
      for (const auto& name : resp.GetFunctionNames()) {
        json::Object f;
        f["name"] = name;
        frames.push_back(std::move(f));
      }
      out["frames"] = std::move(frames);
      out["missingSymbolFiles"] = json::Array{};
      return json::Value(std::move(out));
    }
    if (method == "getInlinedFunctionRanges" ||
        method == "getInlinedCalleesRanges") {
      const json::Object* rl = ArgObj(params, 0);
      auto ranges =
          (method == "getInlinedFunctionRanges")
              ? api_.GetInlinedFunctionRanges(
                    ObjStr(rl, "rawModuleId"),
                    static_cast<int32_t>(ObjInt(rl, "codeOffset")))
                    .GetRawLocationRanges()
              : api_.GetInlinedCalleesRanges(
                    ObjStr(rl, "rawModuleId"),
                    static_cast<int32_t>(ObjInt(rl, "codeOffset")))
                    .GetRawLocationRanges();
      json::Array out;
      for (const auto& r : ranges) {
        json::Object o;
        o["rawModuleId"] = r.GetRawModuleId();
        o["startOffset"] = r.GetStartOffset();
        o["endOffset"] = r.GetEndOffset();
        out.push_back(std::move(o));
      }
      return json::Value(std::move(out));
    }
    if (method == "getMappedLines") {
      auto resp = api_.GetMappedLines(ArgStr(params, 0), ArgStr(params, 1));
      json::Array lines;
      for (int32_t l : resp.GetMappedLines()) {
        lines.push_back(l);
      }
      return json::Value(std::move(lines));
    }
    if (method == "getScopeInfo") {
      std::string type = ArgStr(params, 0);
      json::Object o;
      o["type"] = type;
      o["typeName"] = type == "LOCAL"       ? "Local"
                      : type == "PARAMETER" ? "Parameter"
                      : type == "GLOBAL"    ? "Global"
                                            : type;
      return json::Value(std::move(o));
    }
    if (method == "evaluate") {
      return Evaluate(params);
    }
    if (method == "getProperties") {
      return GetProperties(ArgStr(params, 0));
    }
    if (method == "releaseObject") {
      objects_.erase(ArgStr(params, 0));
      return json::Value(nullptr);
    }
    return std::string("unknown method: ") + method.str();
  }

  DispatchResult AddRawModule(const json::Array* params) {
    std::string id = ArgStr(params, 0);
    const json::Object* rawModule = ArgObj(params, 2);
    std::string path;
    std::vector<char> code;
    if (rawModule) {
      // 1. Inline bytes, if the host provided them.
      if (auto* codeVal = rawModule->get("code")) {
        DecodeArrayBuffer(*codeVal, code);
      }
      // 2. Otherwise resolve the url. http -> fetch natively (robust to any
      //    shim version); https -> handled by the shim (native has no TLS);
      //    file:// or plain path -> use directly.
      if (code.empty()) {
        std::string url = ObjStr(rawModule, "url");
        if (url.rfind("http://", 0) == 0) {
          if (!FetchHttp(url, code)) {
            Log("   FetchHttp failed: " + url);
          }
        } else if (url.rfind("file://", 0) == 0) {
          path = url.substr(std::string("file://").size());
        } else if (!url.empty() && url.rfind("https://", 0) != 0) {
          path = url;
        }
      }
    }
    // Materialize fetched/inline bytes to a temp file for LLDB to open.
    if (!code.empty()) {
      llvm::SmallString<128> tmp;
      if (auto ec = llvm::sys::fs::createTemporaryFile("wasmmod", "wasm", tmp)) {
        return std::string("temp file error: ") + ec.message();
      }
      std::ofstream ofs(tmp.c_str(), std::ios::binary);
      ofs.write(code.data(), code.size());
      ofs.close();
      path = std::string(tmp.str());
      module_temp_paths_[id] = path;
    }
    auto resp = api_.AddRawModule(id, path);
    if (auto e = resp.GetError()) {
      Log("   AddRawModule FAILED: path='" + path + "' codeBytes=" +
          std::to_string(code.size()) + " err=" + e->GetMessage());
      json::Object missing;
      missing["missingSymbolFiles"] = json::Array{};
      return json::Value(std::move(missing));
    }
    Log("   AddRawModule OK: path='" + path + "' sources=" +
        std::to_string(resp.GetSources().size()));
    json::Array sources;
    for (const auto& s : resp.GetSources()) {
      sources.push_back(s);
    }
    return json::Value(std::move(sources));
  }

  DispatchResult Evaluate(const json::Array* params) {
    std::string expr = ArgStr(params, 0);
    const json::Object* ctx = ArgObj(params, 1);
    stop_id_ = (params && params->size() > 2) ? (*params)[2] : json::Value(nullptr);

    symbols_backend::api::RawLocation loc = RawLoc(ctx);
    auto resp = api_.EvaluateExpression(loc, expr, proxy_);
    if (auto e = resp.GetError()) {
      return e->GetMessage();
    }
    return BuildRemoteObject(resp, loc, expr);
  }

  // Recognize libc++ (emscripten) std::string. `typeName` is the display name.
  static bool StartsWith(const std::string& s, const char* p) {
    return s.rfind(p, 0) == 0;
  }
  static bool IsStdStringType(const std::string& n) {
    return n == "std::string" || n == "std::__2::string" ||
           StartsWith(n, "std::basic_string<char") ||
           StartsWith(n, "std::__2::basic_string<char");
  }

  // Render `size` bytes at `data_addr` as a quoted, printable-escaped string.
  std::string RenderQuotedString(uint32_t data_addr, uint32_t size) {
    if (size > 8192) {
      size = 8192;  // sanity cap for display
    }
    std::string out(size, '\0');
    size_t n = size ? backend_.ReadMemory(data_addr, out.data(), size) : 0;
    out.resize(n);
    std::string shown = "\"";
    for (char c : out) {
      unsigned char uc = static_cast<unsigned char>(c);
      if (c == '"' || c == '\\') {
        shown += '\\';
        shown += c;
      } else if (uc >= 0x20 && uc < 0x7f) {
        shown += c;
      } else if (c == '\n') {
        shown += "\\n";
      } else if (c == '\t') {
        shown += "\\t";
      } else {
        shown += '.';
      }
    }
    shown += "\"";
    return shown;
  }

  // Read a libc++ std::string's contents from wasm memory. wasm32 alternate
  // layout: [__data_ ptr][__size_][__cap_], with the "is long" flag in the high
  // bit of the last byte; short strings store the chars inline from byte 0 and
  // the size in the low 7 bits of the last byte.
  llvm::Optional<std::string> FormatStdString(uint32_t addr) {
    uint8_t rep[12] = {0};
    if (backend_.ReadMemory(addr, rep, sizeof(rep)) < sizeof(rep)) {
      return llvm::None;
    }
    auto u32 = [&](int i) {
      return uint32_t(rep[i]) | (uint32_t(rep[i + 1]) << 8) |
             (uint32_t(rep[i + 2]) << 16) | (uint32_t(rep[i + 3]) << 24);
    };
    bool is_long = (rep[11] & 0x80) != 0;
    uint32_t data_addr = is_long ? u32(0) : addr;
    uint32_t size = is_long ? u32(4) : (rep[11] & 0x7F);
    return RenderQuotedString(data_addr, size);
  }

  // std::string_view: [__data_ ptr][__size_]. Read the referenced chars.
  static bool IsStdStringViewType(const std::string& n) {
    return n == "std::string_view" || n == "std::__2::string_view" ||
           StartsWith(n, "std::basic_string_view<char") ||
           StartsWith(n, "std::__2::basic_string_view<char");
  }
  llvm::Optional<std::string> FormatStdStringView(uint32_t addr) {
    uint8_t rep[8] = {0};
    if (backend_.ReadMemory(addr, rep, sizeof(rep)) < sizeof(rep)) {
      return llvm::None;
    }
    auto u32 = [&](int i) {
      return uint32_t(rep[i]) | (uint32_t(rep[i + 1]) << 8) |
             (uint32_t(rep[i + 2]) << 16) | (uint32_t(rep[i + 3]) << 24);
    };
    return RenderQuotedString(u32(0), u32(4));
  }

  // std::map/set/multimap/multiset (libc++, stateless comparator + allocator):
  // the red-black tree stores its node count in the 3rd word (offset 8).
  static bool IsStdMapSet(const std::string& n) {
    return StartsWith(n, "std::map<") || StartsWith(n, "std::set<") ||
           StartsWith(n, "std::multimap<") || StartsWith(n, "std::multiset<") ||
           StartsWith(n, "std::__2::map<") || StartsWith(n, "std::__2::set<") ||
           StartsWith(n, "std::__2::multimap<") ||
           StartsWith(n, "std::__2::multiset<");
  }
  llvm::Optional<std::string> FormatStdMapSet(uint32_t addr) {
    uint8_t rep[12] = {0};
    if (backend_.ReadMemory(addr, rep, sizeof(rep)) < sizeof(rep)) {
      return llvm::None;
    }
    uint32_t size = uint32_t(rep[8]) | (uint32_t(rep[9]) << 8) |
                    (uint32_t(rep[10]) << 16) | (uint32_t(rep[11]) << 24);
    if (size > 100000000u) {
      return llvm::None;  // implausible -> not a stateless map/set layout
    }
    return std::string("size=") + std::to_string(size);
  }

  uint32_t ReadU32(uint32_t addr) {
    uint8_t b[4] = {0};
    backend_.ReadMemory(addr, b, 4);
    return uint32_t(b[0]) | (uint32_t(b[1]) << 8) | (uint32_t(b[2]) << 16) |
           (uint32_t(b[3]) << 24);
  }

  // In-order walk of a libc++ __tree (map/set), wasm32. Layout:
  //   tree: [ __begin_node_ @0 ][ end_node.__left_ (root) @4 ][ size @8 ]
  //   node: [ __left_ @0 ][ __right_ @4 ][ __parent_ @8 ][ __is_black_ @12 ]
  //         [ __value_ @16 ]
  // Collects the address of each element's __value_ (node + 16), in key order.
  void WalkTree(uint32_t tree_addr, uint32_t cap,
                std::vector<uint32_t>& value_addrs) {
    const uint32_t end_node = tree_addr + 4;
    uint32_t x = ReadU32(tree_addr);  // __begin_node_ (leftmost)
    uint32_t guard = 0;
    while (x && x != end_node && value_addrs.size() < cap && guard++ < 1000000) {
      value_addrs.push_back(x + 16);
      uint32_t r = ReadU32(x + 4);  // __right_
      if (r) {
        x = r;
        uint32_t l;
        while ((l = ReadU32(x)) != 0) {
          x = l;  // leftmost of right subtree
        }
      } else {
        uint32_t p = ReadU32(x + 8);  // __parent_
        while (p && x != ReadU32(p)) {  // while x is a right child
          x = p;
          p = ReadU32(x + 8);
        }
        x = p;
      }
    }
  }

  static std::string StripConst(std::string s) {
    while (s.rfind("const ", 0) == 0) {
      s.erase(0, std::string("const ").size());
    }
    while (!s.empty() && s.front() == ' ') {
      s.erase(s.begin());
    }
    while (!s.empty() && s.back() == ' ') {
      s.pop_back();
    }
    return s;
  }

  // Top-level template arguments of the outermost `<...>` in `name`, e.g.
  // "std::map<int, int, std::less<int>, A>" -> ["int","int","std::less<int>","A"].
  static std::vector<std::string> SplitTemplateArgs(const std::string& name) {
    std::vector<std::string> args;
    size_t lt = name.find('<');
    if (lt == std::string::npos) {
      return args;
    }
    int depth = 0;
    size_t start = lt + 1;
    for (size_t i = lt; i < name.size(); ++i) {
      char c = name[i];
      if (c == '<') {
        if (++depth == 1) {
          start = i + 1;
        }
      } else if (c == '>') {
        if (--depth == 0) {
          args.push_back(StripConst(name.substr(start, i - start)));
          break;
        }
      } else if (c == ',' && depth == 1) {
        args.push_back(StripConst(name.substr(start, i - start)));
        start = i + 1;
      }
    }
    return args;
  }

  // {size, alignment} in bytes for scalar / string types on wasm32; None for
  // types whose layout we don't model (so map/set entry rendering can bail out).
  llvm::Optional<std::pair<int, int>> TypeMetrics(const std::string& n0) {
    std::string n = StripConst(n0);
    if (!n.empty() && n.back() == '*') {
      return std::make_pair(4, 4);
    }
    if (IsStdStringType(n)) {
      return std::make_pair(12, 4);
    }
    if (IsStdStringViewType(n)) {
      return std::make_pair(8, 4);
    }
    if (n == "bool" || n == "char" || n == "signed char" ||
        n == "unsigned char") {
      return std::make_pair(1, 1);
    }
    if (n == "short" || n == "unsigned short" || n == "short int" ||
        n == "unsigned short int") {
      return std::make_pair(2, 2);
    }
    if (n == "int" || n == "unsigned int" || n == "unsigned" ||
        n == "long" || n == "unsigned long" || n == "long int" ||
        n == "unsigned long int" || n == "float") {
      return std::make_pair(4, 4);  // wasm32: long is 4 bytes
    }
    if (n == "long long" || n == "unsigned long long" ||
        n == "long long int" || n == "unsigned long long int" ||
        n == "double") {
      return std::make_pair(8, 8);
    }
    return llvm::None;
  }

  // Render a value of (scalar/string) type `name` at raw wasm address `addr`.
  std::string RenderRawByName(uint32_t addr, const std::string& name0) {
    std::string name = StripConst(name0);
    if (IsStdStringType(name)) {
      if (auto s = FormatStdString(addr)) {
        return *s;
      }
    }
    if (IsStdStringViewType(name)) {
      if (auto s = FormatStdStringView(addr)) {
        return *s;
      }
    }
    if (!name.empty() && name.back() == '*') {
      char buf[16];
      std::snprintf(buf, sizeof(buf), "0x%x", ReadU32(addr));
      return buf;
    }
    auto m = TypeMetrics(name);
    if (!m) {
      return name;  // unknown layout: show the type name
    }
    int size = m->first;
    uint8_t b[8] = {0};
    backend_.ReadMemory(addr, b, size);
    if (name == "bool") {
      return b[0] ? "true" : "false";
    }
    if (name == "float") {
      float f;
      std::memcpy(&f, b, 4);
      return std::to_string(f);
    }
    if (name == "double") {
      double d;
      std::memcpy(&d, b, 8);
      return std::to_string(d);
    }
    uint64_t raw = 0;
    for (int i = 0; i < size; ++i) {
      raw |= uint64_t(b[i]) << (8 * i);
    }
    if (name.find("unsigned") != std::string::npos) {
      return std::to_string(raw);
    }
    int64_t sv = static_cast<int64_t>(raw);
    if (size < 8 && (b[size - 1] & 0x80)) {  // sign-extend
      sv |= ~((int64_t(1) << (8 * size)) - 1);
    }
    return std::to_string(sv);
  }

  // Render one map/set element at its __value_ address. For a set this is the
  // element; for a map it is the pair laid out as [key @0][value @off], where
  // off = align(sizeof(key), alignof(value)).
  std::string RenderTreeEntry(uint32_t value_addr,
                              const std::vector<std::string>& args, bool is_map) {
    if (args.empty()) {
      return "?";
    }
    if (!is_map || args.size() < 2) {
      return RenderRawByName(value_addr, args[0]);
    }
    auto km = TypeMetrics(args[0]);
    auto vm = TypeMetrics(args[1]);
    std::string key = RenderRawByName(value_addr, args[0]);
    if (!km) {
      return key + " => ?";  // can't locate the value without the key's size
    }
    int align = vm ? vm->second : 4;
    int off = ((km->first + align - 1) / align) * align;
    return key + " => " + RenderRawByName(value_addr + off, args[1]);
  }


  static bool IsStdVectorType(const std::string& n) {
    return StartsWith(n, "std::vector<") || StartsWith(n, "std::__2::vector<");
  }

  // Element count of a libc++ std::vector (wasm32). Element size comes from the
  // type graph (__begin_'s pointee); count = (__end_ - __begin_) / elem_size.
  llvm::Optional<uint32_t> StdVectorCount(
      const symbols_backend::api::EvaluateExpressionResponse& resp,
      const symbols_backend::api::TypeInfo& root, uint32_t addr) {
    std::map<std::string, symbols_backend::api::TypeInfo> by_id;
    for (const auto& ti : resp.GetTypeInfos()) {
      by_id[ti.GetTypeId()] = ti;
    }
    uint32_t elem_size = 0;
    for (const auto& m : root.GetMembers()) {
      if (m.GetName() && *m.GetName() == "__begin_") {
        auto ptr = by_id.find(m.GetTypeId());
        if (ptr != by_id.end()) {
          for (const auto& pm : ptr->second.GetMembers()) {
            auto elem = by_id.find(pm.GetTypeId());
            if (elem != by_id.end()) {
              elem_size = static_cast<uint32_t>(elem->second.GetSize());
            }
          }
        }
      }
    }
    if (elem_size == 0) {
      return llvm::None;
    }
    uint8_t rep[8] = {0};
    if (backend_.ReadMemory(addr, rep, sizeof(rep)) < sizeof(rep)) {
      return llvm::None;
    }
    auto u32 = [&](int i) {
      return uint32_t(rep[i]) | (uint32_t(rep[i + 1]) << 8) |
             (uint32_t(rep[i + 2]) << 16) | (uint32_t(rep[i + 3]) << 24);
    };
    uint32_t begin = u32(0), end = u32(4);
    if (end < begin) {
      return llvm::None;
    }
    return (end - begin) / elem_size;
  }

  llvm::Optional<std::string> FormatStdVector(
      const symbols_backend::api::EvaluateExpressionResponse& resp,
      const symbols_backend::api::TypeInfo& root, uint32_t addr) {
    if (auto n = StdVectorCount(resp, root, addr)) {
      return std::string("size=") + std::to_string(*n);
    }
    return llvm::None;
  }

  static bool IsStdSmartPtr(const std::string& n) {
    return StartsWith(n, "std::unique_ptr<") ||
           StartsWith(n, "std::shared_ptr<") ||
           StartsWith(n, "std::__2::unique_ptr<") ||
           StartsWith(n, "std::__2::shared_ptr<");
  }

  // libc++ unique_ptr/shared_ptr, wasm32: the managed pointer (__ptr_) is the
  // first word. Report "nullptr" when empty; otherwise keep the default
  // (expandable) rendering.
  llvm::Optional<std::string> FormatSmartPtr(uint32_t addr) {
    uint8_t rep[4] = {0};
    if (backend_.ReadMemory(addr, rep, sizeof(rep)) < sizeof(rep)) {
      return llvm::None;
    }
    uint32_t ptr = uint32_t(rep[0]) | (uint32_t(rep[1]) << 8) |
                   (uint32_t(rep[2]) << 16) | (uint32_t(rep[3]) << 24);
    if (ptr == 0) {
      return std::string("nullptr");
    }
    return llvm::None;
  }

  json::Value BuildRemoteObject(
      const symbols_backend::api::EvaluateExpressionResponse& resp,
      const symbols_backend::api::RawLocation& ctx,
      llvm::StringRef expr) {
    symbols_backend::api::TypeInfo root = resp.GetRoot();
    auto names = root.GetTypeNames();
    std::string typeName = names.empty() ? "" : names.front();

    json::Object ro;
    bool canExpand = root.GetCanExpand();
    if (!typeName.empty()) {
      ro["className"] = typeName;
    }
    if (auto addr = resp.GetMemoryAddress()) {
      ro["linearMemoryAddress"] = *addr;
    }
    ro["linearMemorySize"] = root.GetSize();

    std::string desc;
    if (auto d = resp.GetDisplayValue()) {
      desc = *d;
    }
    // STL pretty-printers: show a meaningful summary in the description while
    // keeping the object expandable so the raw members are still reachable.
    if (auto addr = resp.GetMemoryAddress()) {
      if (IsStdStringType(typeName)) {
        if (auto s = FormatStdString(*addr)) {
          desc = *s;
        }
      } else if (IsStdStringViewType(typeName)) {
        if (auto s = FormatStdStringView(*addr)) {
          desc = *s;
        }
      } else if (IsStdVectorType(typeName)) {
        if (auto s = FormatStdVector(resp, root, *addr)) {
          desc = *s;
        }
      } else if (IsStdMapSet(typeName)) {
        if (auto s = FormatStdMapSet(*addr)) {
          desc = *s;
        }
      } else if (IsStdSmartPtr(typeName)) {
        if (auto s = FormatSmartPtr(*addr)) {
          desc = *s;
        }
      }
    }

    // Formatted string/string_view are non-expandable leaves. std::vector,
    // std::map/set and non-null smart pointers stay expandable and get
    // synthesized children in GetProperties; empty containers are leaves.
    bool leafSummary =
        IsStdStringType(typeName) || IsStdStringViewType(typeName);
    bool smartNull = IsStdSmartPtr(typeName) && desc == "nullptr";
    bool emptyContainer =
        (IsStdVectorType(typeName) || IsStdMapSet(typeName)) && desc == "size=0";
    if (leafSummary || smartNull || emptyContainer) {
      canExpand = false;
    }
    ro["hasChildren"] = canExpand;

    if (canExpand) {
      ro["type"] = "object";
      ro["description"] = desc.empty() ? typeName : desc;
      std::string oid = "obj:" + std::to_string(next_object_id_++);
      objects_[oid] = StoredObject{ctx.GetRawModuleId(), ctx.GetCodeOffset(),
                                   ctx.GetInlineFrameIndex(), expr.str(),
                                   stop_id_};
      ro["objectId"] = oid;
    } else if (leafSummary || smartNull || emptyContainer) {
      ro["type"] = "object";
      ro["description"] = desc.empty() ? typeName : desc;
    } else {
      int64_t iv = 0;
      bool haveInt = false;
      if (auto data = resp.GetData()) {
        for (size_t i = 0; i < data->size() && i < 8; ++i) {
          iv |= static_cast<int64_t>((*data)[i] & 0xFF) << (8 * i);
        }
        haveInt = true;
      }
      if (typeName == "bool") {
        ro["type"] = "boolean";
        ro["value"] = (iv != 0);
        if (desc.empty()) {
          desc = iv ? "true" : "false";
        }
      } else {
        ro["type"] = "number";
        if (!desc.empty()) {
          // Float/enum: prefer the display string; expose numeric best-effort.
          double d = 0;
          if (!llvm::StringRef(desc).getAsDouble(d)) {
            ro["value"] = d;
          }
        } else if (haveInt) {
          ro["value"] = iv;
          desc = std::to_string(iv);
        }
      }
      ro["description"] = desc;
    }
    return json::Value(std::move(ro));
  }

  DispatchResult GetProperties(const std::string& objectId) {
    json::Array props;
    auto it = objects_.find(objectId);
    if (it == objects_.end()) {
      return json::Value(std::move(props));
    }
    StoredObject so = it->second;
    stop_id_ = so.stopId;
    symbols_backend::api::RawLocation loc;
    loc.SetRawModuleId(so.rawModuleId)
        .SetCodeOffset(so.codeOffset)
        .SetInlineFrameIndex(so.inlineFrameIndex);

    auto resp = api_.EvaluateExpression(loc, so.expression, proxy_);
    if (resp.GetError()) {
      return json::Value(std::move(props));
    }
    symbols_backend::api::TypeInfo root = resp.GetRoot();
    auto rootNames = root.GetTypeNames();
    std::string rootType = rootNames.empty() ? std::string() : rootNames.front();

    auto addChild = [&](const std::string& name, const std::string& childExpr) {
      auto cresp = api_.EvaluateExpression(loc, childExpr, proxy_);
      if (cresp.GetError()) {
        return;
      }
      json::Object pd;
      pd["name"] = name;
      pd["value"] = BuildRemoteObject(cresp, loc, childExpr);
      props.push_back(std::move(pd));
    };

    if (root.GetIsPointer()) {
      // Cast to the (possibly dynamic) pointer type so the dereferenced value
      // and its members reflect the resolved dynamic type, not the static one
      // (RTTI resolution in InterpretExpression makes rootType e.g. "Derived *").
      std::string base = rootType.empty()
                             ? so.expression
                             : "(" + rootType + ")(" + so.expression + ")";
      addChild("*" + so.expression, "*(" + base + ")");
    } else if (IsStdVectorType(rootType)) {
      // Synthesize element children [0..N-1] instead of exposing __begin_/
      // __end_/__cap_. lldb-eval evaluates `(expr).__begin_[i]`.
      llvm::Optional<uint32_t> count;
      if (auto addr = resp.GetMemoryAddress()) {
        count = StdVectorCount(resp, root, *addr);
      }
      const uint32_t kCap = 200;
      uint32_t n = count.value_or(0);
      uint32_t shown = std::min(n, kCap);
      for (uint32_t i = 0; i < shown; ++i) {
        addChild("[" + std::to_string(i) + "]",
                 "(" + so.expression + ").__begin_[" + std::to_string(i) + "]");
      }
      if (n > shown) {
        json::Object pd;
        pd["name"] = "[...]";
        json::Object v;
        v["type"] = "object";
        v["description"] = std::to_string(n - shown) + " more elements";
        v["hasChildren"] = false;
        pd["value"] = json::Value(std::move(v));
        props.push_back(std::move(pd));
      }
    } else if (IsStdSmartPtr(rootType)) {
      // Non-null unique_ptr/shared_ptr: show the managed object (the pointee),
      // not __ptr_/__deleter_. lldb-eval evaluates `*(expr).__ptr_`.
      addChild("*" + so.expression, "*(" + so.expression + ").__ptr_");
    } else if (IsStdMapSet(rootType)) {
      // Traverse the red-black tree in raw memory and render each entry (set:
      // the value; map: "key => value"). lldb-eval can't cast to the element
      // (template) type, so entries are built directly from memory here.
      if (auto addr = resp.GetMemoryAddress()) {
        std::vector<std::string> args = SplitTemplateArgs(rootType);
        bool is_map = rootType.find("map<") != std::string::npos;
        const uint32_t kCap = 200;
        std::vector<uint32_t> value_addrs;
        WalkTree(*addr, kCap, value_addrs);
        for (size_t i = 0; i < value_addrs.size(); ++i) {
          json::Object pd;
          pd["name"] = "[" + std::to_string(i) + "]";
          json::Object v;
          v["type"] = "object";
          v["description"] = RenderTreeEntry(value_addrs[i], args, is_map);
          v["hasChildren"] = false;
          pd["value"] = json::Value(std::move(v));
          props.push_back(std::move(pd));
        }
        uint32_t total = ReadU32(*addr + 8);
        if (total > value_addrs.size()) {
          json::Object pd;
          pd["name"] = "[...]";
          json::Object v;
          v["type"] = "object";
          v["description"] =
              std::to_string(total - value_addrs.size()) + " more entries";
          v["hasChildren"] = false;
          pd["value"] = json::Value(std::move(v));
          props.push_back(std::move(pd));
        }
      }
    } else {
      for (const auto& m : root.GetMembers()) {
        if (auto name = m.GetName()) {
          addChild(*name, "(" + so.expression + ")." + *name);
        }
      }
    }
    return json::Value(std::move(props));
  }

  ApiContext& api_;
  RpcBackend backend_;
  emscripten::val proxy_;
  std::string exe_path_;
  std::deque<json::Value> deferred_;
  int next_state_id_ = 1;
  int next_object_id_ = 1;
  json::Value stop_id_{nullptr};
  std::map<std::string, StoredObject> objects_;
  std::map<std::string, std::string> module_temp_paths_;
};

// ---- RpcBackend methods (need Server to be complete) ------------------------

size_t RpcBackend::ReadMemory(size_t address, void* buffer, size_t size) {
  json::Array p;
  p.push_back(static_cast<int64_t>(address));
  p.push_back(static_cast<int64_t>(size));
  p.push_back(json::Value(server_.stop_id()));
  json::Value r = server_.StateCall("getWasmLinearMemory", std::move(p));
  std::vector<char> bytes;
  if (!DecodeArrayBuffer(r, bytes)) {
    return 0;
  }
  size_t n = std::min(size, bytes.size());
  std::memcpy(buffer, bytes.data(), n);
  return n;
}

size_t RpcBackend::WriteMemory(size_t address, const void* buffer, size_t size) {
  json::Array p;
  p.push_back(static_cast<int64_t>(address));
  p.push_back(MakeArrayBuffer(buffer, size));
  p.push_back(json::Value(server_.stop_id()));
  json::Value r = server_.StateCall("setWasmLinearMemory", std::move(p));
  if (auto* o = r.getAsObject()) {
    if (auto w = o->getInteger("written")) {
      return static_cast<size_t>(*w);
    }
  }
  if (auto n = r.getAsInteger()) {
    return static_cast<size_t>(*n);
  }
  return size;
}

emscripten::native::WasmValue RpcBackend::GetLocal(size_t i) {
  return GetVal("getWasmLocal", i);
}
emscripten::native::WasmValue RpcBackend::GetGlobal(size_t i) {
  return GetVal("getWasmGlobal", i);
}
emscripten::native::WasmValue RpcBackend::GetOperand(size_t i) {
  return GetVal("getWasmOp", i);
}

emscripten::native::WasmValue RpcBackend::GetVal(llvm::StringRef method,
                                                 size_t index) {
  json::Array p;
  p.push_back(static_cast<int64_t>(index));
  p.push_back(json::Value(server_.stop_id()));
  json::Value r = server_.StateCall(method, std::move(p));
  emscripten::native::WasmValue wv;
  auto* o = r.getAsObject();
  if (!o) {
    return wv;
  }
  if (auto t = o->getString("type")) {
    wv.type = t->str();
  }
  const json::Value* value = o->get("value");
  if (wv.type == "f32" || wv.type == "f64") {
    if (value) {
      if (auto d = value->getAsNumber()) {
        wv.d = *d;
      }
    }
  } else if (wv.type == "reftype") {
    if (auto idx = o->getInteger("index")) {
      wv.i = *idx;
    }
    if (auto c = o->getString("valueClass")) {
      wv.valueClass = c->str();
    }
  } else {
    // i32 / i64: value may be a number or a decimal string (i64 as bigint).
    if (value) {
      if (auto n = value->getAsInteger()) {
        wv.i = *n;
      } else if (auto s = value->getAsString()) {
        wv.i = std::strtoll(s->str().c_str(), nullptr, 10);
      } else if (auto d = value->getAsNumber()) {
        wv.i = static_cast<int64_t>(*d);
      }
    }
  }
  return wv;
}

}  // namespace

int RunServe(ApiContext& api, const char* exe_path) {
  Server server(api, exe_path ? exe_path : "");
  return server.Run();
}
