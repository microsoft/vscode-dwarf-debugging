// This file is based on a file from revision cf3a5c70b97b388fff3490b62f1bdaaa6a26f8e1 
// of the Chrome DevTools C/C++ Debugging Extension, see the wasm/symbols-backend/LICENSE file.
//
// https://github.com/ChromeDevTools/devtools-frontend/blob/main/extensions/cxx_debugging/tests/SymbolsBackend_test.ts

import assert from 'assert';
import { describe, it } from 'node:test';
import { createModuleRunner } from '../test-utils/emscripten-module-runner';
import type { SymbolsBackendTestsModule } from '../wasm/symbols-backend/tests/SymbolsBackendTests';

type ResponseWithError = { error?: { code: string; message: string; }; };

function okReponse<T extends ResponseWithError>(response: T) {
  if (response.error) {
    assert.fail(`Expect succesfull response, got ${response.error.code}: ${response.error.message}`);
  }
  return response;
}

describe('SymbolsBackend', () => {

  it('runs WebAssembly test suite', async () => {
    const moduleRunner = createModuleRunner<SymbolsBackendTestsModule>('tests/SymbolsBackendTests.js', { stdio: 'inherit' });

    await moduleRunner.run(createModule => createModule({
      // @ts-expect-error
      preRun({ FS }: SymbolsBackendTestsModule) {
        FS.mkdir('tests');
        FS.mkdir('tests/inputs');
        FS.mkdir('cxx_debugging');
        FS.mkdir('cxx_debugging/tests');
        FS.mkdir('cxx_debugging/tests/inputs');
        ['hello.s.wasm',
          'windows_paths.s.wasm',
          'globals.s.wasm',
          'classstatic.s.wasm',
          'namespaces.s.wasm',
          'shadowing.s.wasm',
          'inline.s.wasm',
        ]
          .forEach(
            name => FS.createPreloadedFile(
              'cxx_debugging/tests/inputs', name, `tests/inputs/${name}`, true, false));
        ['split-dwarf.s.dwo',
          'split-dwarf.s.wasm',
        ].forEach(name => FS.createPreloadedFile('tests/inputs', name, `tests/inputs/${name}`, true, false));
      }
    }));
  });
});
