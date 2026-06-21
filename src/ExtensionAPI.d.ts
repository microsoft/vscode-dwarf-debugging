// This file is based on a file from revision cf3a5c70b97b388fff3490b62f1bdaaa6a26f8e1 
// of the Chrome DevTools C/C++ Debugging Extension, see the wasm/symbols-backend/LICENSE file.
//
// https://github.com/ChromeDevTools/devtools-frontend/blob/main/extension-api/ExtensionAPI.d.ts

export namespace Chrome {
  export namespace DevTools {

    export interface RawModule {
      url: string;
      code?: ArrayBuffer;
    }

    export interface RawLocationRange {
      rawModuleId: string;
      startOffset: number;
      endOffset: number;
    }

    export interface RawLocation {
      rawModuleId: string;
      codeOffset: number;
      inlineFrameIndex: number;
    }

    export interface SourceLocation {
      rawModuleId: string;
      sourceFileURL: string;
      lineNumber: number;
      columnNumber: number;
    }

    export interface Variable {
      scope: string;
      name: string;
      type: string;
      nestedName?: string[];
    }

    export interface ScopeInfo {
      type: string;
      typeName: string;
      icon?: string;
    }

    export interface FunctionInfo {
      name: string;
    }

    export type RemoteObjectId = string;
    export type RemoteObjectType = 'object' | 'undefined' | 'string' | 'number' | 'boolean' | 'bigint' | 'array' | 'null';

    export interface RemoteObject {
      type: RemoteObjectType;
      className?: string;
      value?: any;
      description?: string;
      objectId?: RemoteObjectId;
      linearMemoryAddress?: number;
      linearMemorySize?: number;
      hasChildren: boolean;
    }

    /**
     * This refers to a Javascript or a Wasm value of reference type
     * in the V8 engine. We call it foreign object here to emphasize
     * the difference with the remote objects managed by a language
     * extension plugin.
     */
    export interface ForeignObject {
      type: 'reftype';
      valueClass: 'local' | 'global' | 'operand';
      index: number;
      /**
       * @deprecated Only for type compatibility with @vscode/js-debug
       */
      description?: undefined;
      /**
       * @deprecated Only for type compatibility with @vscode/js-debug
       */
      objectId?: undefined;
      /**
       * @deprecated Only for type compatibility with @vscode/js-debug
       */
      linearMemoryAddress?: undefined;
      /**
       * @deprecated Only for type compatibility with @vscode/js-debug
       */
      linearMemorySize?: undefined;
    }

    export interface PropertyDescriptor {
      name: string;
      value: RemoteObject | ForeignObject;
    }

    export interface LanguageExtensionPlugin {
      /**
       * A new raw module has been loaded. If the raw wasm module references an external debug info module, its URL will be
       * passed as symbolsURL.
       */
      addRawModule(rawModuleId: string, symbolsURL: string | undefined, rawModule: RawModule):
        Promise<string[] | { missingSymbolFiles: string[]; }>;

      /**
       * Find locations in raw modules from a location in a source file.
       */
      sourceLocationToRawLocation(sourceLocation: SourceLocation): Promise<RawLocationRange[]>;

      /**
       * Find locations in source files from a location in a raw module.
       */
      rawLocationToSourceLocation(rawLocation: RawLocation): Promise<SourceLocation[]>;

      /**
       * Return detailed information about a scope.
       */
      getScopeInfo(type: string): Promise<ScopeInfo>;

      /**
       * List all variables in lexical scope at a given location in a raw module.
       */
      listVariablesInScope(rawLocation: RawLocation): Promise<Variable[]>;

      /**
       * Notifies the plugin that a script is removed.
       */
      removeRawModule(rawModuleId: string): Promise<void>;

      /**
       * Retrieve function name(s) for the function(s) containing the rawLocation. This returns more than one entry if
       * the location is inside of an inlined function with the innermost function at index 0.
       */
      getFunctionInfo(rawLocation: RawLocation):
        Promise<{ frames: Array<FunctionInfo>, missingSymbolFiles: Array<string>; } | { missingSymbolFiles: Array<string>; } |
        { frames: Array<FunctionInfo>; }>;

      /**
       * Find locations in raw modules corresponding to the inline function
       * that rawLocation is in. Used for stepping out of an inline function.
       */
      getInlinedFunctionRanges(rawLocation: RawLocation): Promise<RawLocationRange[]>;

      /**
       * Find locations in raw modules corresponding to inline functions
       * called by the function or inline frame that rawLocation is in.
       * Used for stepping over inline functions.
       */
      getInlinedCalleesRanges(rawLocation: RawLocation): Promise<RawLocationRange[]>;

      /**
       * Retrieve a list of line numbers in a file for which line-to-raw-location mappings exist.
       */
      getMappedLines(rawModuleId: string, sourceFileURL: string): Promise<number[] | undefined>;

      /**
       * Evaluate a source language expression in the context of a given raw location and a given stopId. stopId is an
       * opaque key that should be passed to the APIs accessing wasm state, e.g., getWasmLinearMemory. A stopId is
       * invalidated once the debugger resumes.
       */
      evaluate(expression: string, context: RawLocation, stopId: unknown): Promise<RemoteObject | ForeignObject | null>;

      /**
       * Retrieve properties of the remote object identified by the object id.
       */
      getProperties(objectId: RemoteObjectId): Promise<PropertyDescriptor[]>;

      /**
       * Permanently release the remote object identified by the object id.
       */
      releaseObject(objectId: RemoteObjectId): Promise<void>;
    }

    export type WasmValue =
      | { type: 'i32' | 'f32' | 'f64', value: number; }
      | { type: 'i64', value: bigint; }
      | { type: 'v128', value: string; }
      | ForeignObject;
  }
}
