// This file is based on a file from revision cf3a5c70b97b388fff3490b62f1bdaaa6a26f8e1 
// of the Chrome DevTools C/C++ Debugging Extension, see the wasm/symbols-backend/LICENSE file.
//
// https://github.com/ChromeDevTools/devtools-frontend/blob/main/extensions/cxx_debugging/tests/Interpreter_test.ts

import { Chrome } from '../src/ExtensionAPI';
import type { Debugger, EvalResult } from '../wasm/symbols-backend/tests/LLDBEvalTests';
import DebuggerSession from './DebuggerSession';
import { createModuleRunner, DEFAULT_EMSCRIPTEN_MODULE_RUNNER_CWD } from './emscripten-module-runner';
import { SyncInterface } from './sync-interface';

const TEST_BINARY_FILE = 'wasm/symbols-backend/third_party/lldb-eval/src/testdata/test_binary.cc';
const DEBUGGER_PORT = 9230;

export class LLDBEvalDebugger implements Debugger {
  debuggerSession: SyncInterface<DebuggerSession>;
  module = createModuleRunner('tests/inputs/lldb_eval_inputs.js', { debuggerPort: DEBUGGER_PORT });

  runToLine(line: string): void {
    this.module.run();
    this.debuggerSession = DebuggerSession.attachSync(
      DEBUGGER_PORT,
      `${DEFAULT_EMSCRIPTEN_MODULE_RUNNER_CWD}/tests/inputs/lldb_eval_inputs.wasm`,
      `${DEFAULT_EMSCRIPTEN_MODULE_RUNNER_CWD}/tests/inputs/lldb_eval_inputs.wasm.debug.wasm`,
    );

    this.debuggerSession.continueToLine(TEST_BINARY_FILE, line);
    this.debuggerSession.waitForPaused();
  }

  evaluate(expr: string): EvalResult {
    try {
      const resultObject = this.debuggerSession.evaluate(expr);
      if (!resultObject) {
        return { error: `Could not evaluate expression '${expr}'` };
      }
      const result = this.#stringify(resultObject);
      return { result };
    } catch (e) {
      return { error: `${e}` };
    }
  }

  exit(): void {
    this.debuggerSession.dispose();
  }

  #stringify(result: Chrome.DevTools.RemoteObject | Chrome.DevTools.ForeignObject): string {
    if (result.type === 'reftype') {
      return 'reftype';
    }
    if (result.objectId) {
      const properties = this.debuggerSession.getProperties(result.objectId);
      if (properties.length === 1) {
        const [{ name }] = properties;
        if (name.startsWith('0x')) {
          return `0x${name.substring(2).padStart(8, '0')}`;
        }
      }
    }
    if (result.description === 'std::nullptr_t') {
      return '0x00000000';
    }
    if (Object.is(result.value, -0)) {
      return '-0';
    }
    if (result.value === -Infinity) {
      return '-Inf';
    }
    if (result.value === Infinity) {
      return '+Inf';
    }

    return result.description ?? `${result.value}`;
  }
}

