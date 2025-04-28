// This file is based on a file from revision cf3a5c70b97b388fff3490b62f1bdaaa6a26f8e1 
// of the Chrome DevTools C/C++ Debugging Extension, see the wasm/symbols-backend/LICENSE file.
//
// https://github.com/ChromeDevTools/devtools-frontend/blob/main/extensions/cxx_debugging/src/DWARFSymbols.ts

import './Formatters';

import type { Chrome } from './ExtensionAPI';

import * as Formatters from './CustomFormatters';
import { getUnmarshalledInterface, UnmarshalInterface } from './embind';
import { resolveSourcePathToURL } from './PathUtils';
import type * as SymbolsBackend from './SymbolsBackend';
import createSymbolsBackend from './SymbolsBackend';
import type { HostInterface } from './WorkerRPC';

interface ScopeInfo {
  type: 'GLOBAL' | 'LOCAL' | 'PARAMETER';
  typeName: string;
  icon?: string;
}

type LazyFSNode = FS.FSNode & { contents: { cacheLength: () => void, length: number; }; };

class ModuleInfo {
  readonly fileNameToUrl: Map<string, string>;
  readonly urlToFileName: Map<string, string>;
  readonly dwarfSymbolsPlugin: UnmarshalInterface<SymbolsBackend.DWARFSymbolsPlugin>;

  constructor(
    readonly symbolsUrl: string, readonly symbolsFileName: string, readonly symbolsDwpFileName: string | undefined,
    readonly backend: SymbolsBackend.Module) {
    this.fileNameToUrl = new Map<string, string>();
    this.urlToFileName = new Map<string, string>();
    this.dwarfSymbolsPlugin = getUnmarshalledInterface(new backend.DWARFSymbolsPlugin(), {
      methods: [
        'AddRawModule',
        'RemoveRawModule',
        'SourceLocationToRawLocation',
        'RawLocationToSourceLocation',
        'ListVariablesInScope',
        'GetFunctionInfo',
        'GetInlinedFunctionRanges',
        'GetInlinedCalleesRanges',
        'GetMappedLines',
        'EvaluateExpression',
        'delete',
      ],
      enumTypes: [
        backend.ErrorCode,
        backend.VariableScope
      ],
    });
  }
}

// Cache the underlying WebAssembly module after the first instantiation
// so that subsequent calls to `createSymbolsBackend()` are faster, which
// greatly speeds up the test suite.
let symbolsBackendModulePromise: undefined | Promise<WebAssembly.Module>;
function instantiateWasm(
  imports: WebAssembly.Imports,
  callback: (module: WebAssembly.Module) => void,
  resourceLoader: ResourceLoader,
): Emscripten.WebAssemblyExports {
  if (!symbolsBackendModulePromise) {
    symbolsBackendModulePromise = resourceLoader.createSymbolsBackendModulePromise();
  }
  symbolsBackendModulePromise.then(module => WebAssembly.instantiate(module, imports))
    .then(callback)
    .catch(console.error);
  return [];
}

export type RawModule = Chrome.DevTools.RawModule & { dwp?: ArrayBuffer; };

export interface ResourceLoader {
  loadSymbols(rawModuleId: string, rawModule: RawModule, url: URL, filesystem: typeof FS, hostInterface: HostInterface):
    Promise<{ symbolsFileName: string, symbolsDwpFileName?: string; }>;
  createSymbolsBackendModulePromise(): Promise<WebAssembly.Module>;
  possiblyMissingSymbols?: string[];
}

export class DWARFLanguageExtensionPlugin implements Chrome.DevTools.LanguageExtensionPlugin {
  private moduleInfos = new Map<string, Promise<ModuleInfo | undefined>>();
  private lazyObjects = new Formatters.LazyObjectStore();

  constructor(readonly resourceLoader: ResourceLoader, readonly hostInterface: HostInterface) { }

