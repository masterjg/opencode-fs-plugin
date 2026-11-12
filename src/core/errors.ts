/*
 * SPDX-License-Identifier: EPL-2.0
 * license-wizard managed-header v1 EPL-2.0 short 73897e75828f
 */

export type FsErrorCode =
  | "empty"
  | "invalid"
  | "unsupported"
  | "not-found"
  | "not-directory"
  | "not-file"
  | "not-empty"
  | "outside"
  | "access"
  | "exists"
  | "cross-device"
  | "archive"
  | "checksum"
  | "interrupted"
  | "busy"
  | "io";

/**
 * A domain failure that the model should see and can recover from. Permission
 * denials and unexpected programming errors are deliberately not converted to
 * this type; they must propagate as tool errors.
 */
export class FsError extends Error {
  readonly code: FsErrorCode;

  constructor(message: string, code: FsErrorCode) {
    super(message);
    this.name = "FsError";
    this.code = code;
  }
}

export function errnoCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const code = (error as NodeJS.ErrnoException).code;
  return typeof code === "string" ? code : undefined;
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return String(error);
}

export function isMissing(error: unknown): boolean {
  const code = errnoCode(error);
  return code === "ENOENT" || code === "ENOTDIR";
}

export function isPermission(error: unknown): boolean {
  const code = errnoCode(error);
  return code === "EACCES" || code === "EPERM";
}

export function fromErrno(error: unknown, fallback: FsErrorCode = "io"): FsError {
  const code = errnoCode(error);
  const message = errorMessage(error);
  if (code === "ENOENT" || code === "ENOTDIR" || code === "ESRCH") {
    return new FsError(message, "not-found");
  }
  if (code === "EACCES" || code === "EPERM") {
    return new FsError(message, "access");
  }
  if (code === "EEXIST") {
    return new FsError(message, "exists");
  }
  if (code === "ENOTEMPTY") {
    return new FsError(message, "not-empty");
  }
  if (code === "EXDEV") {
    return new FsError(message, "cross-device");
  }
  if (code === "EISDIR") {
    return new FsError(message, "not-file");
  }
  return new FsError(message, fallback);
}
