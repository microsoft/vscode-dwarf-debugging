import { promises as fs } from 'fs';
import { fileURLToPath } from 'url';
import { parentPort } from 'worker_threads';
import { ResourceLoader } from './ResourceLoader';
import { RPCInterface } from './RPCInterface';
import {
  Channel,
  HostInterface,
  WorkerInterface,
} from './WorkerRPC';

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
    new ResourceLoader()
  );
}

/**
 * Allows global fetch to load local file URIs.
 *
 * This is quite a bit of a hack, but this is done in a worker_thread, so no one knows but us 🤫
 */
function enableFetchToLoadFileUris() {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (...args: Parameters<typeof fetch>) => {
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
      bytes: () => Promise.resolve(new Uint8Array(contents)),
      formData: () => {
        throw new Error("not implemented");
      },
      json: () => Promise.resolve(JSON.parse(contents.toString())),
      arrayBuffer: () => Promise.resolve(contents.buffer as ArrayBuffer)
    };

    return response;
  };
}
