// Copyright 2023 The Chromium Authors. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the wasm/symbols-backend/LICENSE file.

#ifndef EXTENSIONS_CXX_DEBUGGING_WASMVENDORPLUGINS_H_
#define EXTENSIONS_CXX_DEBUGGING_WASMVENDORPLUGINS_H_

#include "ApiContext.h"
#include "Plugins/SymbolFile/DWARF/DWARFASTParserClang.h"
#include "Plugins/SymbolFile/DWARF/DWARFDeclContext.h"
#include "Plugins/SymbolFile/DWARF/SymbolFileDWARF.h"
#include "Plugins/TypeSystem/Clang/TypeSystemClang.h"
#include "Plugins/ExpressionParser/Clang/ClangExternalASTSourceCallbacks.h"
#include "lldb/Core/Debugger.h"
#include "lldb/Symbol/TypeSystem.h"
#include "lldb/Target/RegisterContext.h"
#include "lldb/Target/Unwind.h"
#include "lldb/lldb-forward.h"
#include "lldb/lldb-types.h"
#include "llvm/ADT/Optional.h"
#include "llvm/BinaryFormat/Dwarf.h"

class SymbolVendorWASM;
class SymbolFileDWARF;

namespace lldb_private {
class FileSystem;
class CPlusPlusLanguage;
class ClangASTContext;
namespace wasm {
class ObjectFileWasm;
class SymbolVendorWasm;
}  // namespace wasm
}  // namespace lldb_private

namespace symbols_backend {

template <typename T>
static void initialize() {  // NOLINT
  T::Initialize();
}
template <typename T>
static void terminate() {  // NOLINT
  T::Terminate();
}
template <typename T, typename FirstT, typename... MoreT>
static void initialize() {  // NOLINT
  T::Initialize();
  initialize<FirstT, MoreT...>();
}
template <typename T, typename FirstT, typename... MoreT>
static void terminate() {  // NOLINT
  terminate<FirstT, MoreT...>();
  T::Terminate();
}

template <typename... SystemT>
struct PluginRegistryContext {
  PluginRegistryContext() { initialize<SystemT...>(); }
  ~PluginRegistryContext() { terminate<SystemT...>(); }
};

class WasmPlatform : public lldb_private::Platform {
 public:
  using lldb_private::Platform::Platform;

  static void Initialize();

  static void Terminate();

  class Resolver : public lldb_private::UserIDResolver {
    llvm::Optional<std::string> DoGetUserName(id_t uid) final { return {}; }
    llvm::Optional<std::string> DoGetGroupName(id_t gid) final { return {}; }
  };
  Resolver resolver_;

  llvm::StringRef GetPluginName() final { return "wasm32"; }

  llvm::StringRef GetDescription() final { return "wasm32"; }

  lldb_private::UserIDResolver& GetUserIDResolver() final { return resolver_; }

  std::vector<lldb_private::ArchSpec> GetSupportedArchitectures(
      const lldb_private::ArchSpec& process_host_arch) final {
    return {{lldb_private::ArchSpec("wasm32-unknown-unknown")}};
  }

  void CalculateTrapHandlerSymbolNames() final {}

  lldb::ProcessSP Attach(lldb_private::ProcessAttachInfo& attach_info,
                         lldb_private::Debugger& debugger,
                         lldb_private::Target* target,
                         lldb_private::Status& error) final {
    error.SetErrorString("Cannot attach to processes");
    return {};
  }
};

class WasmRegisters : public lldb_private::RegisterContext {
  using lldb_private::RegisterContext::RegisterContext;
  lldb_private::RegisterInfo fake_pc_register_ = {"PC",
                                                  nullptr,
                                                  4,
                                                  0,
                                                  lldb::Encoding::eEncodingUint,
                                                  lldb::Format::eFormatDefault,
                                                  {0},
                                                  nullptr,
                                                  nullptr};
  size_t frame_offset_;

 public:
  WasmRegisters(lldb_private::Thread& thread, size_t frame_offset);

  void InvalidateAllRegisters() override{};

  size_t GetRegisterCount() override { return 1; }

  const lldb_private::RegisterInfo* GetRegisterInfoAtIndex(size_t reg) override;

