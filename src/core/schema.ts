/*
 * SPDX-License-Identifier: EPL-2.0
 * license-wizard managed-header v1 EPL-2.0 short 73897e75828f
 */

import { Value } from "@sinclair/typebox/value";
import type { TSchema } from "@sinclair/typebox";
import { FsError } from "./errors.js";

export function parseSchema<T>(schema: TSchema, input: unknown, label = "input"): T {
  if (!Value.Check(schema, input)) {
    const first = Value.Errors(schema, input).First();
    const detail = first ? `${first.path || "/"}: ${first.message}` : "invalid value";
    throw new FsError(`Invalid ${label}: ${detail}`, "invalid");
  }
  return input as T;
}
