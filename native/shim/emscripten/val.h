// Native shim for <emscripten/val.h>.
//
// In the browser extension, `DebuggerProxy` (ApiContext.cc) talks to the Wasm
// engine through a JS `emscripten::val` object with methods readMemory /
// getLocal / getGlobal / getOperand (backed by CDP getWasm* calls). For the
// native symbolizer we replace that JS object with a real C++ backend.
//
// This shim makes `emscripten::val` a small dynamic value that FORWARDS exactly
// those four calls to `emscripten::native::DebuggerBackend`. `lib/` compiles
// unchanged; only this shim changes its behaviour. Every other emscripten::val
// use in lib/ is just the type in a signature and stays inert (returns
// undefined/defaults).
#ifndef EXTENSIONS_CXX_DEBUGGING_NATIVE_SHIM_EMSCRIPTEN_VAL_H_
#define EXTENSIONS_CXX_DEBUGGING_NATIVE_SHIM_EMSCRIPTEN_VAL_H_

#include <cstddef>
#include <cstdint>
#include <cstring>
#include <map>
#include <memory>
#include <string>
#include <type_traits>
#include <utility>

namespace emscripten {

namespace native {

// A Wasm value as reported by the engine, mirroring the JS objects that
// readWasmValue() (ApiContext.cc) decodes: {type, value} or, for references,
// {type:"reftype", index, valueClass}.
struct WasmValue {
  std::string type;        // "i32" | "i64" | "f32" | "f64" | "reftype"
  int64_t i = 0;           // i32 / i64 payload, or reftype index
  double d = 0.0;          // f32 / f64 payload
  std::string valueClass;  // reftype only: "local" | "global" | "operand"

  static WasmValue I32(int32_t v) { return {"i32", v, 0.0, {}}; }
  static WasmValue I64(int64_t v) { return {"i64", v, 0.0, {}}; }
  static WasmValue F32(float v) { return {"f32", 0, static_cast<double>(v), {}}; }
  static WasmValue F64(double v) { return {"f64", 0, v, {}}; }
  static WasmValue Ref(uint32_t index, std::string cls) {
    return {"reftype", index, 0.0, std::move(cls)};
  }
};

// The native engine adapter. A mock implements it in tests; a real integration
// would forward to V8 / the DAP transport.
struct DebuggerBackend {
  virtual ~DebuggerBackend() = default;
  // Writes `size` bytes of guest linear memory at `address` into `buffer`.
  // Returns the number of bytes actually read.
  virtual size_t ReadMemory(size_t address, void* buffer, size_t size) = 0;
  // Writes `size` bytes of guest linear memory at `address` from `buffer`.
  // Returns the number of bytes written. Enables side-effecting expressions.
  virtual size_t WriteMemory(size_t address, const void* buffer,
                             size_t size) = 0;
  virtual WasmValue GetLocal(size_t index) = 0;
  virtual WasmValue GetGlobal(size_t index) = 0;
  virtual WasmValue GetOperand(size_t index) = 0;
};

}  // namespace native

class val {
 public:
  val() = default;
  val(const val&) = default;
  val(val&&) = default;
  val& operator=(const val&) = default;
  val& operator=(val&&) = default;
  ~val() = default;

  // Wrap a native backend as the JS "debug proxy" object.
  explicit val(native::DebuggerBackend* backend)
      : node_(std::make_shared<Node>()) {
    node_->kind = Node::Kind::Backend;
    node_->backend = backend;
  }

  // Catch-all for any other construction lib/ might do; produces `undefined`.
  // Constrained so it never hijacks copy/move or the backend constructor
  // (is_convertible excludes derived backend pointers like MockBackend*, which
  // would otherwise win overload resolution as an exact template match).
  template <typename T,
            typename = std::enable_if_t<
                !std::is_same_v<std::decay_t<T>, val> &&
                !std::is_convertible_v<std::decay_t<T>,
                                       native::DebuggerBackend*>>>
  explicit val(T&&) {}

  val operator[](const char* key) const {
    if (node_ && node_->kind == Node::Kind::Object) {
      auto it = node_->fields.find(key);
      if (it != node_->fields.end()) {
        return WrapNode(it->second);
      }
    }
    return val();
  }
  val operator[](const std::string& key) const { return (*this)[key.c_str()]; }
  val operator[](int) const { return val(); }
  val operator[](std::size_t) const { return val(); }

  template <typename T>
  T as() const {
    if (!node_) {
      return T();
    }
    if constexpr (std::is_same_v<T, std::string>) {
      return node_->s;
    } else if constexpr (std::is_floating_point_v<T>) {
      return static_cast<T>(node_->d);
    } else if constexpr (std::is_integral_v<T>) {
      return static_cast<T>(node_->i);
    } else {
      return T();
    }
  }