  size_t GetRegisterSetCount() override { return 0; }

  const lldb_private::RegisterSet* GetRegisterSet(size_t reg_set) override {
    return nullptr;
  }

  lldb::ByteOrder GetByteOrder() override { return lldb::eByteOrderLittle; }

  bool ReadRegister(const lldb_private::RegisterInfo* reg_info,
                    lldb_private::RegisterValue& reg_value) override;

  bool WriteRegister(const lldb_private::RegisterInfo* reg_info,
                     const lldb_private::RegisterValue& reg_value) override {
    return false;
  }

  friend class WasmThread;
};

class WasmUnwind : public lldb_private::Unwind {
  size_t frame_offset_;

 public:
  explicit WasmUnwind(lldb_private::Thread& thread, size_t frame_offset)
      : Unwind(thread), frame_offset_(frame_offset) {}
  void DoClear() final{};
  uint32_t DoGetFrameCount() final { return 1; }

  bool DoGetFrameInfoAtIndex(uint32_t frame_idx,
                             lldb::addr_t& cfa,
                             lldb::addr_t& pc,
                             bool& behaves_like_zeroth_frame) final;

  lldb::RegisterContextSP DoCreateRegisterContextForFrame(
      lldb_private::StackFrame* frame) final {
    return GetRegisterContext();
  }
  lldb::RegisterContextSP GetRegisterContext() {
    return lldb::RegisterContextSP{
        new WasmRegisters(GetThread(), frame_offset_)};
  }
};

class WasmThread : public lldb_private::Thread {
  friend class WasmUnwind;
  lldb::StackFrameSP stack_frame_;
  WasmUnwind unwind_;

 public:
  WasmThread(lldb_private::Process& process, size_t frame_offset)
      : Thread(process, 0), unwind_(*this, frame_offset) {}

  void RefreshStateAfterStop() override {}
  bool CalculateStopInfo() override { return false; }

  WasmUnwind& GetUnwinder() final { return unwind_; }

  lldb::RegisterContextSP CreateRegisterContextForFrame(
      lldb_private::StackFrame* frame) override;

  lldb::RegisterContextSP GetRegisterContext() override;

  lldb::StackFrameSP GetFrame();
};

class WasmProcess : public lldb_private::Process {
  using lldb_private::Process::Process;
  const api::DebuggerProxy* proxy_ = nullptr;
  size_t frame_offset_ = 0;

 public:
  static void Initialize();

  static void Terminate();

  static lldb::ProcessSP CreateInstance(
      lldb::TargetSP target_sp,
      lldb::ListenerSP listener_sp,
      const lldb_private::FileSpec* crash_file_path,
      bool can_connect);

  static llvm::StringRef GetPluginDescriptionStatic() {
    return "wasm32 proces";
  }

  static llvm::StringRef GetPluginNameStatic() { return "wasm32"; }

  void SetProxyAndFrameOffset(const api::DebuggerProxy& proxy,
                              size_t frame_offset);
  bool CanDebug(lldb::TargetSP target, bool plugin_specified_by_name) override;
  lldb_private::Status DoDestroy() override { return {}; }
  void RefreshStateAfterStop() override {}
  bool DoUpdateThreadList(lldb_private::ThreadList& old_thread_list,
                          lldb_private::ThreadList& new_thread_list) override;

  size_t DoReadMemory(lldb::addr_t vm_addr,
                      void* buf,
                      size_t size,
                      lldb_private::Status& error) override;

  llvm::StringRef GetPluginName() override { return GetPluginNameStatic(); }
};

class SymbolFileWasmDWARF : public ::SymbolFileDWARF {
  static char ID;

 public:
  using SymbolFileDWARF::SymbolFileDWARF;

  bool isA(const void* ClassID) const override {
    return ClassID == &ID || SymbolFileDWARF::isA(ClassID);
  }
  static bool classof(const SymbolFile* obj) { return obj->isA(&ID); }

  static void Initialize();

  static void Terminate();

  static llvm::StringRef GetPluginNameStatic() { return "wasm_dwarf"; }
  llvm::StringRef GetPluginName() final { return GetPluginNameStatic(); }

  static llvm::StringRef GetPluginDescriptionStatic();

