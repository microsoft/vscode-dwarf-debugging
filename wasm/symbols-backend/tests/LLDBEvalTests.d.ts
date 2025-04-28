// Copyright 2023 The Chromium Authors. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the wasm/symbols-backend/LICENSE file.

import type { Vector } from '../../../src/embind';

export interface Debugger {
  runToLine(line: string): void;
  evaluate(expr: string): EvalResult;
  exit(): void;
}

export interface EvalResult {
  error?: string;
  result?: string;
}

export interface LLDBEvalTestsModule extends EmscriptenModule {
  // eslint-disable-next-line @typescript-eslint/naming-convention
  StringArray: Vector<string>;
  runTests(dbg: Debugger, args: Vector<string>): number;
}

declare let loadModule: EmscriptenModuleFactory<LLDBEvalTestsModule>;
export default loadModule;
