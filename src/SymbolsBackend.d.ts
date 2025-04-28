// This file is based on a file from revision cf3a5c70b97b388fff3490b62f1bdaaa6a26f8e1 
// of the Chrome DevTools C/C++ Debugging Extension, see the wasm/symbols-backend/LICENSE file.
//
// https://github.com/ChromeDevTools/devtools-frontend/blob/main/extensions/cxx_debugging/src/SymbolsBackend.d.ts

/* eslint-disable @typescript-eslint/naming-convention */

import { EmbindObject, EnumDefinition, EnumValue, Vector } from './embind';

export interface ErrorCode extends EnumValue<
  ErrorCode,
  | 'INTERNAL_ERROR'
  | 'PROTOCOL_ERROR'
  | 'MODULE_NOT_FOUND_ERROR'
  | 'TYPE_NAME_IN_MODULE_NOT_FOUND_ERROR'
  | 'EVAL_ERROR'> { }

export interface Error extends EmbindObject {
  code: ErrorCode;
  message: string;
}

export interface RawLocationRange extends EmbindObject {
  rawModuleId: string;
  startOffset: number;
  endOffset: number;
}

export interface RawLocation extends EmbindObject {
  rawModuleId: string;
  codeOffset: number;
  inlineFrameIndex: number;
}

export interface SourceLocation extends EmbindObject {
  rawModuleId: string;
  sourceFile: string;
  lineNumber: number;
  columnNumber: number;
}

export interface VariableScope extends EnumValue<
  VariableScope,
  | 'LOCAL'
  | 'PARAMETER'
  | 'GLOBAL'> { }

export interface Variable extends EmbindObject {
  scope: VariableScope;
  name: string;
  type: string;
  typedefs: Vector<string>;
}

export interface FieldInfo extends EmbindObject {
  name: string | undefined;
  offset: number;
  typeId: string;
}

export interface Enumerator extends EmbindObject {
  name: string;
  value: bigint;
  typeId: string;
}

export interface VariantInfo extends EmbindObject {
  discriminatorValue: bigint | undefined;
  members: Vector<FieldInfo>;
}

export interface VariantPartInfo extends EmbindObject {
  discriminatorMember: FieldInfo;
  variants: Vector<VariantInfo>;
}

export interface TemplateParameterInfo extends EmbindObject {
  typeId: string;
  name: string | undefined;
}

export interface ExtendedTypeInfo extends EmbindObject {
  languageId: number;
  variantParts: Vector<VariantPartInfo>;
  templateParameters: Vector<TemplateParameterInfo>;
}

export interface TypeInfo extends EmbindObject {
  typeNames: Vector<string>;
  typeId: string;
  alignment: number;
  size: number;
  canExpand: boolean;
  hasValue: boolean;
  arraySize: number;
  isPointer: boolean;
  members: Vector<FieldInfo>;
  enumerators: Vector<Enumerator>;
  extendedInfo: ExtendedTypeInfo | undefined;
}

export interface AddRawModuleResponse extends EmbindObject {
  sources: Vector<string>;
  dwos: Vector<string>;
  error: Error | undefined;
}

export interface SourceLocationToRawLocationResponse extends EmbindObject {
  rawLocationRanges: Vector<RawLocationRange>;
  error: Error | undefined;
}

export interface RawLocationToSourceLocationResponse extends EmbindObject {
  sourceLocation: Vector<SourceLocation>;
  error: Error | undefined;
}

export interface ListVariablesInScopeResponse extends EmbindObject {
  variable: Vector<Variable>;
  error: Error | undefined;
}

export interface GetFunctionInfoResponse extends EmbindObject {
  functionNames: Vector<string>;
  missingSymbolFiles: Vector<string>;
  error: Error | undefined;
}

export interface GetInlinedFunctionRangesResponse extends EmbindObject {
  rawLocationRanges: Vector<RawLocationRange>;
  error: Error | undefined;
}

