// Copyright 2023 The Chromium Authors. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the wasm/symbols-backend/LICENSE file.

#include "WasmVendorPlugins.h"

#include "Plugins/ExpressionParser/Clang/ClangPersistentVariables.h"
#include "Plugins/SymbolFile/DWARF/DWARFASTParserClang.h"
#include "Plugins/SymbolFile/DWARF/DWARFAttribute.h"
#include "Plugins/SymbolFile/DWARF/DWARFDIE.h"
#include "Plugins/SymbolFile/DWARF/DWARFUnit.h"
#include "Plugins/SymbolFile/DWARF/LogChannelDWARF.h"
#include "lldb/Core/PluginManager.h"
#include "lldb/Core/dwarf.h"
#include "lldb/Host/linux/HostInfoLinux.h"
#include "lldb/Symbol/Type.h"
#include "lldb/Target/Platform.h"
#include "lldb/Utility/RegisterValue.h"
#include "lldb/lldb-enumerations.h"
#include "lldb/lldb-forward.h"
#include "lldb/lldb-types.h"
#include "clang/AST/DeclBase.h"
#include "llvm/ADT/None.h"
#include "llvm/ADT/Optional.h"
#include "llvm/BinaryFormat/Dwarf.h"
#include "llvm/DebugInfo/DWARF/DWARFFormValue.h"
#include "llvm/Support/Error.h"
#include "llvm/Support/Format.h"
#include "llvm/Support/raw_ostream.h"
#include <cstddef>
#include <cstdint>
#include <string>

