import assert from 'assert';
import { BinaryLike, createHash, randomBytes, randomUUID } from 'crypto';
import Protocol from 'devtools-protocol';
import ProtocolMapping from 'devtools-protocol/types/protocol-mapping';
import EventEmitter from 'events';
import { readFile } from 'fs/promises';
import path from 'path';
import { WebSocket } from 'ws';
import { spawn } from '../dist';
import { Chrome } from '../src/ExtensionAPI';
import { resolveSourcePathToURL } from '../src/PathUtils';
import { ForeignObject } from '../src/WasmTypes';
import { createSyncInterface, SyncInterface } from './sync-interface';

export const TIMEOUT_IN_SECONDS = 10;
export const TIMEOUT_IN_MILLISECONDS = TIMEOUT_IN_SECONDS * 1000;

export const BREAK_ON_START_REASON = 'Break on start' as Protocol.Debugger.PausedEvent['reason'];

const breakOnWasm = defineEvalScript(function () {
  for (const fn of [
    'instantiate',
    'instantiateStreaming',
    'compile',
    'compileStreaming',
  ] satisfies (keyof typeof WebAssembly)[]) {
    const original = WebAssembly[fn];
    WebAssembly[fn] = function (...args: any[]) {
      return original.apply(this, args).then((r: any) => {
        // note: instantiating an existing module won't (re)compile the script
        // so we have no need to stop.
        if (!(args[0] instanceof WebAssembly.Module)) {
          debugger;
        }
        return r;
      });
    };
  }
});

