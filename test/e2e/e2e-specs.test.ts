import assert from 'assert';
import fs from 'fs';
import yaml from 'js-yaml';
import { after, before, describe, it } from 'node:test';
import path from 'path';
import { Chrome } from '../../src/ExtensionAPI';
import DebuggerSession from '../../test-utils/DebuggerSession';
import { createModuleRunner } from '../../test-utils/emscripten-module-runner';

const DEBUGGER_PORT = 9231;
const TEST_SPECS_FOLDER = path.resolve(`${__dirname}/../../wasm/e2e`);
const TEST_BUILD_FOLDER = path.resolve(`${__dirname}/../../wasm/e2e.build`);

interface TestSpec {
  name: string;
  only?: boolean;
  skip?: boolean;
  source_file: string;
  use_dwo?: boolean;
  flags: string[][];
  script: {
    reason: string;
    file?: string;
    line?: number;
    actions?: {
      action: string;
      file?: string;
      breakpoint?: number;
    }[];
    variables?: {
      name: string;
      type?: string;
      value?: unknown;
    }[];
    evaluations?: {
      expression: string;
      value: unknown;
    }[];
  }[];
}

const testFiles = fs.readdirSync(TEST_SPECS_FOLDER)
  .filter(file => file.endsWith('.yaml'))
  .map(file => ({ file, test: loadTestSpecFile(path.join(TEST_SPECS_FOLDER, file)) }));

describe(`e2e specs (${TEST_SPECS_FOLDER})`, { only: testFiles.find(({ test }) => test.only)?.test.only }, () => {
  for (const { file, test } of testFiles) {
    const { name, only, skip, source_file, flags } = test;

    describe(`${name} (file: ${file}, source_file: ${source_file})`, { only, skip }, () => {
      for (let i = 0; i < flags.length; i++) {
        const outputName = testCaseOutputName(source_file, name, i);
        describe(`flags: ${flags[i].join(' ')}`, { only, skip }, async () => {
          let debuggerSession: DebuggerSession;
          let moduleExited: Promise<void>;
          let failed: boolean;
          before(async () => {
            const module = createModuleRunner(`${outputName}.js`, { debuggerPort: DEBUGGER_PORT, cwd: TEST_BUILD_FOLDER });
            moduleExited = module.run();
            debuggerSession = await DebuggerSession.attach(DEBUGGER_PORT, `${TEST_BUILD_FOLDER}/${outputName}.wasm`);
            failed = false;
          });
          defineTestCaseScript(
            test,
            (description, fn) => it(
              Object.entries(description)
                .filter(([, value]) => value !== undefined)
                .map(([key, value]) => `${key}: ${value}`)
                .join(', '),
              { only, skip },
              async context => {
                if (failed) {
                  context.skip();
                  return;
                }
                try {
                  await fn(debuggerSession);
                } catch (e) {
                  failed = true;
                  throw e;
                }
              }
            ),
          );
          after(async () => {
            await debuggerSession.dispose();
            await moduleExited;
          });
        });
      }
    });
  }
});

