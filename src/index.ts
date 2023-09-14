import { join } from "path";
import { Worker } from "worker_threads";
import {
  AsyncHostInterface,
  Channel,
  WorkerInterface,
  WorkerRPC,
} from "../chrome-cxx/mnt/extension/WorkerRPC";

export interface IWasmWorker {
  rpc: WorkerRPC<AsyncHostInterface, WorkerInterface>;
  dispose(): Promise<void>;
}

export function spawn(hostInterface: AsyncHostInterface): IWasmWorker {
  const worker = new Worker(join(__dirname, "worker.js"));
  worker.on("message", (data) =>
    channel.onmessage?.(new MessageEvent("message", { data }))
  );

  const channel: Channel<AsyncHostInterface, WorkerInterface> = {
    onmessage: null,
    postMessage: (m) => worker.postMessage(m),
  };

  const rpc = new WorkerRPC<AsyncHostInterface, WorkerInterface>(
    channel,
    hostInterface
  );

  return {
    rpc,
    dispose: async () => {
      await worker.terminate();
    },
  };
}
