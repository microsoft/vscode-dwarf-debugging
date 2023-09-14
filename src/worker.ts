import { promises as fs } from "fs";
import { join } from "path";
import { fileURLToPath } from "url";
import { parentPort } from "worker_threads";
import { RPCInterface } from "../chrome-cxx/mnt/extension/DevToolsPluginWorker";
import { ResourceLoader } from "../chrome-cxx/mnt/extension/MEMFSResourceLoader";
import {
  Channel,
  HostInterface,
  WorkerInterface,
} from "../chrome-cxx/mnt/extension/WorkerRPC";

enableFetchToLoadFileUris();
init();

/**
 * Starts the worker process.
 */
function init() {
  if (!parentPort) {
    throw new Error("this script must be imported as a worker thread");
  }

  const channel: Channel<WorkerInterface, HostInterface> = {
    onmessage: null,
    postMessage: (m) => parentPort!.postMessage(m),
  };

  parentPort.on("message", (data) =>
    channel.onmessage?.(new MessageEvent("message", { data }))
  );

  new RPCInterface(
    channel,
    new (class extends ResourceLoader {
      protected override getModuleFileName(rawModuleId: string): string {
        // same logic as the parent method, but btoa doesn't exist in node
        return `${Buffer.from(rawModuleId).toString("base64")}.wasm`.replace(
          /\//g,
          "_"
        );
      }

      override async createSymbolsBackendModulePromise(): Promise<WebAssembly.Module> {
        const file = await fs.readFile(join(__dirname, "SymbolsBackend.wasm"));
        return WebAssembly.compile(file);
      }
    })()
  );
}

/**
 * Allows global fetch to load local file URIs.
 *
 * This is quite a bit of a hack, but this is done in a worker_thread, so no one knows but us 🤫
 */
function enableFetchToLoadFileUris() {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (...args) => {
    const url = args[0];
    if (typeof url !== "string" || !url.startsWith("file:///")) {
      return originalFetch(...args);
    }

    let found = true;
    let contents: Buffer;
    try {
      contents = await fs.readFile(fileURLToPath(url));
    } catch (e) {
      const cast = e as Error;
      found = false;
      contents = Buffer.from(cast.stack || cast.message);
    }

    const response: Response = {
      url,
      ok: found,
      status: found ? 200 : 404,
      statusText: found ? "OK" : "Not found",
      bodyUsed: false,
      redirected: false,
      headers: new Headers(),
      body: null,
      type: "default",
      clone() {
        return this;
      },
      text: () => Promise.resolve(contents.toString()),
      blob: () => {
        throw new Error("not implemented");
      },
      formData: () => {
        throw new Error("not implemented");
      },
      json: () => Promise.resolve(JSON.parse(contents.toString())),
      arrayBuffer: () => Promise.resolve(contents),
    };

    return response;
  };
}