  private async newModuleInfo(rawModuleId: string, symbolsHint: string, rawModule: RawModule): Promise<ModuleInfo> {
    const rawModuleURL = new URL(rawModule.url);
    const symbolsURL = symbolsHint ? resolveSourcePathToURL(symbolsHint, rawModuleURL) : rawModuleURL;

    const instantiateWasmWrapper =
      (imports: Emscripten.WebAssemblyImports,
        callback: (module: WebAssembly.Module) => void): Emscripten.WebAssemblyExports => {
        // Emscripten type definitions are incorrect, we're getting passed a WebAssembly.Imports object here.
        return instantiateWasm(imports as unknown as WebAssembly.Imports, callback, this.resourceLoader);
      };
    const backend = await createSymbolsBackend({ instantiateWasm: instantiateWasmWrapper });
    const { symbolsFileName, symbolsDwpFileName } =
      await this.resourceLoader.loadSymbols(rawModuleId, rawModule, symbolsURL, backend.FS, this.hostInterface);
    const moduleInfo = new ModuleInfo(symbolsURL.href, symbolsFileName, symbolsDwpFileName, backend);

    const { sources, dwos } = moduleInfo.dwarfSymbolsPlugin.AddRawModule(rawModuleId, symbolsFileName);
    for (const fileName of sources) {
      const fileURL = resolveSourcePathToURL(fileName, symbolsURL);
      moduleInfo.fileNameToUrl.set(fileName, fileURL.href);
      moduleInfo.urlToFileName.set(fileURL.href, fileName);
    };

    for (const dwoFile of dwos) {
      const absolutePath = dwoFile.startsWith('/') ? dwoFile : '/' + dwoFile;
      const pathSplit = absolutePath.split('/');
      const fileName = pathSplit.pop() as string;
      const parentDirectory = pathSplit.join('/');

      const dwoURL = new URL(dwoFile, symbolsURL).href;
      const dwoResponse = await fetch(dwoURL, { mode: 'no-cors' })
        .catch((e: Error) => ({ ok: false, status: -1, statusText: e.message } as const));

      if (dwoResponse.ok) {
        const dwoData = await dwoResponse.arrayBuffer();
        void this.hostInterface.reportResourceLoad(dwoURL, { success: true, size: dwoData.byteLength });

        // Sometimes these stick around.
        try {
          backend.FS.unlink(absolutePath);
        } catch {
        }
        // Ensure directory exists
        if (parentDirectory.length > 1) {
          // TypeScript doesn't know about createPath
          // @ts-expect-error doesn't exit on types
          backend.FS.createPath('/', parentDirectory.substring(1), true, true);
        }

        backend.FS.createDataFile(
          parentDirectory,
          fileName,
          new Uint8Array(dwoData),
          true /* canRead */,
          false /* canWrite */,
          true /* canOwn */,
        );
      } else {
        const dwoError = dwoResponse.statusText || `status code ${dwoResponse.status}`;
        void this.hostInterface.reportResourceLoad(dwoURL, { success: false, errorMessage: `Failed to fetch dwo file: ${dwoError}` });
      }
    }

    return moduleInfo;
  }

  async addRawModule(rawModuleId: string, symbolsUrl: string, rawModule: RawModule): Promise<string[]> {
    // This complex logic makes sure that addRawModule / removeRawModule calls are
    // handled sequentially for the same rawModuleId, and thus this looks symmetrical
    // to the removeRawModule() method below. The idea is that we chain our operation
    // on any previous operation for the same rawModuleId, and thereby end up with a
    // single sequence of events.
    const originalPromise = Promise.resolve(this.moduleInfos.get(rawModuleId));
    const moduleInfoPromise = originalPromise.then(moduleInfo => {
      if (moduleInfo) {
        throw new Error(`InternalError: Duplicate module with ID '${rawModuleId}'`);
      }
      return this.newModuleInfo(rawModuleId, symbolsUrl, rawModule);
    });
    // This looks a bit odd, but it's important that the operation is chained via
    // the `_moduleInfos` map *and* at the same time resolves to it's original
    // value in case of an error (i.e. if someone tried to add the same rawModuleId
    // twice, this will retain the original value in that case instead of having all
    // users get the internal error).
    this.moduleInfos.set(rawModuleId, moduleInfoPromise.catch(() => originalPromise));
    const moduleInfo = await moduleInfoPromise;
    return [...moduleInfo.urlToFileName.keys()];
  }

  private async getModuleInfo(rawModuleId: string): Promise<ModuleInfo> {
    const moduleInfo = await this.moduleInfos.get(rawModuleId);
    if (!moduleInfo) {
      throw new Error(`InternalError: Unknown module with raw module ID ${rawModuleId}`);
    }
    return moduleInfo;
  }

  async removeRawModule(rawModuleId: string): Promise<void> {
    const originalPromise = Promise.resolve(this.moduleInfos.get(rawModuleId));
    const moduleInfoPromise = originalPromise.then(moduleInfo => {
      if (!moduleInfo) {
        throw new Error(`InternalError: No module with ID '${rawModuleId}'`);
      }
      return undefined;
    });
    this.moduleInfos.set(rawModuleId, moduleInfoPromise.catch(() => originalPromise));
    await moduleInfoPromise;
  }