  // Forwards the four proxy methods to the native backend. Any other method
  // returns a default-constructed T.
  template <typename T, typename... Args>
  T call(const char* name, Args&&... args) const {
    const int64_t a[] = {static_cast<int64_t>(args)..., 0};
    constexpr std::size_t argc = sizeof...(Args);
    native::DebuggerBackend* backend = node_ ? node_->backend : nullptr;
    if constexpr (std::is_same_v<T, val>) {
      native::WasmValue wv;
      if (backend && argc >= 1) {
        const std::size_t index = static_cast<std::size_t>(a[0]);
        if (std::strcmp(name, "getLocal") == 0) {
          wv = backend->GetLocal(index);
        } else if (std::strcmp(name, "getGlobal") == 0) {
          wv = backend->GetGlobal(index);
        } else if (std::strcmp(name, "getOperand") == 0) {
          wv = backend->GetOperand(index);
        }
      }
      return FromWasmValue(wv);
    } else {
      if (backend && argc >= 3 && std::strcmp(name, "readMemory") == 0) {
        const std::size_t address = static_cast<std::size_t>(a[0]);
        void* buffer =
            reinterpret_cast<void*>(static_cast<std::uintptr_t>(a[1]));
        const std::size_t size = static_cast<std::size_t>(a[2]);
        return static_cast<T>(backend->ReadMemory(address, buffer, size));
      }
      if (backend && argc >= 3 && std::strcmp(name, "writeMemory") == 0) {
        const std::size_t address = static_cast<std::size_t>(a[0]);
        const void* buffer =
            reinterpret_cast<const void*>(static_cast<std::uintptr_t>(a[1]));
        const std::size_t size = static_cast<std::size_t>(a[2]);
        return static_cast<T>(backend->WriteMemory(address, buffer, size));
      }
      return T();
    }
  }

  template <typename... Args>
  val operator()(Args&&...) const {
    return val();
  }

  static val undefined() { return val(); }
  static val null() { return val(); }
  static val global(const char* = nullptr) { return val(); }
  static val object() { return val(); }
  static val array() { return val(); }

  bool operator==(const val&) const { return false; }
  bool operator!=(const val&) const { return true; }
  bool isUndefined() const {
    return !node_ || node_->kind == Node::Kind::Undefined;
  }
  bool isNull() const { return !node_; }

 private:
  struct Node {
    enum class Kind { Undefined, Backend, Object, Int, Double, String };
    Kind kind = Kind::Undefined;
    native::DebuggerBackend* backend = nullptr;
    // shared_ptr indirection keeps the map value type complete (avoids relying
    // on incomplete-type container support for map<string, val>).
    std::map<std::string, std::shared_ptr<Node>> fields;
    int64_t i = 0;
    double d = 0.0;
    std::string s;
  };

  explicit val(std::shared_ptr<Node> node) : node_(std::move(node)) {}
  static val WrapNode(std::shared_ptr<Node> node) {
    return val(std::move(node));
  }

  static std::shared_ptr<Node> IntNode(int64_t v) {
    auto n = std::make_shared<Node>();
    n->kind = Node::Kind::Int;
    n->i = v;
    return n;
  }
  static std::shared_ptr<Node> DoubleNode(double v) {
    auto n = std::make_shared<Node>();
    n->kind = Node::Kind::Double;
    n->d = v;
    return n;
  }
  static std::shared_ptr<Node> StringNode(std::string v) {
    auto n = std::make_shared<Node>();
    n->kind = Node::Kind::String;
    n->s = std::move(v);
    return n;
  }
  static val FromWasmValue(const native::WasmValue& wv) {
    auto n = std::make_shared<Node>();
    n->kind = Node::Kind::Object;
    n->fields.emplace("type", StringNode(wv.type));
    if (wv.type == "reftype") {
      n->fields.emplace("index", IntNode(wv.i));
      n->fields.emplace("valueClass", StringNode(wv.valueClass));
    } else if (wv.type == "f32" || wv.type == "f64") {
      n->fields.emplace("value", DoubleNode(wv.d));
    } else {
      n->fields.emplace("value", IntNode(wv.i));
    }
    return WrapNode(std::move(n));
  }

  std::shared_ptr<Node> node_;
};

}  // namespace emscripten

#endif  // EXTENSIONS_CXX_DEBUGGING_NATIVE_SHIM_EMSCRIPTEN_VAL_H_
