// This file is based on a file from revision cf3a5c70b97b388fff3490b62f1bdaaa6a26f8e1 
// of the Chrome DevTools C/C++ Debugging Extension, see the wasm/symbols-backend/LICENSE file.
//
// https://github.com/ChromeDevTools/devtools-frontend/blob/main/extensions/cxx_debugging/tests/ModuleConfiguration_test.ts

import assert from 'assert';
import { describe, it } from 'node:test';

import { resolveSourcePathToURL } from '../src/PathUtils';

describe('PathUtils', () => {
  describe('resolveSourcePathToURL', () => {
    it('correctly resolves absolute paths', () => {
      const BASE_URL = new URL('http://localhost/file.wasm');
      assert.equal(resolveSourcePathToURL('/', BASE_URL).href, 'file:///');
      assert.equal(resolveSourcePathToURL('/usr/local', BASE_URL).href, 'file:///usr/local');
      assert.equal(resolveSourcePathToURL('/Users/Administrator', BASE_URL).href, 'file:///Users/Administrator');
      assert.equal(resolveSourcePathToURL('A:/', BASE_URL).href, 'file:///A:/');
      assert.equal(resolveSourcePathToURL('c:\\', BASE_URL).href, 'file:///c:/');
      assert.equal(
        resolveSourcePathToURL('c:\\Users\\Clippy\\Source', BASE_URL).href,
        'file:///c:/Users/Clippy/Source');
      assert.equal(
        resolveSourcePathToURL('\\\\network\\Server\\Source', BASE_URL).href,
        'file://network/Server/Source');
    });

    it('correctly resolves relative paths', () => {
      assert.equal(
        resolveSourcePathToURL('stdint.h', new URL('http://localhost/file.wasm')).href,
        'http://localhost/stdint.h');
      assert.equal(
        resolveSourcePathToURL('emscripten/include/iostream', new URL('http://localhost/dist/module.wasm')).href,
        'http://localhost/dist/emscripten/include/iostream');
      assert.equal(
        resolveSourcePathToURL('./src/main.cc', new URL('https://www.example.com/fast.wasm')).href,
        'https://www.example.com/src/main.cc');
      assert.equal(
        resolveSourcePathToURL('.\\Mein Projekt\\Datei.cpp', new URL('https://www.example.com/fast.wasm')).href,
        'https://www.example.com/Mein%20Projekt/Datei.cpp');
    });

    it('correctly resolves the sidecar Wasm module path', () => {
      // We use resolveSourcePathToURL() with an empty source
      // map to locate the debugging sidecar Wasm module.
      assert.equal(
        resolveSourcePathToURL('file.wasm.debug.wasm', new URL('http://localhost:8000/wasm/file.wasm')).href,
        'http://localhost:8000/wasm/file.wasm.debug.wasm');
      assert.equal(
        resolveSourcePathToURL('/usr/local/file.wasm.debug.wasm', new URL('http://localhost:8000/wasm/file.wasm')).href,
        'file:///usr/local/file.wasm.debug.wasm');
      assert.equal(
        resolveSourcePathToURL('f:\\netdrive\\file.wasm.debug.wasm', new URL('http://localhost:8000/wasm/file.wasm')).href,
        'file:///f:/netdrive/file.wasm.debug.wasm');
    });

    it('gracefully deals with invalid host names in URL as if it was a file on localhost instead', () => {
      const BASE_URL = new URL('http://web.dev/file.wasm');
      assert.equal(
        resolveSourcePathToURL('//v24.0/build/sysroot/wasi-libc-wasm32-wasip1/dlmalloc/include/unistd.h', BASE_URL).href,
        'file:///v24.0/build/sysroot/wasi-libc-wasm32-wasip1/dlmalloc/include/unistd.h');
    });
  });
});