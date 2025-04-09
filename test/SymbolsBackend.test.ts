// This file is based on a file from revision cf3a5c70b97b388fff3490b62f1bdaaa6a26f8e1 
// of the Chrome DevTools C/C++ Debugging Extension, see the wasm/symbols-backend/LICENSE file.
//
// https://github.com/ChromeDevTools/devtools-frontend/blob/main/extensions/cxx_debugging/tests/SymbolsBackend_test.ts

import createModule, {type SymbolsBackendTestsModule} from './SymbolsBackendTests.js';

describe('SymbolsBackend', () => {
  it('should work', async () => {
    await createModule({
      onExit(status: number) {
        if (status !== 0) {
          throw new Error(`Unittests failed (return code ${status})`);
        }
      },
      // @ts-expect-error
      preRun({FS}: SymbolsBackendTestsModule) {  // eslint-disable-line @typescript-eslint/naming-convention
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
                    'cxx_debugging/tests/inputs', name, `build/tests/inputs/${name}`, true, false));
        ['split-dwarf.s.dwo',
         'split-dwarf.s.wasm',
        ].forEach(name => FS.createPreloadedFile('tests/inputs', name, `build/tests/inputs/${name}`, true, false));
      },
    });
  });
});
