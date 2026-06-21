import assert from 'assert';
import { MessageChannel, receiveMessageOnPort, Worker } from 'worker_threads';

const TIMEOUT_IN_MILLISECONDS = 30000;

export type SyncInterface<T> = {
  [P in keyof T]: T[P] extends (...args: infer A) => Promise<infer R> ? ((...args: A) => R) : T[P];
};

export function createSyncInterface(module: string, method: string, ...args: any[]) {
  const worker = new Worker(`${__dirname}/worker.js`);
  const signal = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
  const { port1: localPort, port2: remotePort } = new MessageChannel();

  worker.postMessage({ module, method, args, port: remotePort, signalBuffer: signal.buffer }, [remotePort]);
  waitForResponse();

  return {
    invoke(method: string, ...args: any[]): any {
      localPort.postMessage({ method, args });
      return waitForResponse();
    },
    dispose(): void {
      worker.unref();
      worker.postMessage({});
    }
  };

  function waitForResponse() {
    const waitResult = Atomics.wait(signal, 0, 0, TIMEOUT_IN_MILLISECONDS);
    assert(waitResult !== 'timed-out', `Synchronized worker command timed out`);

    const response = receiveMessageOnPort(localPort);
    assert(response !== undefined, 'Synchronized worker command received no response');

    const { result, error } = response.message;
    if (error) {
      throw error;
    }

    return result;
  }
}
