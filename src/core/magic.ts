/*
 * SPDX-License-Identifier: EPL-2.0
 * license-wizard managed-header v1 EPL-2.0 short 73897e75828f
 */

export interface FileType {
  readonly description: string;
  readonly mime: string;
}

const MAGIC: ReadonlyArray<{ readonly bytes: readonly number[]; readonly type: FileType }> = [
  { bytes: [0x7f, 0x45, 0x4c, 0x46], type: { description: "ELF executable", mime: "application/x-elf" } },
  { bytes: [0x89, 0x50, 0x4e, 0x47], type: { description: "PNG image data", mime: "image/png" } },
  { bytes: [0xff, 0xd8, 0xff], type: { description: "JPEG image data", mime: "image/jpeg" } },
  { bytes: [0x47, 0x49, 0x46, 0x38], type: { description: "GIF image data", mime: "image/gif" } },
  { bytes: [0x25, 0x50, 0x44, 0x46, 0x2d], type: { description: "PDF document", mime: "application/pdf" } },
  { bytes: [0x1f, 0x8b], type: { description: "gzip compressed data", mime: "application/gzip" } },
  { bytes: [0x42, 0x5a, 0x68], type: { description: "bzip2 compressed data", mime: "application/x-bzip2" } },
  { bytes: [0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00], type: { description: "XZ compressed data", mime: "application/x-xz" } },
  { bytes: [0x28, 0xb5, 0x2f, 0xfd], type: { description: "Zstandard compressed data", mime: "application/zstd" } },
  { bytes: [0x50, 0x4b, 0x03, 0x04], type: { description: "Zip archive data", mime: "application/zip" } },
  { bytes: [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c], type: { description: "7-zip archive data", mime: "application/x-7z-compressed" } },
  { bytes: [0x52, 0x61, 0x72, 0x21], type: { description: "RAR archive data", mime: "application/vnd.rar" } },
  { bytes: [0x53, 0x51, 0x4c, 0x69, 0x74, 0x65, 0x20, 0x66, 0x6f, 0x72, 0x6d, 0x61, 0x74, 0x20, 0x33, 0x00], type: { description: "SQLite 3 database", mime: "application/vnd.sqlite3" } },
  { bytes: [0x00, 0x61, 0x73, 0x6d], type: { description: "WebAssembly binary module", mime: "application/wasm" } },
  { bytes: [0x30, 0x37, 0x30, 0x37, 0x30, 0x31], type: { description: "ASCII cpio archive", mime: "application/x-cpio" } },
  { bytes: [0x21, 0x3c, 0x61, 0x72, 0x63, 0x68, 0x3e, 0x0a], type: { description: "current ar archive", mime: "application/x-ar" } },
  { bytes: [0x4d, 0x5a], type: { description: "PE executable", mime: "application/vnd.microsoft.portable-executable" } },
];

export function detectFileType(data: Buffer): FileType {
  if (data.length === 0) return { description: "empty", mime: "inode/x-empty" };
  for (const entry of MAGIC) {
    if (data.length >= entry.bytes.length && entry.bytes.every((byte, index) => data[index] === byte)) {
      return entry.type;
    }
  }
  if (data.length >= 262 && data.subarray(257, 262).toString("latin1") === "ustar") {
    return { description: "POSIX tar archive", mime: "application/x-tar" };
  }
  if (!data.includes(0)) {
    const text = data.toString("utf8");
    if (!text.includes("\uFFFD")) {
      const ascii = data.every((byte) => byte < 0x80);
      return ascii
        ? { description: "ASCII text", mime: "text/plain" }
        : { description: "UTF-8 Unicode text", mime: "text/plain; charset=utf-8" };
    }
  }
  return { description: "data", mime: "application/octet-stream" };
}
