import { parentPort } from 'worker_threads';

let signal, commandPort, instance;

parentPort.once('message', init);

async function init({ module, method, args, port, signalBuffer }) {
  signal = new Int32Array(signalBuffer);
  commandPort = port;

  try {
    instance = await loadModule(module)[method](...args);
  } catch (e) {
    commandPort.postMessage({ error: e });
    Atomics.notify(signal, 0);
    return;
  }

  commandPort.postMessage({});
  Atomics.notify(signal, 0);

  commandPort.on('message', invoke);
  parentPort.once('message', dispose);
}

async function invoke({ method, args }) {
  const response = {};
  try {
    response.result = await instance[method](...args);
  } catch (e) {
    response.error = e;
  }

  commandPort.postMessage(response);
  Atomics.notify(signal, 0);
}

function dispose() {
  commandPort.close();
  instance = null;
}

function loadModule(module) {
  const moduleExport = require(module);
  if (typeof moduleExport === 'function') {
    return moduleExport;
  }
  return moduleExport.default;
}
