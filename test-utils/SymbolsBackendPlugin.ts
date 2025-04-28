
import { basename } from 'path';
import createSymbolsBackend, { RawLocation, Module as SymbolsBackendModule } from '../dist/SymbolsBackend';
import { DebuggerProxy, WasmMemoryView } from '../src/CustomFormatters';
import { getUnmarshalledInterface, UnmarshalObject } from '../src/embind';
import { createSyncInterface, SyncInterface } from './sync-interface';
import TestWasmInterface from './TestWasmInterface';

export default class SymbolsBackendPlugin {

  static create(...preLoadedFiles: string[]): ReturnType<SyncInterface<typeof SymbolsBackendPlugin>['__create']> {
    // createSyncInterface wrapped instances run in it's own worker thread so we can
    // be sure not to pollute our global context by loading the EmScripten module. 
    const worker = createSyncInterface(__filename, '__create', preLoadedFiles);
    return {
      AddRawModule: (...args) => worker.invoke('AddRawModule', ...args),
      RemoveRawModule: (...args) => worker.invoke('RemoveRawModule', ...args),
      SourceLocationToRawLocation: (...args) => worker.invoke('SourceLocationToRawLocation', ...args),
      RawLocationToSourceLocation: (...args) => worker.invoke('RawLocationToSourceLocation', ...args),
      ListVariablesInScope: (...args) => worker.invoke('ListVariablesInScope', ...args),
      GetFunctionInfo: (...args) => worker.invoke('GetFunctionInfo', ...args),
      GetInlinedFunctionRanges: (...args) => worker.invoke('GetInlinedFunctionRanges', ...args),
      GetInlinedCalleesRanges: (...args) => worker.invoke('GetInlinedCalleesRanges', ...args),
      GetMappedLines: (...args) => worker.invoke('GetMappedLines', ...args),
      EvaluateExpression: (...args) => worker.invoke('EvaluateExpression', ...args),
      delete: () => {
        worker.invoke('delete');
        worker.dispose();
      }
    };
  }

  static async __create(preLoadedFiles: string[]) {

    require('./emscripten-module-runner/prelude');

    const module = await createSymbolsBackend({
      // @ts-expect-error
      preRun({ FS }: SymbolsBackendModule) {
        for (const path of preLoadedFiles) {
          FS.createPreloadedFile('', basename(path), path, true, false);
        }
      }
    });

    const instance = new module.DWARFSymbolsPlugin();

    const unmarshalledInteface = getUnmarshalledInterface(instance, {
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
        'delete'
      ],
      enumTypes: [
        module.ErrorCode,
        module.VariableScope]
    });

    return {
      ...unmarshalledInteface,
      EvaluateExpression(location: UnmarshalObject<RawLocation>, expression: string, debugProxy: TestWasmInterface) {
        const locationMarshalled = new module.RawLocation();
        Object.assign(locationMarshalled, location);

        const wasm = new TestWasmInterface();
        const debugProxyMarshalled = new DebuggerProxy(wasm, module);
        Object.assign(wasm, debugProxy, { view: new WasmMemoryView(wasm) });

        try {
          return unmarshalledInteface.EvaluateExpression(locationMarshalled, expression, debugProxyMarshalled);
        } finally {
          locationMarshalled.delete();
        }
      }
    };
  }
}