  async sourceLocationToRawLocation(sourceLocation: Chrome.DevTools.SourceLocation):
    Promise<Chrome.DevTools.RawLocationRange[]> {
    const moduleInfo = await this.getModuleInfo(sourceLocation.rawModuleId);
    const sourceFile = moduleInfo.urlToFileName.get(sourceLocation.sourceFileURL);
    if (!sourceFile) {
      throw new Error(`InternalError: Unknown URL ${sourceLocation.sourceFileURL}`);
    }
    const { rawLocationRanges, error } = moduleInfo.dwarfSymbolsPlugin.SourceLocationToRawLocation(
      sourceLocation.rawModuleId, sourceFile, sourceLocation.lineNumber, sourceLocation.columnNumber);
    if (error) {
      throw new Error(`${error.code}: ${error.message}`);
    }
    return rawLocationRanges;
  }

  async rawLocationToSourceLocation(rawLocation: Chrome.DevTools.RawLocation):
    Promise<Chrome.DevTools.SourceLocation[]> {
    const moduleInfo = await this.getModuleInfo(rawLocation.rawModuleId);
    const { sourceLocation, error } = moduleInfo.dwarfSymbolsPlugin.RawLocationToSourceLocation(
      rawLocation.rawModuleId, rawLocation.codeOffset, rawLocation.inlineFrameIndex || 0);
    if (error) {
      throw new Error(`${error.code}: ${error.message}`);
    }
    return sourceLocation.map(({ rawModuleId, sourceFile, lineNumber, columnNumber }) => {
      const sourceFileURL = moduleInfo.fileNameToUrl.get(sourceFile);
      if (!sourceFileURL) {
        throw new Error(`InternalError: Unknown source file ${sourceFile}`);
      }
      return {
        rawModuleId,
        sourceFileURL,
        lineNumber,
        columnNumber,
      };
    });
  }

  async getScopeInfo(type: string): Promise<ScopeInfo> {
    switch (type) {
      case 'GLOBAL':
        return {
          type,
          typeName: 'Global',
          icon: 'data:null',
        };
      case 'LOCAL':
        return {
          type,
          typeName: 'Local',
          icon: 'data:null',
        };
      case 'PARAMETER':
        return {
          type,
          typeName: 'Parameter',
          icon: 'data:null',
        };
    }
    throw new Error(`InternalError: Invalid scope type '${type}`);
  }

  async listVariablesInScope(rawLocation: Chrome.DevTools.RawLocation): Promise<Chrome.DevTools.Variable[]> {
    const moduleInfo = await this.getModuleInfo(rawLocation.rawModuleId);
    const { variable, error } = moduleInfo.dwarfSymbolsPlugin.ListVariablesInScope(
      rawLocation.rawModuleId, rawLocation.codeOffset, rawLocation.inlineFrameIndex || 0);
    if (error) {
      throw new Error(`${error.code}: ${error.message}`);
    }
    return variable.map(({ scope, name, type }) => {
      return { scope, name, type, nestedName: name.split('::') };
    });
  }

  async getFunctionInfo(rawLocation: Chrome.DevTools.RawLocation):
    Promise<{ frames: Chrome.DevTools.FunctionInfo[], missingSymbolFiles: string[]; }> {
    const moduleInfo = await this.getModuleInfo(rawLocation.rawModuleId);
    const { functionNames, missingSymbolFiles, error } =
      moduleInfo.dwarfSymbolsPlugin.GetFunctionInfo(rawLocation.rawModuleId, rawLocation.codeOffset);
    if (error) {
      throw new Error(`${error.code}: ${error.message}`);
    }
    return {
      frames: functionNames.map(name => ({ name })),
      missingSymbolFiles: missingSymbolFiles.length > 0 && this.resourceLoader.possiblyMissingSymbols
        ? missingSymbolFiles.concat(this.resourceLoader.possiblyMissingSymbols).map(s => new URL(s, moduleInfo.symbolsUrl).href)
        : []
    };
  }

  async getInlinedFunctionRanges(rawLocation: Chrome.DevTools.RawLocation):
    Promise<Chrome.DevTools.RawLocationRange[]> {
    const moduleInfo = await this.getModuleInfo(rawLocation.rawModuleId);
    const { rawLocationRanges, error } =
      moduleInfo.dwarfSymbolsPlugin.GetInlinedFunctionRanges(rawLocation.rawModuleId, rawLocation.codeOffset);
    if (error) {
      throw new Error(`${error.code}: ${error.message}`);
    }
    return rawLocationRanges;
  }

  async getInlinedCalleesRanges(rawLocation: Chrome.DevTools.RawLocation): Promise<Chrome.DevTools.RawLocationRange[]> {
    const moduleInfo = await this.getModuleInfo(rawLocation.rawModuleId);
    const { rawLocationRanges, error } =
      moduleInfo.dwarfSymbolsPlugin.GetInlinedCalleesRanges(rawLocation.rawModuleId, rawLocation.codeOffset);
    if (error) {
      throw new Error(`${error.code}: ${error.message}`);
    }
    return rawLocationRanges;
  }

