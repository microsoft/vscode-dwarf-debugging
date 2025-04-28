// This file is based on a file from revision cf3a5c70b97b388fff3490b62f1bdaaa6a26f8e1 
// of the Chrome DevTools C/C++ Debugging Extension, see the wasm/symbols-backend/LICENSE file.
//
// https://github.com/ChromeDevTools/devtools-frontend/blob/main/extensions/cxx_debugging/tests/SymbolsBackend_test.ts

import assert from 'assert';
import { describe, it } from 'node:test';
import { createModuleRunner } from '../test-utils/emscripten-module-runner';
import SymbolsBackendPlugin from '../test-utils/SymbolsBackendPlugin';
import TestWasmInterface from '../test-utils/TestWasmInterface';
import type { SymbolsBackendTestsModule } from '../wasm/symbols-backend/tests/SymbolsBackendTests';

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

  it('parses rust variant part types', async () => {
    const plugin = SymbolsBackendPlugin.create(`${__dirname}/../wasm/e2e.build/app_Rust_application_0.wasm`);
    try {
      okReponse(plugin.AddRawModule('1', 'app_Rust_application_0.wasm'));

      const { rawLocationRanges: [{ startOffset: codeOffset }] } = okReponse(plugin.SourceLocationToRawLocation('1', 'app.rs', 31, -1));

      const debuggerProxy = new TestWasmInterface();
      debuggerProxy.memory = new SharedArrayBuffer(32);
      debuggerProxy.locals.set(2, { type: 'i32', value: 4 });

      const { root: animalType, typeInfos } = okReponse(
        plugin.EvaluateExpression(
          { rawModuleId: '1', codeOffset, inlineFrameIndex: 0 },
          'a',
          debuggerProxy,
        )
      );

      assert.equal(animalType.typeNames[0], 'app::Animal');
      assert.equal(animalType.size, 24);

      assert(animalType.extendedInfo);
      assert.equal(animalType.extendedInfo.variantParts.length, 1);
      assert(animalType.extendedInfo.variantParts[0].discriminatorMember);
      assert.equal(animalType.extendedInfo.variantParts[0].variants.length, 2);

      const dogType = animalType.extendedInfo.variantParts[0].variants[0].members[0];
      assert(dogType);
      assert.equal(dogType.name, 'Dog');
      assert.equal(typeInfos.find(i => i.typeId === dogType.typeId)?.typeNames[0], 'app::Animal::Dog');

      const catType = animalType.extendedInfo.variantParts[0].variants[1].members[0];
      assert(catType);
      assert.equal(catType.name, 'Cat');
      assert.equal(typeInfos.find(i => i.typeId === catType.typeId)?.typeNames[0], 'app::Animal::Cat');
    } finally {
      plugin.delete();
    }
  });

  it('parses rust template parameter types', async () => {
    const plugin = SymbolsBackendPlugin.create(`${__dirname}/../wasm/e2e.build/app_Rust_application_0.wasm`);
    try {
      okReponse(plugin.AddRawModule('1', 'app_Rust_application_0.wasm'));

      const { rawLocationRanges: [{ startOffset: codeOffset }] } = okReponse(plugin.SourceLocationToRawLocation('1', 'app.rs', 35, -1));

      const debuggerProxy = new TestWasmInterface();
      debuggerProxy.memory = new SharedArrayBuffer(32);
      debuggerProxy.locals.set(2, { type: 'i32', value: 4 });

      const { root: vectorType, typeInfos } = okReponse(
        plugin.EvaluateExpression(
          { rawModuleId: '1', codeOffset, inlineFrameIndex: 0 },
          'vector',
          debuggerProxy,
        )
      );

      assert.equal(vectorType.typeNames[0], 'alloc::vec::Vec<int, alloc::alloc::Global>');
      assert.equal(vectorType.size, 12);

      assert(vectorType.extendedInfo);
      assert.equal(vectorType.extendedInfo.templateParameters.length, 2);

      const intType = vectorType.extendedInfo.templateParameters[0];
      assert(intType);
      assert.equal(typeInfos.find(i => i.typeId === intType.typeId)?.typeNames[0], 'int');

      const globalAllocType = vectorType.extendedInfo.templateParameters[1];
      assert(globalAllocType);
      assert.equal(typeInfos.find(i => i.typeId === globalAllocType.typeId)?.typeNames[0], 'alloc::alloc::Global');
    } finally {
      plugin.delete();
    }
  });
});

type ResponseWithError = { error?: { code: string; message: string; }; };

function okReponse<T extends ResponseWithError>(response: T) {
  if (response.error) {
    assert.fail(`Expect succesfull response, got ${response.error.code}: ${response.error.message}`);
  }
  return response;
}