export default class DebuggerSession {
  #rpc: DebuggerRPC;
  #workerPlugin: WorkerPlugin;
  #module = new Waitable<{
    scriptId: string;
    codeOffset: number;
    rawModuleId: string;
    sourceFiles: string[];
  }>();
  #paused = new Waitable<Protocol.Debugger.PausedEvent>();
  #stopIdPrefix = 0;
  #stopId?: string;
  #breakOnWasmId?: string;


  constructor(url: string, modulePath: string, debugSymbolsFromPath?: string) {
    this.#rpc = new DebuggerRPC(url);
    this.#workerPlugin = createWorkerPlugin(this.#rpc);
    this.#waitForModule(modulePath, debugSymbolsFromPath);
  }

  static async attach(port: number, modulePath: string, debugSymbolsFromPath?: string) {
    const debuggerUrl = await resolveDebuggerUrl(`http://127.0.0.1:${port}/json`);
    const debuggerSession = new DebuggerSession(debuggerUrl, modulePath, debugSymbolsFromPath);
    await debuggerSession.#waitForPaused();
    return debuggerSession;
  }

  static attachSync(port: number, modulePath: string, debugSymbolsFromPath?: string): SyncInterface<DebuggerSession> {
    const worker = createSyncInterface(__filename, 'attach', port, modulePath, debugSymbolsFromPath);
    return {
      addBreakpoint: (sourceFileURL, line) => worker.invoke('addBreakpoint', sourceFileURL, line),
      removeBreakpoint: (breakpointId) => worker.invoke('removeBreakpoint', breakpointId),
      resume: () => worker.invoke('resume'),
      continueToLine: (sourceFile, line) => worker.invoke('continueToLine', sourceFile, line),
      stepOver: () => worker.invoke('stepOver'),
      stepInto: () => worker.invoke('stepInto'),
      stepOut: () => worker.invoke('stepOut'),
      waitForPaused: () => worker.invoke('waitForPaused'),
      evaluate: (expression) => worker.invoke('evaluate', expression),
      getProperties: (objectId) => worker.invoke('getProperties', objectId),
      listVariablesInScope: () => worker.invoke('listVariablesInScope'),
      dispose(): void {
        worker.invoke('dispose');
        worker.dispose();
      }
    };
  }

  async addBreakpoint(sourceFile: string, line: number | string): Promise<string> {
    this.#assertIsPaused();
    const location = await this.#resolveLocation(sourceFile, line);
    const { breakpointId } = await this.#rpc.send('Debugger.setBreakpoint', { location });
    return breakpointId;
  }

  async removeBreakpoint(breakpointId: string): Promise<void> {
    this.#assertIsPaused();
    this.#rpc.send('Debugger.removeBreakpoint', { breakpointId });
  }

  async resume(): Promise<void> {
    this.#assertIsPaused();
    this.#paused.reset();
    await this.#rpc.send(`Debugger.resume`, {});
  }

  async continueToLine(sourceFile: string, line: number | string): Promise<void> {
    this.#assertIsPaused();
    const location = await this.#resolveLocation(sourceFile, line);
    this.#paused.reset();
    await this.#rpc.send(`Debugger.continueToLocation`, { location });
  }

  async stepOver(): Promise<void> {
    const skipList = await this.#getCurrentLineLocationRanges();
    this.#paused.reset();
    await this.#rpc.send(`Debugger.stepOver`, { skipList });
  }

  async stepInto(): Promise<void> {
    const skipList = await this.#getCurrentLineLocationRanges();
    this.#paused.reset();
    await this.#rpc.send(`Debugger.stepInto`, { skipList });
  }

  async stepOut(): Promise<void> {
    this.#assertIsPaused();
    this.#paused.reset();
    await this.#rpc.send(`Debugger.stepOut`, undefined);
  }

  async waitForPaused(): Promise<{
    reason: string;
    sourceFileURL?: string;
    lineNumber?: number;
    columnNumber?: number;
    hitBreakpoints?: string[];
  }> {
    const { reason, hitBreakpoints, rawLocation } = await this.#waitForPaused();
    if (rawLocation) {
      const sourceLocations = await this.#workerPlugin.rawLocationToSourceLocation(rawLocation);
      if (sourceLocations.length > 0) {
        return {
          reason,
          sourceFileURL: sourceLocations[0].sourceFileURL,
          lineNumber: sourceLocations[0].lineNumber + 1,     // Lines are 0-indexed in the worker plugin
          columnNumber: sourceLocations[0].columnNumber + 1, // Columns are 0-indexed in the worker plugin
          hitBreakpoints,
        };
      }
    }
    return { reason, hitBreakpoints };
  }

  async evaluate(expression: string): Promise<Chrome.DevTools.RemoteObject | ForeignObject | null> {
    const rawLocation = await this.#assertIsPausedInWebAssemblyModule();
    return await this.#workerPlugin.evaluate(expression, rawLocation, this.#stopId);
  }

  async listVariablesInScope(): Promise<Chrome.DevTools.Variable[]> {
    const rawLocation = await this.#assertIsPausedInWebAssemblyModule();
    return await this.#workerPlugin.listVariablesInScope(rawLocation);
  }

  async getProperties(objectId: Chrome.DevTools.RemoteObjectId): Promise<Chrome.DevTools.PropertyDescriptor[]> {
    return await this.#workerPlugin.getProperties(objectId);
  }

  async dispose() {
    await this.#workerPlugin.dispose();
    await this.#rpc.dispose();
  }

  async #waitForModule(modulePath: string, debugSymbolsFromPath?: string) {
    const rawModuleId = randomUUID();
    const rawModuleByteCodeHash = sha256(await readFile(modulePath));
    const url = resolveSourcePathToURL(path.resolve(debugSymbolsFromPath || modulePath), new URL('file://')).toString();

    const sourceFiles = await this.#workerPlugin.addRawModule(rawModuleId, undefined, { url });
    assert(Array.isArray(sourceFiles), `Missing symbols files for '${debugSymbolsFromPath || modulePath}'.`);

    const parsedScripts: Protocol.Debugger.ScriptParsedEvent[] = [];

    this.#rpc.on('Debugger.scriptParsed', async event => {
      if (event.url === breakOnWasm.url) {
        this.#breakOnWasmId = event.scriptId;
      } else if (event.url.startsWith('wasm://')) {
        parsedScripts.push(event);
      }
    });

    this.#rpc.on('Debugger.paused', async event => {
      let shouldAutoResume = event.reason === BREAK_ON_START_REASON;

      if (this.#isBreakOnWasm(event)) {
        shouldAutoResume = true;
        if (!this.#module.done) {
          while (parsedScripts.length > 0) {
            const { scriptId, codeOffset = 0 } = parsedScripts.pop()!;
            const parsedScriptByteCodeHash = await this.#getBytecodeHashForScript(scriptId);
            if (parsedScriptByteCodeHash === rawModuleByteCodeHash) {
              this.#rpc.removeAllListeners('Debugger.scriptParsed');
              parsedScripts.length = 0;
              shouldAutoResume = false;
              this.#module.resolve({
                scriptId,
                codeOffset,
                rawModuleId,
                sourceFiles,
              });
              break;
            }
          }
        }
      }

      if (shouldAutoResume) {
        await this.#rpc.send('Debugger.resume', {});
        return;
      }
      this.#stopId = `${this.#stopIdPrefix++}:${event.callFrames[0].callFrameId}`;
      this.#paused.resolve(event);
    });

    await this.#rpc.send('Debugger.enable', {});
    await this.#rpc.send('Runtime.evaluate', { expression: breakOnWasm.expression });
    await this.#rpc.send('Runtime.runIfWaitingForDebugger', undefined);

    await this.#module.wait();
  }

  async #waitForPaused() {
    const module = await this.#module.wait();
    const { reason, hitBreakpoints, callFrames: [{ location: { scriptId, columnNumber = 0 } }] } = await this.#paused.wait();
    const rawLocation = module.scriptId === scriptId
      ? {
        rawModuleId: module.rawModuleId,
        codeOffset: columnNumber - module.codeOffset,
        inlineFrameIndex: 0
      }
      : undefined;
    return { scriptId, reason, hitBreakpoints, rawLocation };
  }

  #isBreakOnWasm(event: Protocol.Debugger.PausedEvent) {
    return this.#breakOnWasmId && event.callFrames[0].location.scriptId === this.#breakOnWasmId;
  }

  async #getBytecodeHashForScript(scriptId: string): Promise<string> {
    const { bytecode } = await this.#rpc.send('Debugger.getScriptSource', { scriptId });
    assert(bytecode, `Expected parsed WebAssembly module to return bytecode for 'Debugger.getScriptSource'.`);
    return sha256(Buffer.from(bytecode, 'base64'));
  }

  async #resolveLocation(sourceFile: string, line: number | string): Promise<Protocol.Debugger.Location> {
    const lineNumber = typeof line === 'string' ? await findLineNumber(sourceFile, line) : line;

    const { scriptId, codeOffset, rawModuleId, sourceFiles } = await this.#module.wait();
    const sourceFileURL = sourceFiles.find(file => file.endsWith(`/${sourceFile}`));
    assert(sourceFileURL, `Could not find debug symbols for '${sourceFile}'.`);

    const mappedLineNumber = await this.#findMappedLine(rawModuleId, sourceFileURL, lineNumber);
    const rawLocationRanges = await this.#workerPlugin.sourceLocationToRawLocation({
      rawModuleId: rawModuleId,
      sourceFileURL,
      lineNumber: mappedLineNumber - 1, // Lines are 0-indexed in the worker plugin
      columnNumber: -1
    });
    assert(rawLocationRanges.length > 0, `Line can't be resolved to raw location: ${sourceFileURL}:${lineNumber}`);

    return {
      scriptId,
      lineNumber: 0,
      columnNumber: codeOffset + rawLocationRanges[0].startOffset
    };
  }

  async #getCurrentLineLocationRanges() {
    const rawLocation = await this.#assertIsPausedInWebAssemblyModule();
    const { scriptId, codeOffset } = await this.#module.wait();
    const locationRanges: Protocol.Debugger.LocationRange[] = [];
    for (const sourceLocation of await this.#workerPlugin.rawLocationToSourceLocation(rawLocation)) {
      for (const { startOffset, endOffset } of await this.#workerPlugin.sourceLocationToRawLocation(sourceLocation)) {
        locationRanges.push({
          scriptId,
          start: { lineNumber: 0, columnNumber: startOffset + codeOffset },
          end: { lineNumber: 0, columnNumber: endOffset + codeOffset }
        });
      }
    }
    return locationRanges;
  }

  async #findMappedLine(rawModuleId: string, sourceFileURL: string, lineNumber: number): Promise<number> {
    const mappedLines = await this.#workerPlugin.getMappedLines(rawModuleId, sourceFileURL) || [];
    for (const mappedLineIndex of mappedLines) {
      const mappedLineNumber = mappedLineIndex + 1; // Lines are 0-indexed in the worker plugin
      if (mappedLineNumber >= lineNumber) {
        return mappedLineNumber;
      }
    }
    assert.fail(`Line is unmapped: ${sourceFileURL}:${lineNumber}`);
  }

  #assertIsPaused(): void {
    assert(this.#paused.done, 'Must be in a paused state.');
  }

  async #assertIsPausedInWebAssemblyModule(): Promise<Chrome.DevTools.RawLocation> {
    this.#assertIsPaused();
    const { rawLocation } = await this.#waitForPaused();
    assert(rawLocation, 'Must be paused in WebAssembly module.');
    return rawLocation;
  }
}