  async getMappedLines(rawModuleId: string, sourceFileURL: string): Promise<number[]> {
    const moduleInfo = await this.getModuleInfo(rawModuleId);
    const sourceFile = moduleInfo.urlToFileName.get(sourceFileURL);
    if (!sourceFile) {
      throw new Error(`InternalError: Unknown URL ${sourceFileURL}`);
    }
    const { mappedLines, error } = moduleInfo.dwarfSymbolsPlugin.GetMappedLines(rawModuleId, sourceFile);
    if (error) {
      throw new Error(`${error.code}: ${error.message}`);
    }
    return mappedLines;
  }

  async evaluate(expression: string, context: Chrome.DevTools.RawLocation, stopId: unknown):
    Promise<Chrome.DevTools.RemoteObject | Chrome.DevTools.ForeignObject | null> {
    const moduleInfo = await this.getModuleInfo(context.rawModuleId);
    const apiRawLocation = new moduleInfo.backend.RawLocation();
    try {
      apiRawLocation.rawModuleId = context.rawModuleId;
      apiRawLocation.codeOffset = context.codeOffset;
      apiRawLocation.inlineFrameIndex = context.inlineFrameIndex || 0;

      const wasm = new Formatters.HostWasmInterface(this.hostInterface, stopId);
      const debuggerProxy = new Formatters.DebuggerProxy(wasm, moduleInfo.backend);

      const { typeInfos, root, displayValue, location, memoryAddress, data, error } =
        moduleInfo.dwarfSymbolsPlugin.EvaluateExpression(apiRawLocation, expression, debuggerProxy);

      if (error) {
        if (error.code === 'MODULE_NOT_FOUND_ERROR') {
          // Let's not throw when the module gets unloaded - that is quite common path that
          // we hit when the source-scope pane still keeps asynchronously updating while we
          // unload the wasm module.
          return {
            type: 'undefined' as Chrome.DevTools.RemoteObjectType,
            hasChildren: false,
            description: '<optimized out>',
          };
        }
        // TODO(crbug.com/1271147) Instead of throwing, we whould create an AST error node with the message
        // so that it is properly surfaced to the user. This should then make the special handling of
        // MODULE_NOT_FOUND_ERROR unnecessary.
        throw new Error(`${error.code}: ${error.message}`);
      }

      const value = { typeInfos, root, location, data, displayValue, memoryAddress };
      return Formatters.CXXValue.create(this.lazyObjects, wasm, wasm.view, value).asRemoteObject();
    } finally {
      apiRawLocation.delete();
    }
  }

  async getProperties(objectId: Chrome.DevTools.RemoteObjectId): Promise<Chrome.DevTools.PropertyDescriptor[]> {
    const remoteObject = this.lazyObjects.get(objectId);
    if (!remoteObject) {
      return [];
    }

    const properties = await remoteObject.getProperties();
    const descriptors = [];
    for (const { name, property } of properties) {
      descriptors.push({ name, value: await property.asRemoteObject() });
    }
    return descriptors;
  }

  async releaseObject(objectId: Chrome.DevTools.RemoteObjectId): Promise<void> {
    this.lazyObjects.release(objectId);
  }
}

export async function createPlugin(
  hostInterface: HostInterface, resourceLoader: ResourceLoader,
  logPluginApiCalls = false): Promise<DWARFLanguageExtensionPlugin> {
  const plugin = new DWARFLanguageExtensionPlugin(resourceLoader, hostInterface);
  if (logPluginApiCalls) {
    const pluginLoggingProxy = {
      get: function <Key extends keyof DWARFLanguageExtensionPlugin>(target: DWARFLanguageExtensionPlugin, key: Key):
        DWARFLanguageExtensionPlugin[Key] {
        if (typeof target[key] === 'function') {
          return function (): unknown {
            const args = [...arguments];
            const jsonArgs = args.map(x => {
              try {
                return JSON.stringify(x);
              } catch {
                return x.toString();
              }
            })
              .join(', ');
            // eslint-disable-next-line no-console
            console.info(`${key}(${jsonArgs})`);
            // @ts-expect-error TypeScript does not play well with `arguments`
            return (target[key] as (...args: any[]) => void).apply(target, arguments);
          } as unknown as DWARFLanguageExtensionPlugin[Key];
        }
        return Reflect.get(target, key);
      },
    };

    return new Proxy(plugin, pluginLoggingProxy);
  }
  return plugin;
}
