const [moduleImportPath, callbackString] = process.argv.splice(2, 4);
const moduleImports = require(moduleImportPath);
const callback = eval(callbackString);

require('./prelude');

callback(moduleImports);
