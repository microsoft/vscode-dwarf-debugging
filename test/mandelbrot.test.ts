import * as assert from 'assert';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { join } from 'path';
import { pathToFileURL } from 'url';
import { IWasmWorker, spawn } from '../dist';

// This test with mandelbrot.wasm which was pulled from https://emscripten-dbg-stories.netlify.app/mandelbrot.html

describe('dwarf-debugging', () => {
  let s: IWasmWorker;

  beforeEach(() => {
    s = spawn({} as any);
  });

  afterEach(async () => {
    await s.dispose();
  });

  it('adds a module and reads sources', async () => {
    await s.rpc.sendMessage('hello', [], false);
    const r = await s.rpc.sendMessage('addRawModule', 'someId', '', {
      url: pathToFileURL(join(__dirname, 'mandelbrot.wasm')).toString(),
    });

    assert.ok(r instanceof Array, 'r is an array');
    assert.ok(
      r.some((r) => r.endsWith('libc.c')),
      'r has libc',
    );
  });

  describe('functionality', () => {
    let sources: string[];
    let mandelbrotcc: string;
    beforeEach(async () => {
      await s.rpc.sendMessage('hello', [], false);
      const r = await s.rpc.sendMessage('addRawModule', 'someId', '', {
        url: pathToFileURL(join(__dirname, 'mandelbrot.wasm')).toString(),
      });
      sources = r as string[];
      mandelbrotcc = sources.find((r) => r.endsWith('mandelbrot.cc'))!;
    });

    it('gets source lines', async () => {
      const lines = await s.rpc.sendMessage('getMappedLines', 'someId', mandelbrotcc);
      assert.deepStrictEqual(
        lines,
        [
          3, 5, 6, 9, 15, 16, 17, 18, 19, 20, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 39,
          40, 41, 46, 49,
        ],
      );
    });

    it('maps source -> raw location', async () => {
      const location = await s.rpc.sendMessage('sourceLocationToRawLocation', {
        rawModuleId: 'someId',
        sourceFileURL: mandelbrotcc,
        lineNumber: 9,
        columnNumber: -1,
      });

      assert.deepStrictEqual(location, [
        {
          rawModuleId: 'someId',
          startOffset: 436,
          endOffset: 502,
        },
      ]);
    });

    it('maps raw -> source location', async () => {
      const location = await s.rpc.sendMessage('rawLocationToSourceLocation', {
        rawModuleId: 'someId',
        codeOffset: 436,
        inlineFrameIndex: 0,
      });

      assert.deepStrictEqual(location, [
        {
          rawModuleId: 'someId',
          sourceFileURL: mandelbrotcc,
          lineNumber: 9,
          columnNumber: 30,
        },
      ]);
    });
  });
});