export interface GetInlinedCalleesRangesResponse extends EmbindObject {
  rawLocationRanges: Vector<RawLocationRange>;
  error: Error | undefined;
}

export interface GetMappedLinesResponse extends EmbindObject {
  mappedLines: Vector<number>;
  error: Error | undefined;
}

export interface EvaluateExpressionResponse extends EmbindObject {
  typeInfos: Vector<TypeInfo>;
  root: TypeInfo;
  displayValue: string | undefined;
  location: number | undefined;
  memoryAddress: number | undefined;
  data: Vector<number> | undefined;
  error: Error | undefined;
}

export interface DWARFSymbolsPlugin extends EmbindObject {
  AddRawModule(rawModuleId: string, path: string): AddRawModuleResponse;
  RemoveRawModule(rawModuleId: string): void;
  SourceLocationToRawLocation(rawModuleId: string, sourceFileURL: string, lineNumber: number, columnNumber: number):
    SourceLocationToRawLocationResponse;
  RawLocationToSourceLocation(rawModuleId: string, codeOffset: number, inlineFrameIndex: number):
    RawLocationToSourceLocationResponse;
  ListVariablesInScope(rawModuleId: string, codeOffset: number, inlineFrameIndex: number): ListVariablesInScopeResponse;
  GetFunctionInfo(rawModuleId: string, codeOffset: number): GetFunctionInfoResponse;
  GetInlinedFunctionRanges(rawModuleId: string, codeOffset: number): GetInlinedFunctionRangesResponse;
  GetInlinedCalleesRanges(rawModuleId: string, codeOffset: number): GetInlinedCalleesRangesResponse;
  GetMappedLines(rawModuleId: string, sourceFileURL: string): GetMappedLinesResponse;
  EvaluateExpression(location: RawLocation, expression: string, debugProxy: unknown): EvaluateExpressionResponse;
}

export interface Module extends EmscriptenModule {
  FS: typeof FS;
  DWARFSymbolsPlugin: DWARFSymbolsPlugin;
  StringArray: Vector<string>;
  RawLocationRangeArray: Vector<RawLocationRange>;
  SourceLocationArray: Vector<SourceLocation>;
  VariableArray: Vector<Variable>;
  Int32_TArray: Vector<number>;
  TypeInfoArray: Vector<TypeInfo>;
  FieldInfoArray: Vector<FieldInfo>;
  EnumeratorArray: Vector<Enumerator>;
  VariantPartInfoArray: Vector<VariantPartInfo>;
  VariantInfoArray: Vector<VariantInfo>;
  TemplateParameterInfoArray: Vector<TemplateParameterInfo>;
  ErrorCode: EnumDefinition<ErrorCode>;
  Error: Error;
  RawLocationRange: RawLocationRange;
  RawLocation: RawLocation;
  SourceLocation: SourceLocation;
  VariableScope: EnumDefinition<VariableScope>;
  Variable: Variable;
  FieldInfo: FieldInfo;
  Enumerator: Enumerator;
  TypeInfo: TypeInfo;
  AddRawModuleResponse: AddRawModuleResponse;
  SourceLocationToRawLocationResponse: SourceLocationToRawLocationResponse;
  RawLocationToSourceLocationResponse: RawLocationToSourceLocationResponse;
  ListVariablesInScopeResponse: ListVariablesInScopeResponse;
  GetFunctionInfoResponse: GetFunctionInfoResponse;
  GetInlinedFunctionRangesResponse: GetInlinedFunctionRangesResponse;
  GetInlinedCalleesRangesResponse: GetInlinedCalleesRangesResponse;
  GetMappedLinesResponse: GetMappedLinesResponse;
  EvaluateExpressionResponse: EvaluateExpressionResponse;
}

declare let createSymbolsBackend: EmscriptenModuleFactory<Module>;
export default createSymbolsBackend;
