import { spawn, StdioOptions } from 'child_process';
import * as path from 'path';

export interface EmscriptenModuleRunnerOptions {
  cwd?: string;
  stdio?: 'inherit' | 'ignore';
  imports?: string[];
  debuggerPort?: number;
}

export interface EmscriptenModuleRunner<T extends EmscriptenModule = EmscriptenModule> {
  run(callback?: (moduleFactory: EmscriptenModuleFactory<T>) => void): Promise<void>;
}

export const DEFAULT_EMSCRIPTEN_MODULE_RUNNER_CWD = `${__dirname}/../../wasm/symbols-backend.build/stage-2`;

export function createModuleRunner<T extends EmscriptenModule = EmscriptenModule>(modulePath: string, options: EmscriptenModuleRunnerOptions = {}): EmscriptenModuleRunner<T> {
  const { cwd = DEFAULT_EMSCRIPTEN_MODULE_RUNNER_CWD, stdio = 'ignore', imports = [], debuggerPort } = options;
  return {
    async run(callback = factory => factory()) {
      const argv = [
        ...(debuggerPort ? [`--inspect-brk=${debuggerPort}`, '--inspect-publish-uid=http'] : []),
        ...imports.flatMap(i => ['--import', i]),
        `${__dirname}/child-process.js`,
        path.resolve(cwd, modulePath),
        callback.toString()
      ];
      return spawnChildProcess(argv, stdio, cwd);
    }
  };
}

function spawnChildProcess(argv: string[], stdio: StdioOptions, cwd: string) {
  return new Promise<void>((resolve, reject) => spawn(process.execPath, argv, { stdio, cwd })
    .on('error', reject)
    .on('exit', (code, signal) => {
      if (signal) {
        reject(new Error(`Child process exited because of signal ${signal}.`));
      }
      else if (code !== 0) {
        reject(new Error(`Child process exited with code ${code}.`));
      }
      else {
        resolve();
      }
    })
  );
}
