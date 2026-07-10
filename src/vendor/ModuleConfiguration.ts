// Copyright 2023 The Chromium Authors
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.
//
// Vendored types from devtools-frontend
// extensions/cxx_debugging/src/ModuleConfiguration.ts. Only the type
// declarations that WorkerRPC.ts references are included here (the runtime
// helpers -- resolveSourcePathToURL / findModuleConfiguration / globMatch --
// are not needed by the native symbolizer path). See src/vendor/README.md.

/**
 * A path substitution specifies a string prefix pattern to be replaced with a
 * new string (the pendant of GDB's `set substitute-path` / LLDB's
 * `settings set target.source-map`).
 */
export interface PathSubstitution {
  readonly from: string;
  readonly to: string;
}

/** List of {@link PathSubstitution | PathSubstitutions}. */
export type PathSubstitutions = readonly PathSubstitution[];

/**
 * Configuration for locating source files for a given WebAssembly module. If the
 * name is `undefined`, it is the default configuration.
 */
export interface ModuleConfiguration {
  readonly name?: string;
  readonly pathSubstitutions: PathSubstitutions;
}

/** List of {@link ModuleConfiguration | ModuleConfigurations}. */
export type ModuleConfigurations = readonly ModuleConfiguration[];
