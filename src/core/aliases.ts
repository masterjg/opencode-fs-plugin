/*
 * SPDX-License-Identifier: EPL-2.0
 * license-wizard managed-header v1 EPL-2.0 short 73897e75828f
 */

import { FsError } from "./errors.js";

/** Accept a singular `path` wherever a tool normally takes `paths`. */
export function pathsFrom(input: { path?: string; paths?: string[] }): string[] | undefined {
  return input.paths ?? (input.path === undefined ? undefined : [input.path]);
}

export function requiredPaths(input: { path?: string; paths?: string[] }, tool: string): string[] {
  const paths = pathsFrom(input);
  if (paths === undefined || paths.length === 0) {
    throw new FsError(`${tool} needs paths: [...]`, "invalid");
  }
  return paths;
}

/** Accept a singular `source` wherever a tool normally takes `sources`. */
export function sourcesFrom(input: { source?: string; sources?: string[] }): string[] {
  return input.sources ?? (input.source === undefined ? [] : [input.source]);
}

/** Accept a singular `expression` beside the canonical `expressions` array. */
export function expressionsFrom(input: { expression?: string; expressions?: string[] }): string[] {
  return input.expressions ?? (input.expression === undefined ? [] : [input.expression]);
}

/** Accept `paths` as an alias for `files`; canonical `files` wins. */
export function filesFrom(input: { files?: string[]; path?: string; paths?: string[] }): string[] | undefined {
  return input.files ?? pathsFrom(input);
}

/** `mkdir` accepts one `path` or a `paths` array, but not both. */
export function directoryPaths(input: { path?: string; paths?: string[] }): string[] {
  if (input.path !== undefined && input.paths !== undefined) {
    throw new FsError("mkdir accepts path or paths, not both", "invalid");
  }
  const paths = pathsFrom(input);
  if (paths === undefined || paths.length === 0) {
    throw new FsError("mkdir needs path or paths", "invalid");
  }
  return paths;
}
