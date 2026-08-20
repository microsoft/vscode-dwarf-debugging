import { join } from 'path';
import { Worker } from 'worker_threads';
import { spawn as spawnProcess } from 'child_process';
import { readFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import {
  AsyncHostInterface,
  Channel,
  WorkerInterface,
  WorkerRPC,
} from './vendor/WorkerRPC';

export type * from './vendor/WorkerRPC';

/** Utility type to get the worker's return value from a method name. */
export type MethodReturn<T extends keyof WorkerInterface> = ReturnType<
  WorkerInterface[T]
> extends Promise<infer R>
  ? R
  : ReturnType<WorkerInterface[T]>;

export interface IWasmWorker {
  rpc: WorkerRPC<AsyncHostInterface, WorkerInterface>;
  dispose(): Promise<void>;
}

/**
 * Resolves the native symbolizer binary to use, if any, in precedence order:
 *   1. DWARF_NATIVE_SYMBOLIZER env var (explicit override, when it exists);
 *   2. the per-platform binary bundled in the package by scripts/build-native.mjs
 *      at dist/bin/<platform>-<arch>/SymbolsBackend[.exe] (this is what ships in
 *      the VSIX).
 * Returns undefined when no native binary is available, so spawn() falls back to
 * the WebAssembly worker.
 */
function resolveNativeBinary(): string | undefined {
  const fromEnv = process.env.DWARF_NATIVE_SYMBOLIZER;
  if (fromEnv && existsSync(fromEnv)) {
    return fromEnv;
  }
  const exeName = process.platform === 'win32' ? 'SymbolsBackend.exe' : 'SymbolsBackend';
  const bundled = join(__dirname, 'bin', `${process.platform}-${process.arch}`, exeName);
  if (existsSync(bundled)) {
    return bundled;
  }
  return undefined;
}

/**
 * Opt-in: when a native symbolizer binary is available (bundled per-platform, or
 * pointed at by DWARF_NATIVE_SYMBOLIZER), use it instead of the WebAssembly
 * worker. The native symbolizer is the same DWARF/C++ symbolizer (`lib/`) built
 * as a native binary rather than compiled to Wasm; it is functionally identical
 * but can be debugged directly by attaching a native debugger to the process.
 * Defaults to the WebAssembly worker.
 */
export function spawn(hostInterface: AsyncHostInterface): IWasmWorker {
  const nativePath = resolveNativeBinary();
  if (nativePath) {
    return spawnNative(nativePath, hostInterface);
  }


  // Fall back to the WebAssembly worker. It ships only when the extension was
  // built with the (optional) Wasm build (npm run build:wasm); if neither a
  // native binary nor worker.js is present, fail with an actionable message.
  const workerPath = join(__dirname, 'worker.js');
  if (!existsSync(workerPath)) {
    throw new Error(
      'No DWARF symbolizer backend available: neither a native SymbolsBackend ' +
        'binary (dist/bin/<platform>-<arch>/) nor the WebAssembly worker ' +
        '(worker.js) was found. Build one with `npm run build:native` or ' +
        '`npm run build:wasm`.',
    );
  }
  const worker = new Worker(workerPath);
  worker.on('message', (data) => channel.onmessage?.(new MessageEvent('message', { data })));

  const channel: Channel<AsyncHostInterface, WorkerInterface> = {
    onmessage: null,
    postMessage: (m) => worker.postMessage(m),
  };

  const rpc = new WorkerRPC<AsyncHostInterface, WorkerInterface>(channel, hostInterface);

  return {
    rpc,
    dispose: async () => {
      await worker.terminate();
    },
  };
}

/**
 * Native-backed worker: spawns the native symbolizer (with `--serve`) and bridges
 * its stdio (newline-delimited JSON frames) as a Channel, so the existing
 * WorkerRPC and the getWasm* host callbacks are reused unchanged. The native
 * process is synchronous internally, so, unlike the Wasm worker, it does not
 * use SharedArrayBuffer (which cannot cross a process boundary); state requests
 * are plain async messages. ArrayBuffers are carried as { __arraybuffer__ }
 * base64 markers since JSON cannot represent them.
 */
function spawnNative(exePath: string, hostInterface: AsyncHostInterface): IWasmWorker {
  // windowsHide avoids any console window when the GUI extension host spawns the
  // native process (which is also built as a GUI-subsystem exe on Windows).
  const child = spawnProcess(exePath, ['--serve'], {
    stdio: ['pipe', 'pipe', 'ignore'],
    windowsHide: true,
  });

  // Writes are chained so that fetching a module's bytes (async, below) cannot
  // reorder frames relative to later messages.
  let writeChain: Promise<void> = Promise.resolve();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const write = async (m: any): Promise<void> => {
    try {
      const req = m?.request;
      if (req?.method === 'addRawModule') {
        // js-debug delivers the module as { url } with no bytes and expects the
        // plugin to fetch it (the Wasm build fetches via emscripten). Fetch it
        // here so the native side simply consumes `code`.
        const rm = req.params?.[2];
        if (rm && typeof rm === 'object' && rm.url && !rm.code) {
          const code = await fetchModuleCode(rm.url);
          if (code) {
            rm.code = code; // ArrayBuffer -> { __arraybuffer__ } by serializeBuffers
          }
        }
      }
    } catch {
      /* forward as-is; the native side will report an unloadable module */
    }
    child.stdin!.write(JSON.stringify(serializeBuffers(m)) + '\n');
  };

  const channel: Channel<AsyncHostInterface, WorkerInterface> = {
    onmessage: null,
    postMessage: (m) => {
      writeChain = writeChain.then(() => write(m));
    },
  };

  let acc = '';
  child.stdout!.on('data', (d: Buffer) => {
    acc += d.toString('utf8');
    let nl: number;
    while ((nl = acc.indexOf('\n')) >= 0) {
      let line = acc.slice(0, nl);
      acc = acc.slice(nl + 1);
      if (line.endsWith('\r')) {
        line = line.slice(0, -1);
      }
      if (!line.trim()) {
        continue;
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let data: any;
      try {
        data = deserializeBuffers(JSON.parse(line));
      } catch {
        continue;
      }
      channel.onmessage?.(new MessageEvent('message', { data }));
    }
  });

  const rpc = new WorkerRPC<AsyncHostInterface, WorkerInterface>(channel, hostInterface);

  return {
    rpc,
    dispose: async () => {
      child.kill();
    },
  };
}

/** Fetches a module's bytes from a file:// or http(s):// url. */
async function fetchModuleCode(url: string): Promise<ArrayBuffer | undefined> {
  try {
    if (url.startsWith('file://')) {
      const b = readFileSync(fileURLToPath(url));
      return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
    }
    if (url.startsWith('http://') || url.startsWith('https://')) {
      const res = await fetch(url);
      if (!res.ok) {
        return undefined;
      }
      return await res.arrayBuffer();
    }
  } catch {
    /* ignore; native will report the module as unloadable */
  }
  return undefined;
}

// Deep-transform: JS ArrayBuffer/TypedArray -> { __arraybuffer__: base64 }, and
// BigInt (i64 WasmValues) -> decimal string (JSON cannot carry either).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function serializeBuffers(v: any): any {
  if (typeof v === 'bigint') {
    return v.toString();
  }
  if (v instanceof ArrayBuffer) {
    return { __arraybuffer__: Buffer.from(v).toString('base64') };
  }
  if (ArrayBuffer.isView(v)) {
    const view = v as ArrayBufferView;
    return {
      __arraybuffer__: Buffer.from(view.buffer, view.byteOffset, view.byteLength).toString('base64'),
    };
  }
  if (Array.isArray(v)) {
    return v.map(serializeBuffers);
  }
  if (v && typeof v === 'object') {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const o: any = {};
    for (const k of Object.keys(v)) {
      o[k] = serializeBuffers(v[k]);
    }
    return o;
  }
  return v;
}

// Deep-transform: { __arraybuffer__: base64 } -> ArrayBuffer.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function deserializeBuffers(v: any): any {
  if (v && typeof v === 'object' && !Array.isArray(v) && typeof v.__arraybuffer__ === 'string') {
    const b = Buffer.from(v.__arraybuffer__, 'base64');
    return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
  }
  if (Array.isArray(v)) {
    return v.map(deserializeBuffers);
  }
  if (v && typeof v === 'object') {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const o: any = {};
    for (const k of Object.keys(v)) {
      o[k] = deserializeBuffers(v[k]);
    }
    return o;
  }
  return v;
}