async function defineTestCaseScript(test: TestSpec, testCallback: (description: Record<string, unknown>, fn: (debuggerSession: DebuggerSession) => Promise<void>) => void) {

  let breakpoints: Map<string, string>;
  let isFirstStep: boolean;
  let isResumed: boolean;

  before(() => {
    breakpoints = new Map();
    isFirstStep = true;
    isResumed = true;
  });

  for (const { reason, file, line, variables = [], evaluations = [], actions = [] } of test.script) {
    testCallback({ reason, file, line }, async (debuggerSession) => {
      if (!isResumed) {
        await debuggerSession.resume();
      }
      const { hitBreakpoints, sourceFileURL = '<not mapped>', lineNumber } = await debuggerSession.waitForPaused();
      switch (reason) {
        case 'setup': {
          assert(isFirstStep, `Reason 'setup' must be first step.`);
          break;
        }
        case 'breakpoint': {
          const breakpointId = breakpoints.get(`${file}:${line}`);
          assert(breakpointId, 'Breakpoint not set.');
          assert(hitBreakpoints, `Paused because of reason: ${reason}`);
          assert(hitBreakpoints.includes(breakpointId), `Paused at other breakpoint: ${hitBreakpoints.join(', ')}`);
          break;
        }
        case 'step': {
          assert(reason === 'step', `Paused because of reason: ${reason}`);
          assert(sourceFileURL.endsWith(`/${file}`), `Paused in file: ${sourceFileURL}`);
          assert(lineNumber === line, `Paused at line: ${lineNumber}`);
          break;
        }
      }
      isFirstStep = false;
      isResumed = false;
    });

    for (const { name, type, value } of variables || []) {
      testCallback({ variable: name, type, value }, async (debuggerSession) => {
        const result = await getVariable(debuggerSession, name);
        assert(value === undefined || result.value === `${value}` || result.description === `${value}`, `Actual value: ${result.value}`);
        assert(type === undefined || result.description === type, `Actual type: '${result.description}'`);
      });
    }

    for (const { expression, value } of evaluations) {
      testCallback({ expression, value }, async (debuggerSession) => {
        const result = formatEvaluateResult(await debuggerSession.evaluate(expression));
        assert(result.value === `${value}`, `Actual value: ${result.value}`);
      });
    }

    for (const { action, breakpoint, file = path.basename(test.source_file) } of actions) {
      testCallback({ action, file, breakpoint }, async (debuggerSession) => {
        assert(!isResumed);
        switch (action) {
          case 'set_breakpoint': {
            assert(breakpoint, `No breakpoint specified.`);
            assert(!breakpoints.has(`${file}:${breakpoint}`), `Breakpoint is already set.`);
            const breakpointId = await debuggerSession.addBreakpoint(file, breakpoint);
            breakpoints.set(`${file}:${breakpoint}`, breakpointId);
            break;
          }
          case 'remove_breakpoint': {
            assert(breakpoint, `No breakpoint specified.`);
            const breakpointId = breakpoints.get(`${file}:${breakpoint}`);
            assert(breakpointId, `Breakpoint is not set at.`);
            await debuggerSession.removeBreakpoint(breakpointId);
            break;
          }
          case 'step_over': {
            await debuggerSession.stepOver();
            isResumed = true;
            break;
          }
          case 'step_into': {
            await debuggerSession.stepInto();
            isResumed = true;
            break;
          }
          case 'step_out': {
            await debuggerSession.stepOut();
            isResumed = true;
            break;
          }
        }
      });
    }
  }
}

function loadTestSpecFile(filePath: string): TestSpec {
  return yaml.load(fs.readFileSync(filePath, 'utf-8')) as TestSpec;
}

function testCaseOutputName(sourceFilePath: string, name: string, i: number) {
  return `${path.basename(sourceFilePath, path.extname(sourceFilePath))}__${name}_${i}`.replace(/[^0-9a-zA-Z]+/g, '_');
}

async function getVariable(debuggerSession: DebuggerSession, scopedPath: string) {
  const [scope, name, ...propertiesPath] = scopedPath.split('.');
  assert(scope && name, `Expected scope and variable name to be specified.`);

  const variableList = await debuggerSession.listVariablesInScope();
  assert(
    variableList.some(v => v.name === name && v.scope === scope.toUpperCase()),
    `Variable ${scope}.${name} does not exist, variables in scope: ${variableList.map(v => `${v.scope}.${v.name}`).join(', ')}`);

  let value = await debuggerSession.evaluate(name);
  let parent = `${scope}.${name}`;
  for (const name of propertiesPath) {
    assert(
      value &&
      'type' in value &&
      (value.type === 'object' || value.type === 'array') &&
      value.objectId,
      `Expected value for '${parent}' to be of type object.`,
    );

    const propertiesList = await debuggerSession.getProperties(value.objectId);
    const property = /^\$\d+$/.test(name)
      ? propertiesList[parseInt(name.slice(1))]
      : propertiesList.find(p => p.name === name);
    assert(property, `Property ${name} on ${parent} does not exist, available properties: ${propertiesList.map(p => p.name).join(', ')}`);

    value = property.value;
    parent = `${parent}.${name}`;
  }

  return formatEvaluateResult(value);
}

function formatEvaluateResult(result: Chrome.DevTools.RemoteObject | Chrome.DevTools.ForeignObject | null): { value: string, description?: string; } {
  if (result == null) {
    return { value: 'null' };
  }
  if ('type' in result && 'valueClass' in result) {
    return {
      value: `${result.valueClass}.${result.index}`,
      description: result.type
    };
  }
  return {
    value: `${result.value}`,
    description: result.description
  };
}

