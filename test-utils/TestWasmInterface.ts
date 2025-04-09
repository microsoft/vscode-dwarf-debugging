// This file is based on a file from revision cf3a5c70b97b388fff3490b62f1bdaaa6a26f8e1 
// of the Chrome DevTools C/C++ Debugging Extension, see the wasm/symbols-backend/LICENSE file.
//
// https://github.com/ChromeDevTools/devtools-frontend/blob/main/extensions/cxx_debugging/tests/TestUtils.ts

import type { WasmInterface } from '../src/CustomFormatters';
import type { WasmValue } from '../src/WasmTypes';

export default class TestWasmInterface implements WasmInterface {
  memory = new ArrayBuffer(0);
  locals = new Map<number, WasmValue>();
  globals = new Map<number, WasmValue>();
  stack = new Map<number, WasmValue>();

  readMemory(offset: number, length: number): Uint8Array<ArrayBuffer> {
    return new Uint8Array(this.memory, offset, length);
  }
  getOp(op: number): WasmValue {
    const val = this.stack.get(op);
    if (val !== undefined) {
      return val;
    }
    throw new Error(`No stack entry ${op}`);
  }
  getLocal(local: number): WasmValue {
    const val = this.locals.get(local);
    if (val !== undefined) {
      return val;
    }
    throw new Error(`No local ${local}`);
  }
  getGlobal(global: number): WasmValue {
    const val = this.globals.get(global);
    if (val !== undefined) {
      return val;
    }
    throw new Error(`No global ${global}`);
  }
}