namespace symbols_backend {

void WasmPlatform::Initialize() {
  lldb_private::Platform::SetHostPlatform(
      std::make_shared<WasmPlatform>(/*is_host_platform*/ true));
}
void WasmPlatform::Terminate() {}

WasmRegisters::WasmRegisters(lldb_private::Thread& thread, size_t frame_offset)
    : RegisterContext(thread, 0), frame_offset_(frame_offset) {
  fake_pc_register_.kinds[lldb::eRegisterKindGeneric] = LLDB_REGNUM_GENERIC_PC;
}

const lldb_private::RegisterInfo* WasmRegisters::GetRegisterInfoAtIndex(
    size_t reg) {
  if (reg == 0) {
    return &fake_pc_register_;
  }
  return nullptr;
}

bool WasmRegisters::ReadRegister(const lldb_private::RegisterInfo* reg_info,
                                 lldb_private::RegisterValue& reg_value) {
  if (reg_info == &fake_pc_register_) {
    reg_value = static_cast<uint32_t>(frame_offset_);
    return true;
  }
  return false;
}

bool WasmUnwind::DoGetFrameInfoAtIndex(uint32_t frame_idx,
                                       lldb::addr_t& cfa,
                                       lldb::addr_t& pc,
                                       bool& behaves_like_zeroth_frame) {
  if (frame_idx != 0) {
    return false;
  }
  pc = frame_offset_;
  cfa = LLDB_INVALID_ADDRESS;
  behaves_like_zeroth_frame = true;
  return true;
}

lldb::RegisterContextSP WasmThread::CreateRegisterContextForFrame(
    lldb_private::StackFrame* frame) {
  return unwind_.DoCreateRegisterContextForFrame(frame);
}

lldb::RegisterContextSP WasmThread::GetRegisterContext() {
  return unwind_.GetRegisterContext();
}

lldb::StackFrameSP WasmThread::GetFrame() {
  if (!stack_frame_) {
    stack_frame_ = this->GetStackFrameList()->GetFrameAtIndex(0);
    this->SetSelectedFrame(stack_frame_.get());
  }
  return stack_frame_;
}

void WasmProcess::SetProxyAndFrameOffset(const api::DebuggerProxy& proxy,
                                         size_t frame_offset) {
  proxy_ = &proxy;
  frame_offset_ = frame_offset;
  this->SetPrivateState(lldb::StateType::eStateStopped);
}
bool WasmProcess::CanDebug(lldb::TargetSP target,
                           bool plugin_specified_by_name) {
  return target->GetArchitecture().GetTriple().getArchName() == "wasm32";
}
bool WasmProcess::DoUpdateThreadList(
    lldb_private::ThreadList& old_thread_list,
    lldb_private::ThreadList& new_thread_list) {
  if (frame_offset_ > 0) {
    new_thread_list.AddThread(
        lldb::ThreadSP(new WasmThread(*this, frame_offset_)));
    return true;
  }
  return false;
}

size_t WasmProcess::DoReadMemory(lldb::addr_t vm_addr,
                                 void* buf,
                                 size_t size,
                                 lldb_private::Status& error) {
  if (!proxy_) {
    error.SetErrorString("Proxy not initialized");
    return 0;
  }
  auto result = proxy_->ReadMemory(vm_addr, buf, size);
  if (!result) {
    error.SetErrorString(llvm::toString(result.takeError()));
    return 0;
  }
  return *result;
}

void WasmProcess::Initialize() {
  lldb_private::PluginManager::RegisterPlugin(
      GetPluginNameStatic(), GetPluginDescriptionStatic(), CreateInstance);
}

lldb::ProcessSP WasmProcess::CreateInstance(
    lldb::TargetSP target_sp,
    lldb::ListenerSP listener_sp,
    const lldb_private::FileSpec* crash_file_path,
    bool can_connect) {
  return lldb::ProcessSP(new WasmProcess(target_sp, listener_sp));
}

void WasmProcess::Terminate() {
  lldb_private::PluginManager::UnregisterPlugin(CreateInstance);
}

char SymbolFileWasmDWARF::ID;

void SymbolFileWasmDWARF::Initialize() {
  lldb_private::LogChannelDWARF::Initialize();
  lldb_private::PluginManager::RegisterPlugin(
      GetPluginNameStatic(), GetPluginDescriptionStatic(), CreateInstance,
      SymbolFileDWARF::DebuggerInitialize);
}

void SymbolFileWasmDWARF::Terminate() {
  lldb_private::PluginManager::UnregisterPlugin(CreateInstance);
  lldb_private::LogChannelDWARF::Terminate();
}

llvm::StringRef SymbolFileWasmDWARF::GetPluginDescriptionStatic() {
  return "Wasm DWARF";
}

lldb_private::SymbolFile* SymbolFileWasmDWARF::CreateInstance(
    lldb::ObjectFileSP objfile_sp) {
  return new SymbolFileWasmDWARF(std::move(objfile_sp),
                                 /*dwo_section_list*/ nullptr);
}

using namespace llvm::dwarf;

namespace {

void ForEachDWARFDIEChild(DWARFDIE die, dw_tag_t tag,
                          std::function<void(const DWARFDIE &)> callback) {
  die = die.GetFirstChild();
  while (die) {
    if (die.Tag() == tag) {
      callback(die);
    }
    die = die.GetSibling();
  }
}

llvm::Optional<uint32_t> GetRecordByteSize(const DWARFDIE &die) {
  switch (die.Tag()) {
  case DW_TAG_variant_part:
  case DW_TAG_structure_type:
  case DW_TAG_union_type:
  case DW_TAG_class_type:
    break;
  default:
    return llvm::None;
  }
  auto byte_size = die.GetAttributeValueAsOptionalUnsigned(DW_AT_byte_size);
  if (!byte_size) {
    byte_size = die.GetAttributeValueAsOptionalUnsigned(DW_AT_bit_size)
                    .transform([](auto value) { return (value + 7) / 8; });
  }

  if (!byte_size || byte_size.value() > UINT32_MAX) {
    return llvm::None;
  }

  return (uint32_t)byte_size.value();
}

bool ExtractTypeFromDWARFDIE(const DWARFDIE &die,
                             lldb_private::Type **type_value) {
  auto type_die = die.GetAttributeValueAsReferenceDIE(DW_AT_type);
  if (!type_die) {
    llvm::errs() << "ExtractTypeFromDWARFDIE: DW_AT_type reference is "
                    "missing or not "
                    "valid for "
                 << llvm::format_hex(die.GetOffset(), 10)
                 << ", ignoring entry.\n";
    return false;
  }

  auto type = type_die.ResolveType();
  if (!type) {
    llvm::errs()
        << "ExtractTypeFromDWARFDIE: DW_AT_type reference could not be "
           "resolved to a type for "
        << llvm::format_hex(die.GetOffset(), 10) << ", ignoring entry.\n";
    return false;
  }

  *type_value = type;
  return true;
}

bool ExtractMemberInfo(const DWARFDIE &die, types::MemberInfo &info) {

  auto location =
      die.GetAttributeValueAsOptionalUnsigned(DW_AT_data_member_location);
  if (!location) {
    llvm::errs()
        << "ExtractMemberInfo: DW_AT_data_member_location is missing for "
        << llvm::format_hex(die.GetOffset(), 10) << ", ignoring entry.\n";
    return false;
  }
  if (location.value() > UINT32_MAX) {
    llvm::errs()
        << "ExtractMemberInfo: DW_AT_data_member_location > UINT32_MAX for "
        << llvm::format_hex(die.GetOffset(), 10) << ", ignoring entry.\n";
    return false;
  }

  lldb_private::Type *type;
  if (!ExtractTypeFromDWARFDIE(die, &type)) {
    return false;
  }
  info.name = die.GetAttributeValueAsString(DW_AT_name, "");
  info.location = (uint32_t)location.value();
  info.type = type->GetForwardCompilerType();
  return true;
}

bool ExtractVariantInfo(const DWARFDIE &die, types::VariantInfo &info) {

  info.discr_value = die.GetAttributeValueAsOptionalUnsigned(DW_AT_discr_value);

  ForEachDWARFDIEChild(die, DW_TAG_member, [&info](auto member_die) {
    types::MemberInfo member;
    if (ExtractMemberInfo(member_die, member)) {
      info.members.push_back(member);
    }
  });

  if (info.members.empty()) {
    llvm::errs() << "ExtractVariantInfo: Missing or only non valid "
                    "DW_TAG_member children for "
                 << llvm::format_hex(die.GetOffset(), 10)
                 << ", ignoring entry.\n";
    return false;
  }

  return true;
}

bool ExtractVariantPartInfo(const DWARFDIE &die, types::VariantPartInfo &info) {

  auto discr_member_die = die.GetAttributeValueAsReferenceDIE(DW_AT_discr);

  if (!discr_member_die) {
    llvm::errs()
        << "ExtractVariantPartInfo: DW_AT_discr is missing or not valid for "
        << llvm::format_hex(die.GetOffset(), 10) << ", ignoring entry.\n";
    return false;
  }

  if (!ExtractMemberInfo(discr_member_die, info.discr_member)) {
    return false;
  }

  ForEachDWARFDIEChild(die, DW_TAG_variant, [&info](auto variant_die) {
    types::VariantInfo variant;
    if (ExtractVariantInfo(variant_die, variant)) {
      info.variants.push_back(variant);
    }
  });

  if (info.variants.empty()) {
    llvm::errs() << "ExtractVariantPartInfo: Missing or only non valid "
                    "DW_TAG_variant children for "
                 << llvm::format_hex(die.GetOffset(), 10)
                 << ", ignoring entry.\n";
    return false;
  }

  return true;
}

bool ExtractTemplateParameterInfo(const DWARFDIE &die,
                                  types::TemplateParameterInfo &info) {

  lldb_private::Type *type;
  if (!ExtractTypeFromDWARFDIE(die, &type)) {
    return false;
  }

  auto name = die.GetAttributeValueAsString(DW_AT_name, nullptr);

  info.type = type->GetForwardCompilerType();
  info.name = name ? llvm::Optional<std::string>(name) : llvm::None;
  return true;
}

void LinkVariantPartMemberTypesToDeclContext(
    const DWARFDIE &die,
    std::function<void(const DWARFDIE &)> link_member_type) {

  auto link_member = [&link_member_type](auto die) {
    DWARFDIE type = die.GetAttributeValueAsReferenceDIE(DW_AT_type);
    if (!type) {
      llvm::errs() << "LinkVariantPartMemberTypesToDeclContext: missing "
                      "DW_AT_type for "
                   << llvm::format_hex(die.GetOffset(), 10)
                   << ", ignoring entry.\n";
      return;
    }
    link_member_type(type);
  };

  auto link_variant = [&link_member](auto die) {
    ForEachDWARFDIEChild(die, DW_TAG_member, link_member);
  };

  auto link_variant_part = [&link_variant](auto die) {
    ForEachDWARFDIEChild(die, DW_TAG_variant, link_variant);
  };

  ForEachDWARFDIEChild(die, DW_TAG_variant_part, link_variant_part);
}

bool IsLanguageSupportedByExtendedTypeInfo(lldb::LanguageType language) {
  switch (language) {
  case lldb::eLanguageTypeRust:
    return true;
  default:
    return false;
  }
}

} // namespace

bool DWARFASTParserClangExtended::CompleteTypeFromDWARF(
    const DWARFDIE &die, lldb_private::Type *type,
    lldb_private::CompilerType &compiler_type) {

  auto dieCU = die.GetCU();
  auto language = dieCU ? (lldb::LanguageType)dieCU->GetDWARFLanguageType()
                        : compiler_type.GetMinimumLanguage();

  if (IsLanguageSupportedByExtendedTypeInfo(language)) {
    auto decl_context =
        m_ast.GetAsCXXRecordDecl(compiler_type.GetOpaqueQualType());
    if (decl_context) {
      auto link_member_type = [&](auto type_die) {
        LinkDeclContextToDIE(decl_context, type_die);
      };
      LinkVariantPartMemberTypesToDeclContext(die, link_member_type);
    }
  }

  if (!DWARFASTParserClang::CompleteTypeFromDWARF(die, type, compiler_type)) {
    return false;
  }

  if (IsLanguageSupportedByExtendedTypeInfo(language)) {
    auto type_info =
        TypeSystemClangExtended::GetExtendedTypeInfo(compiler_type, true);

    type_info->language = language;

    ForEachDWARFDIEChild(
        die, DW_TAG_variant_part, [&type_info](auto variant_part_die) {
          types::VariantPartInfo variant_part;
          if (ExtractVariantPartInfo(variant_part_die, variant_part)) {
            type_info->variant_parts.push_back(variant_part);
          }
        });

    ForEachDWARFDIEChild(
        die, DW_TAG_template_type_parameter,
        [&type_info](auto template_parameter_die) {
          types::TemplateParameterInfo template_parameter;
          if (ExtractTemplateParameterInfo(template_parameter_die,
                                           template_parameter)) {
            type_info->template_parameters.push_back(template_parameter);
          }
        });

    type_info->byte_size = GetRecordByteSize(die);
  }

  return true;
}

/// LLVM RTTI support.
char TypeSystemClangExtended::ID;
char ClangExternalASTSourceCallbacks::ID;

TypeSystemClangExtended::TypeSystemClangExtended(llvm::StringRef name,
                                                 llvm::Triple triple)
    : lldb_private::TypeSystemClang(name, triple) {
  llvm::IntrusiveRefCntPtr<clang::ExternalASTSource> ast_source_up(
      new ClangExternalASTSourceCallbacks(*this));
  SetExternalSource(ast_source_up);
}

DWARFASTParser *TypeSystemClangExtended::GetDWARFParser() {
  if (!m_dwarf_ast_parser_up)
    m_dwarf_ast_parser_up =
        std::make_unique<DWARFASTParserClangExtended>(*this);
  return m_dwarf_ast_parser_up.get();
}

void TypeSystemClangExtended::Initialize() {
  lldb_private::PluginManager::RegisterPlugin(
      GetPluginNameStatic(),
      "clang base AST context plug-in (with extended rust support)",
      CreateInstance, GetSupportedLanguagesForTypes(),
      GetSupportedLanguagesForExpressions());
}

void TypeSystemClangExtended::Terminate() {
  lldb_private::PluginManager::UnregisterPlugin(CreateInstance);
}

llvm::Optional<uint64_t> TypeSystemClangExtended::GetBitSize(
    lldb::opaque_compiler_type_t type,
    lldb_private::ExecutionContextScope *exe_scope) {
  auto extended_info = GetExtendedTypeInfo(type);
  if (extended_info && extended_info->byte_size) {
    return extended_info->byte_size.value() * 8ULL;
  }

  return TypeSystemClang::GetBitSize(type, exe_scope);
}

lldb::TypeSystemSP
TypeSystemClangExtended::CreateInstance(lldb::LanguageType language,
                                        lldb_private::Module *module,
                                        lldb_private::Target *target) {
  if (!module) {
    return TypeSystemClang::CreateInstance(language, nullptr, target);
  }

  return std::make_shared<TypeSystemClangExtended>(
      "ASTContext for '" + module->GetFileSpec().GetPath() + "'",
      module->GetArchitecture().GetTriple());
}

types::ExtendedTypeInfo *
TypeSystemClangExtended::GetExtendedTypeInfo(lldb_private::CompilerType type,
                                             bool create_if_needed) {
  auto type_system =
      type.GetTypeSystem().dyn_cast_or_null<TypeSystemClangExtended>();
  if (!type_system) {
    return nullptr;
  }

  return type_system->GetExtendedTypeInfo(type.GetOpaqueQualType(),
                                          create_if_needed);
}

types::ExtendedTypeInfo *
TypeSystemClangExtended::GetExtendedTypeInfo(lldb::opaque_compiler_type_t type,
                                             bool create_if_needed) {

  auto entry = m_type_info.find(type);
  if (entry != m_type_info.end()) {
    return &entry->second;
  }

  if (!create_if_needed) {
    return nullptr;
  }

  return &m_type_info.insert(std::make_pair(type, types::ExtendedTypeInfo()))
              .first->second;
}

} // namespace symbols_backend

LLDB_PLUGIN_DEFINE_ADV(symbols_backend::SymbolFileWasmDWARF,
                       SymbolFileWasmDWARF)

namespace lldb_private {
void HostInfoLinux::ComputeHostArchitectureSupport(ArchSpec& arch_32,
                                                   ArchSpec& arch_64) {
  HostInfoPosix::ComputeHostArchitectureSupport(arch_32, arch_64);
}

bool HostInfoLinux::ComputeSystemPluginsDirectory(FileSpec& file_spec) {
  return false;
}

bool HostInfoLinux::ComputeUserPluginsDirectory(FileSpec& file_spec) {
  return false;
}

Environment Host::GetEnvironment() {
  return {};
}
}  // namespace lldb_private
