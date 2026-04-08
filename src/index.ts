import { join } from 'path';
import { Worker } from 'worker_threads';
import {
  AsyncHostInterface,
  Channel,
  WorkerInterface,
  WorkerRPC,
} from './WorkerRPC';

export type * from './WorkerRPC';

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

export type WithOptionalMethods<T, P> = T | Pick<T, Exclude<keyof T, P>>;

export function spawn(hostInterface: WithOptionalMethods<AsyncHostInterface, 'reportResourceLoad'>): IWasmWorker {

  // The ms-vscode.js-debug extension currently invokes spawn without 
  // the reportResourceLoad method which causes the worker to fail.
  if (!('reportResourceLoad' in hostInterface)) {
    hostInterface = {
      ...hostInterface,
      async reportResourceLoad(_resourceUrl, _status) { }
    };
  }

  const worker = new Worker(join(__dirname, 'worker.js'));
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