interface WorkerPlugin extends Chrome.DevTools.LanguageExtensionPlugin {
  dispose(): Promise<void>;
}

function createWorkerPlugin(debuggerSessionRPC: DebuggerRPC): WorkerPlugin {

  const { rpc, dispose } = spawn({
    getWasmGlobal: (index, stopId) => loadWasmValue(`globals[${index}]`, stopId),
    getWasmLocal: (index, stopId) => loadWasmValue(`locals[${index}]`, stopId),
    getWasmOp: (index, stopId) => loadWasmValue(`stack[${index}]`, stopId),
    getWasmLinearMemory: (offset, length, stopId) =>
      loadWasmValue(
        `[].slice.call(new Uint8Array(memories[0].buffer, ${+offset}, ${+length}))`,
        stopId,
      ).then(v => new Uint8Array(v).buffer),
  });

  rpc.sendMessage('hello', [], false);

  return {
    addRawModule: (...args) => rpc.sendMessage('addRawModule', ...args),
    sourceLocationToRawLocation: (...args) => rpc.sendMessage('sourceLocationToRawLocation', ...args),
    rawLocationToSourceLocation: (...args) => rpc.sendMessage('rawLocationToSourceLocation', ...args),
    getScopeInfo: (...args) => rpc.sendMessage('getScopeInfo', ...args),
    listVariablesInScope: (...args) => rpc.sendMessage('listVariablesInScope', ...args),
    removeRawModule: (...args) => rpc.sendMessage('removeRawModule', ...args),
    getFunctionInfo: (...args) => rpc.sendMessage('getFunctionInfo', ...args),
    getInlinedFunctionRanges: (...args) => rpc.sendMessage('getInlinedFunctionRanges', ...args),
    getInlinedCalleesRanges: (...args) => rpc.sendMessage('getInlinedCalleesRanges', ...args),
    getMappedLines: (...args) => rpc.sendMessage('getMappedLines', ...args),
    evaluate: (...args) => rpc.sendMessage('evaluate', ...args),
    getProperties: (...args) => rpc.sendMessage('getProperties', ...args),
    releaseObject: (...args) => rpc.sendMessage('releaseObject', ...args),
    dispose
  };

  async function loadWasmValue(expression: string, stopId: unknown) {
    const stopIdString = stopId as string;
    const callFrameId = stopIdString.substring(stopIdString.indexOf(':') + 1);

    const result = await debuggerSessionRPC.send('Debugger.evaluateOnCallFrame', {
      callFrameId,
      expression,
      silent: true,
      returnByValue: true,
      throwOnSideEffect: true,
    });

    if (!result || result.exceptionDetails) {
      throw new Error(`evaluate failed: ${result?.exceptionDetails?.text || 'unknown'}`);
    }

    return result.result.value;
  }
}

