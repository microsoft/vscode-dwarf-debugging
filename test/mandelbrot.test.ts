import { describe, it, beforeEach, afterEach } from "node:test";
import { spawn, IWasmWorker } from "../dist";
import { pathToFileURL } from "url";
import { join } from "path";
import * as assert from "assert";

// This test with mandelbrot.wasm which was pulled from https://emscripten-dbg-stories.netlify.app/mandelbrot.html

describe("dwarf-debugging", () => {
  let s: IWasmWorker;

  beforeEach(() => {
    s = spawn({} as any);
  });

  afterEach(async () => {
    await s.dispose();
  });

  it("is sane", async () => {
    await s.rpc.sendMessage("hello", [], true);
  });

  describe("functionality", () => {
    beforeEach(async () => {
      await s.rpc.sendMessage("hello", [], true);
    });

    it("adds a module and reads sources", async () => {
      const r = await s.rpc.sendMessage("addRawModule", "someId", "", {
        url: pathToFileURL(join(__dirname, "mandelbrot.wasm")).toString(),
      });

      assert.ok(r instanceof Array, "r is an array");
      assert.ok(
        r.some((r) => r.endsWith("libc.c")),
        "r has libc"
      );
    });
  });
});
