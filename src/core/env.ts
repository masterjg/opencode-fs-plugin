/*
 * SPDX-License-Identifier: EPL-2.0
 * license-wizard managed-header v1 EPL-2.0 short 73897e75828f
 */

import { FsError } from "./errors.js";

/** POSIX-style environment variable names only; no `=` or NUL can occur. */
export const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Names the plugin owns, so a configuration cannot break resolution or sandboxing. */
export const MANAGED_ENV_NAMES: ReadonlySet<string> = new Set(["PATH", "TMPDIR"]);

/**
 * Validate an environment entry map and return its entries. The same rules
 * apply to the plugin `commandEnvVars` option, the per-invocation `envVars`
 * argument, and every entry parsed from a `commandEnvFiles` file; `label`
 * names the field or file in diagnostics.
 *
 * It is a closed object of environment-name keys to string values. Values are
 * never echoed in an error, because they may carry credentials. NUL bytes are
 * rejected because they cannot reach a child environment intact. `PATH` and
 * `TMPDIR` are rejected because `commandPaths` owns lookup/PATH and the tool
 * owns each child's private temp directory. Empty values are accepted and set
 * the variable to the empty string; they do not unset or remove it.
 */
export function resolveCommandEnvVars(
  raw: unknown,
  label = "commandEnvVars",
): Record<string, string> {
  if (raw === undefined) return {};
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new FsError(
      `${label} must be an object mapping environment variable names to string values.`,
      "invalid",
    );
  }

  const entries: Array<[string, string]> = [];
  for (const [name, value] of Object.entries(raw)) {
    if (!ENV_NAME.test(name)) {
      // Do not echo the supplied key: it can be malformed or carry sensitive text.
      throw new FsError(`${label} contains an invalid environment variable name.`, "invalid");
    }
    if (MANAGED_ENV_NAMES.has(name)) {
      throw new FsError(`${label} cannot set ${name}; the plugin manages it.`, "invalid");
    }
    if (typeof value !== "string") {
      throw new FsError(`${label}.${name} must be a string.`, "invalid");
    }
    if (value.includes("\0")) {
      throw new FsError(`${label}.${name} must not contain NUL bytes.`, "invalid");
    }
    entries.push([name, value]);
  }
  return Object.fromEntries(entries);
}
