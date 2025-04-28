// This file is based on a file from revision cf3a5c70b97b388fff3490b62f1bdaaa6a26f8e1 
// of the Chrome DevTools C/C++ Debugging Extension, see the wasm/symbols-backend/LICENSE file.
//
// https://github.com/ChromeDevTools/devtools-frontend/blob/main/extensions/cxx_debugging/src/ModuleConfiguration.ts

/**
 * Resolve a source path (as stored in DWARF debugging information) to an absolute URL.
 *
 * Note that we treat "." specially as a pattern, since LLDB normalizes paths before
 * returning them from the DWARF parser. Our logic replicates the logic found in the
 * LLDB frontend in `PathMappingList::RemapPath()` inside `Target/PathMappingList.cpp`
 * (http://cs/github/llvm/llvm-project/lldb/source/Target/PathMappingList.cpp?l=157-185).
 *
 * @param sourcePath the source path as found in the debugging information.
 * @param baseURL the URL of the WebAssembly module, which is used to resolve relative source paths.
 * @return an absolute `file:`-URI or a URL relative to the {@param baseURL}.
 */
export function resolveSourcePathToURL(sourcePath: string, baseURL: URL): URL {
  // Normalize '\' to '/' in sourcePath first.
  const resolvedSourcePath = sourcePath.replace(/\\/g, '/');

  try {
    if (resolvedSourcePath.startsWith('/')) {
      if (resolvedSourcePath.startsWith('//')) {
        return new URL(`file:${resolvedSourcePath}`);
      }
      return new URL(`file://${resolvedSourcePath}`);
    }
    if (/^[A-Z]:/i.test(resolvedSourcePath)) {
      return new URL(`file:/${resolvedSourcePath}`);
    }
    return new URL(resolvedSourcePath, baseURL.href);
  } catch (e) {
    if (e instanceof TypeError && 'code' in e && e.code === 'ERR_INVALID_URL') {
      return new URL(`file://${resolvedSourcePath.replace(/\/+/g, '/')}`);
    }
    throw e;
  }
}
