// See: https://github.com/emscripten-core/emscripten/issues/16742
global['Browser'] = { handledByPreloadPlugin: () => false };
