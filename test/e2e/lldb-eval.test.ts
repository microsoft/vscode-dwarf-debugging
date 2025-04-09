// This file is based on a file from revision cf3a5c70b97b388fff3490b62f1bdaaa6a26f8e1 
// of the Chrome DevTools C/C++ Debugging Extension, see the wasm/symbols-backend/LICENSE file.
//
// https://github.com/ChromeDevTools/devtools-frontend/blob/main/extensions/cxx_debugging/tests/Interpreter_test.ts

import assert from 'assert';
import { describe, it } from 'node:test';
import { Chrome } from '../../src/ExtensionAPI';
import DebuggerSession from '../../test-utils/DebuggerSession';
import { createModuleRunner, DEFAULT_EMSCRIPTEN_MODULE_RUNNER_CWD } from '../../test-utils/emscripten-module-runner';
import type { LLDBEvalTestsModule } from '../../wasm/symbols-backend/tests/LLDBEvalTests';

const DEBUGGER_PORT = 9232;
const ADDRESSES_FILE = 'wasm/symbols-backend/tests/inputs/addresses.cc';

describe('lldb-eval', () => {

  it('runs WebAssembly test suite', async () => {

    const module = createModuleRunner<LLDBEvalTestsModule>('tests/LLDBEvalTests.js', { imports: ['tsx'], stdio: 'inherit' });

    await module.run(async loadModule => {
      // We are executing from 'test-utils/emscripten-module-runner/child-process.js' so we need to adjust the paths accordingly
      const { LLDBEvalDebugger } = require('../../test-utils/LLDBEvalDebugger') as typeof import('../../test-utils/LLDBEvalDebugger');
      const lldbEval = await loadModule();
      const debug = new LLDBEvalDebugger();

      const argv = new lldbEval.StringArray();
      try {
        const skippedTests = [
          'EvalTest.TestTemplateTypes',
          'EvalTest.TestUnscopedEnumNegation',
          'EvalTest.TestUniquePtrDeref',
          'EvalTest.TestUniquePtrCompare',
        ];
        argv.push_back(`--gtest_filter=-${skippedTests.join(':')}`);

        const exitCode = await lldbEval.runTests(debug, argv);
        if (exitCode !== 0) {
          throw new Error('gtest test suite failed');
        }
      } finally {
        argv.delete();
      }
    });
  });

  it('can do basic arithmetic.', async () => {

    const module = createModuleRunner<LLDBEvalTestsModule>('tests/inputs/addresses_main.js', { imports: ['tsx'], debuggerPort: DEBUGGER_PORT });
    const moduleExited = module.run();

    const debuggerSession = await DebuggerSession.attach(
      DEBUGGER_PORT,
      `${DEFAULT_EMSCRIPTEN_MODULE_RUNNER_CWD}/tests/inputs/addresses_main.wasm`,
      `${DEFAULT_EMSCRIPTEN_MODULE_RUNNER_CWD}/tests/inputs/addresses_main.wasm.debug.wasm`,
    );
    try {

      await debuggerSession.continueToLine(ADDRESSES_FILE, '// BREAK(ArrayMembersTest)');
      await debuggerSession.waitForPaused();

      const variables = await debuggerSession.listVariablesInScope();
      assert.deepEqual(variables.map(v => v.name).sort(), ['n', 'sum', 'x']);

      {
        const { value } = remoteObject(await debuggerSession.evaluate('n + sum'));
        assert.equal(value, 55);
      }
      {
        const { value } =
          remoteObject(await debuggerSession.evaluate('(wchar_t)0x41414141'));
        assert.equal(value, 'U+41414141');
      }
      {
        const { value } =
          remoteObject(await debuggerSession.evaluate('(char16_t)0x4141'));
        assert.equal(value, '䅁');
      }
      {
        const { value } =
          remoteObject(await debuggerSession.evaluate('(char32_t)0x41414141'));
        assert.equal(value, 'U+41414141');
      }
      {
        const { value } =
          remoteObject(await debuggerSession.evaluate('(char32_t)0x4141'));
        assert.equal(value, '䅁');
      }
    } finally {
      await debuggerSession.dispose();
      await moduleExited;
    }
  });
});

export function remoteObject(value: Chrome.DevTools.RemoteObject | Chrome.DevTools.ForeignObject | null): Chrome.DevTools.RemoteObject {
  assert(value);
  assert(value.type !== 'reftype');
  return value;
}