function resolveDebuggerUrl(url: string) {
  return retryableOperation(
    async () => {
      try {
        const response = await fetch(url, {}).then(r => r.json());
        if (Array.isArray(response) && typeof response[0]?.webSocketDebuggerUrl === 'string') {
          return response[0]?.webSocketDebuggerUrl as string;
        }
      } catch { }
    },
    () => { throw new Error(`Resolving websocket debugger url timed out ('${url}')`); }
  );
}

function defineEvalScript(fn: () => unknown) {
  const url = `eval-${randomBytes(4).toString('hex')}.cdp`;
  const expression = `(${fn})();\n//# sourceURL=${url}\n`;
  return Object.freeze({ expression, url });
}

async function retryableOperation<T>(
  callback: () => T | undefined | Promise<T | undefined>,
  onTimeout: () => T | never,
): Promise<T> {
  const timeoutExpiry = Date.now() + TIMEOUT_IN_MILLISECONDS;
  do {
    await new Promise(resolve => setTimeout(resolve, 50));
    const result = await callback();
    if (result !== undefined) {
      return result;
    }
  } while (Date.now() < timeoutExpiry);
  return onTimeout();
}

async function findLineNumber(sourceFile: string, line: string): Promise<number> {

  const fileContent = await readFile(path.join(`${__dirname}/..`, sourceFile), 'utf8');

  const lineIndex = fileContent.split('\n').findIndex(l => l.includes(line));
  if (lineIndex < 0) {
    throw new Error(`Source line not found ('${line}' in '${sourceFile}')`);
  }

  return lineIndex + 1;
}

