const [moduleImportPath, callbackString] = process.argv.splice(2, 4);
const moduleImports = require(moduleImportPath);
const callback = eval(callbackString);

// See: https://github.com/emscripten-core/emscripten/issues/16742
global['Browser'] = { handledByPreloadPlugin: () => false };

callback(moduleImports);