  static lldb_private::SymbolFile* CreateInstance(
      lldb::ObjectFileSP objfile_sp);

  struct WasmValueLoader {
    SymbolFileWasmDWARF& symbol_file;
    explicit WasmValueLoader(SymbolFileWasmDWARF& symbol_file)
        : symbol_file(symbol_file) {
      assert(!symbol_file.current_value_loader_ &&
             "Cannot nest wasm eval contexts");
      symbol_file.current_value_loader_ = this;
    }
    ~WasmValueLoader() { symbol_file.current_value_loader_ = nullptr; }

    virtual llvm::Expected<api::DebuggerProxy::WasmValue> LoadWASMValue(
        uint8_t storage_type,
        const lldb_private::DataExtractor& data,
        lldb::offset_t& offset) = 0;
  };

  lldb::offset_t GetVendorDWARFOpcodeSize(
      const lldb_private::DataExtractor& data,
      const lldb::offset_t data_offset,
      const uint8_t op) const final {
    return LLDB_INVALID_OFFSET;
  }

  bool ParseVendorDWARFOpcode(
      uint8_t op,
      const lldb_private::DataExtractor& opcodes,
      lldb::offset_t& offset,
      std::vector<lldb_private::Value>& stack) const final {
    if (!current_value_loader_) {
      return false;
    }
    switch (op) {
      case llvm::dwarf::DW_OP_WASM_location_int:
      case llvm::dwarf::DW_OP_WASM_location: {
        uint8_t storage_type = opcodes.GetU8(&offset);
        auto value =
            current_value_loader_->LoadWASMValue(storage_type, opcodes, offset);
        if (!value) {
          llvm::errs() << llvm::toString(value.takeError());
          return false;
        }
        auto stack_value = std::visit(
            [](auto v) { return lldb_private::Scalar(v); }, value->value);
        stack.push_back(stack_value);
        stack.back().SetValueType(lldb_private::Value::ValueType::Scalar);
        return true;
      }
    }

    return false;
  }

  std::shared_ptr<lldb_private::Type> externref_type_sp;

  lldb::TypeSP FindDefinitionTypeForDWARFDeclContext(
      const DWARFDeclContext& dwarf_decl_ctx) override {
    // We define type externref_t as a 32-bit integer, so as to be
    // able to transfer some information through the interpreter
    const uint32_t dwarf_decl_ctx_count = dwarf_decl_ctx.GetSize();
    if (dwarf_decl_ctx_count > 0) {
      const lldb_private::ConstString type_name(dwarf_decl_ctx[0].name);
      if (type_name == "externref_t") {
        if (!externref_type_sp) {
          const lldb::LanguageType language = dwarf_decl_ctx.GetLanguage();
          auto type_system = GetTypeSystemForLanguage(language);
          bool ok = !type_system.takeError();
          assert(ok);
          auto ast = clang::dyn_cast<lldb_private::TypeSystemClang>(
              type_system->get());
          lldb_private::CompilerType clang_type =
              ast->GetBasicType(lldb::eBasicTypeUnsignedLongLong);
          externref_type_sp = std::make_shared<lldb_private::Type>(
              lldb::user_id_t(0), this, type_name, 4, nullptr, LLDB_INVALID_UID,
              lldb_private::Type::eEncodingIsUID, lldb_private::Declaration(),
              clang_type, lldb_private::Type::ResolveState::Forward);
        }
        return externref_type_sp;
      }
    }
    return SymbolFileDWARF::FindDefinitionTypeForDWARFDeclContext(
        dwarf_decl_ctx);
  }

 private:
  WasmValueLoader* current_value_loader_ = nullptr;
};

namespace types {

struct MemberInfo {
  std::string name;
  uint32_t location;
  lldb_private::CompilerType type;
};

struct VariantInfo {
  llvm::Optional<uint64_t> discr_value;
  llvm::SmallVector<MemberInfo, 1> members;
};

struct VariantPartInfo {
  MemberInfo discr_member;
  llvm::SmallVector<VariantInfo, 1> variants;
};

struct TemplateParameterInfo {
  lldb_private::CompilerType type;
  llvm::Optional<std::string> name;
};

struct ExtendedTypeInfo {
  lldb::LanguageType language;
  llvm::SmallVector<VariantPartInfo, 1> variant_parts;
  llvm::SmallVector<TemplateParameterInfo, 1> template_parameters;
  llvm::Optional<uint32_t> byte_size;
};

} // namespace types

class DWARFASTParserClangExtended : public DWARFASTParserClang {
public:
  DWARFASTParserClangExtended(lldb_private::TypeSystemClang &ast)
      : DWARFASTParserClang(ast) {}