function sha256(bytes: BinaryLike) {
  return createHash('sha256').update(bytes).digest('hex');
}

type RPCParamsType<T extends keyof ProtocolMapping.Commands> = ProtocolMapping.Commands[T]['paramsType'][0];
type RPCReturnType<T extends keyof ProtocolMapping.Commands> = ProtocolMapping.Commands[T]['returnType'];

class DebuggerRPC extends EventEmitter<ProtocolMapping.Events> {
  private connected = new Waitable();
  private socket: WebSocket;
  private nextRequestId = 1;
  private pendingRequests = new Map<number, Waitable<unknown>>();

  constructor(url: string) {
    super({ captureRejections: true });
    this.socket = new WebSocket(url, {});
    this.socket.binaryType = 'nodebuffer';
    this.socket.onopen = () => {
      this.connected.resolve();
    };
    this.socket.onerror = e => {
      this.connected.reject(e.error);
    };
    this.socket.onmessage = async e => {
      const data = JSON.parse((e.data as Buffer).toString('utf8'));
      const { method, id, params, result, error } = data;
      if (method) {
        this.emit(method, params);
      } else {
        const responseReceived = this.pendingRequests.get(id);
        if (responseReceived) {
          this.pendingRequests.delete(id);
          if (error) {
            responseReceived.reject(new Error(error.message));
          }
          else {
            responseReceived.resolve(result);
          }
        } else {
          console.warn(`[CdpDebuggerSession] Unrelated message received:`, data);
        }
      }
    };
  }

  async send<T extends keyof ProtocolMapping.Commands>(method: T, params: RPCParamsType<T>): Promise<RPCReturnType<T>> {
    await this.connected.wait();
    const id = this.nextRequestId++;
    const responseReceived = new Waitable<unknown>();
    this.socket.send(JSON.stringify({ id, method, params }));
    this.pendingRequests.set(id, responseReceived);
    return await responseReceived.wait() as RPCReturnType<T>;
  }

  dispose() {
    const closed = new Waitable();
    this.socket.once('close', () => closed.resolve());
    this.socket.close();
    return closed.wait();
  }
}

const WAIT_TIMED_OUT = Symbol();

class Waitable<T = void> {
  private callbacks: Parameters<ConstructorParameters<typeof Promise<T>>[0]> | null;
  private promise = new Promise<T>((...args) => this.callbacks = args);

  get done() {
    return this.callbacks === null;
  }

  resolve(value: T) {
    if (this.callbacks) {
      this.callbacks[0](value);
      this.callbacks = null;
    }
  }

  reject(reason: unknown) {
    if (this.callbacks) {
      this.callbacks[1](reason);
      this.callbacks = null;
    }
  }

  wait() {
    return Waitable.waitForResultOrTimeout(this.promise);
  }

  reset() {
    this.promise = new Promise<T>((...args) => this.callbacks = args);
  }

  static async waitForResultOrTimeout<T>(promise: Promise<T>) {
    let timeoutId: NodeJS.Timeout = undefined!;
    const result = await Promise.race([
      promise,
      new Promise<typeof WAIT_TIMED_OUT>(resolve => timeoutId = setTimeout(() => resolve(WAIT_TIMED_OUT), TIMEOUT_IN_MILLISECONDS))
    ]);
    if (result === WAIT_TIMED_OUT) {
      throw new Error(`Waitable.wait() timed out after ${TIMEOUT_IN_SECONDS} seconds.`);
    }
    clearTimeout(timeoutId);
    return result;
  }
}
