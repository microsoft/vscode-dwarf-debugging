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

  json::Value BuildRemoteObject(
      const symbols_backend::api::EvaluateExpressionResponse& resp,
      const symbols_backend::api::RawLocation& ctx,
      llvm::StringRef expr) {
    symbols_backend::api::TypeInfo root = resp.GetRoot();
    auto names = root.GetTypeNames();
    std::string typeName = names.empty() ? "" : names.front();

    json::Object ro;
    bool canExpand = root.GetCanExpand();
    ro["hasChildren"] = canExpand;
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

    if (canExpand) {
      ro["type"] = "object";
      ro["description"] = desc.empty() ? typeName : desc;
      std::string oid = "obj:" + std::to_string(next_object_id_++);
      objects_[oid] = StoredObject{ctx.GetRawModuleId(), ctx.GetCodeOffset(),
                                   ctx.GetInlineFrameIndex(), expr.str(),
                                   stop_id_};
      ro["objectId"] = oid;
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
      addChild("*" + so.expression, "*(" + so.expression + ")");
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