  bool
  CompleteTypeFromDWARF(const DWARFDIE &die, lldb_private::Type *type,
                        lldb_private::CompilerType &compiler_type) override;
};

class TypeSystemClangExtended : public lldb_private::TypeSystemClang {
  // LLVM RTTI support
  static char ID;

public:
  // LLVM RTTI support
  bool isA(const void *ClassID) const override {
    return ClassID == &ID || lldb_private::TypeSystemClang::isA(ClassID);
  }
  static bool classof(const TypeSystem *ts) { return ts->isA(&ID); }

  explicit TypeSystemClangExtended(llvm::StringRef name, llvm::Triple triple);

  DWARFASTParser *GetDWARFParser() override;

  static void Initialize();
  static void Terminate();

  static lldb::TypeSystemSP CreateInstance(lldb::LanguageType language,
                                           lldb_private::Module *module,
                                           lldb_private::Target *target);

  llvm::Optional<uint64_t>
  GetBitSize(lldb::opaque_compiler_type_t type,
             lldb_private::ExecutionContextScope *exe_scope) override;

  static types::ExtendedTypeInfo *
  GetExtendedTypeInfo(lldb_private::CompilerType type,
                      bool create_if_needed = false);
  types::ExtendedTypeInfo *
  GetExtendedTypeInfo(lldb::opaque_compiler_type_t type,
                      bool create_if_needed = false);

private:
  llvm::Optional<lldb::LanguageType> m_language;
  std::unique_ptr<DWARFASTParserClangExtended> m_dwarf_ast_parser_up;
  std::map<lldb::opaque_compiler_type_t, types::ExtendedTypeInfo> m_type_info;
};

// We need to extend ClangExternalASTSourceCallbacks to make sure that the methods in the
// base TypeSystemClang class access the instance of ClangASTImporter held by our own
// DWARFASTParserClangExtended instead of the instance of DWARFASTParserClang declared as
// as private field on TypeSystemClang.
// TypeSystemClang::LayoutRecordType does not honour the fact that we override GetDWARFParser()
// and still uses it's private field m_dwarf_ast_parser_up which causes the parsed types
// to not include the correct size and field layout information.
class ClangExternalASTSourceCallbacks
    : public lldb_private::ClangExternalASTSourceCallbacks {
  /// LLVM RTTI support.
  static char ID;

public:
  /// LLVM RTTI support.
  bool isA(const void *ClassID) const override {
    return ClassID == &ID ||
           lldb_private::ClangExternalASTSourceCallbacks::isA(ClassID);
  }
  static bool classof(const clang::ExternalASTSource *s) { return s->isA(&ID); }

  explicit ClangExternalASTSourceCallbacks(TypeSystemClangExtended &ast)
      : lldb_private::ClangExternalASTSourceCallbacks(ast),
        m_ast_parser(
            static_cast<DWARFASTParserClangExtended *>(ast.GetDWARFParser())) {}

  bool layoutRecordType(
      const clang::RecordDecl *Record, uint64_t &Size, uint64_t &Alignment,
      llvm::DenseMap<const clang::FieldDecl *, uint64_t> &FieldOffsets,
      llvm::DenseMap<const clang::CXXRecordDecl *, clang::CharUnits>
          &BaseOffsets,
      llvm::DenseMap<const clang::CXXRecordDecl *, clang::CharUnits>
          &VirtualBaseOffsets) override {
    return m_ast_parser->GetClangASTImporter().LayoutRecordType(
        Record, Size, Alignment, FieldOffsets, BaseOffsets, VirtualBaseOffsets);
  }

private:
  DWARFASTParserClangExtended *m_ast_parser;
};

}  // namespace symbols_backend

#endif  // EXTENSIONS_CXX_DEBUGGING_WASMVENDORPLUGINS_H_
