/*
 * SPDX-License-Identifier: EPL-2.0
 * license-wizard managed-header v1 EPL-2.0 short 73897e75828f
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Readable } from "node:stream";
import { Type, type Static } from "@sinclair/typebox";
import { errorMessage, FsError, fromErrno } from "../core/errors.js";
import { textResult, type ToolSpec } from "../core/types.js";

const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"] as const;

const Schema = Type.Object(
  {
    url: Type.String({ minLength: 1, description: "Absolute http:// or https:// URL." }),
    method: Type.Optional(
      Type.Union(
        METHODS.map((method) => Type.Literal(method)),
        { description: "HTTP method. Default: GET." },
      ),
    ),
    headers: Type.Optional(
      Type.Record(Type.String(), Type.String(), { description: "Request headers." }),
    ),
    body: Type.Optional(Type.String({ description: "Raw request body text." })),
    json: Type.Optional(
      Type.Unknown({ description: "JSON request body; sets content-type: application/json." }),
    ),
    output: Type.Optional(
      Type.String({ description: "Download the response body here, streamed to a temp file then renamed." }),
    ),
    checksum: Type.Optional(
      Type.String({
        description: "Expected checksum as `<md5|sha1|sha256|sha512>:<hex>`; bare hex means sha256.",
      }),
    ),
    maxBytes: Type.Optional(
      Type.Integer({ minimum: 1, description: "Maximum response body bytes. Default: unlimited." }),
    ),
    timeoutMs: Type.Optional(
      Type.Integer({ minimum: 100, maximum: 600_000, description: "Total request timeout. Default: 30000." }),
    ),
    failOnError: Type.Optional(
      Type.Boolean({ description: "Treat HTTP 4xx/5xx as an error. Default: true." }),
    ),
    followRedirects: Type.Optional(
      Type.Boolean({ description: "Follow 3xx redirects. Default: true." }),
    ),
    maxRedirects: Type.Optional(
      Type.Integer({ minimum: 0, maximum: 20, description: "Maximum redirects. Default: 10." }),
    ),
  },
  { additionalProperties: false },
);

type Input = Static<typeof Schema>;

type Algorithm = "md5" | "sha1" | "sha256" | "sha512";

interface Checksum {
  algorithm: Algorithm;
  digest: string;
}

export const httpRequestTool: ToolSpec<Input> = {
  name: "http_request",
  description:
    "Make an HTTP(S) request and either return the body or stream it to a file (`output`). " +
    "Supports methods, headers, a text or JSON body, redirects, timeouts, `maxBytes`, and " +
    "`checksum` verification. Usable as a `pipe` source.",
  schema: Schema,
  pipeable: "source",
  mutates: true,
  async run(ctx, input) {
    const url = parseUrl(input.url);
    if (input.body !== undefined && input.json !== undefined) {
      throw new FsError("body and json are mutually exclusive.", "invalid");
    }
    const method = input.method ?? "GET";
    if ((input.body !== undefined || input.json !== undefined) && (method === "GET" || method === "HEAD")) {
      throw new FsError(`${method} does not accept a request body.`, "invalid");
    }

    const headers: Record<string, string> = { ...(input.headers ?? {}) };
    let body: string | undefined = input.body;
    if (input.json !== undefined) {
      body = JSON.stringify(input.json);
      const hasContentType = Object.keys(headers).some((key) => key.toLowerCase() === "content-type");
      if (!hasContentType) headers["content-type"] = "application/json";
    }

    const timeoutMs = input.timeoutMs ?? 30_000;
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    const forwardAbort = () => controller.abort();
    ctx.signal.addEventListener("abort", forwardAbort, { once: true });
    const mapError = (error: unknown): FsError => {
      if (error instanceof FsError) return error;
      if (controller.signal.aborted) {
        return new FsError(
          timedOut ? `HTTP request timed out after ${timeoutMs} ms.` : "HTTP request aborted.",
          "interrupted",
        );
      }
      return new FsError(`HTTP request failed: ${errorMessage(error)}`, "io");
    };

    try {
      if (ctx.signal.aborted) throw new FsError("HTTP request aborted.", "interrupted");

      const { response, finalUrl } = await request(ctx, url, {
        method,
        headers,
        ...(body === undefined ? {} : { body }),
        followRedirects: input.followRedirects !== false,
        maxRedirects: input.maxRedirects ?? 10,
        signal: controller.signal,
        mapError,
      });

      const status = response.status;
      const manualRedirect =
        input.followRedirects === false && status >= 300 && status < 400;
      if (!response.ok && !manualRedirect && input.failOnError !== false) {
        const snippet = await readSnippet(response, 4096, mapError);
        const base = [`HTTP ${status}`, response.statusText, `for ${finalUrl}`].join(" ");
        throw new FsError(snippet.length > 0 ? `${base}: ${snippet}` : base, "io");
      }

      const checksum = input.checksum === undefined ? undefined : parseChecksum(input.checksum);
      const metadata = {
        url: finalUrl,
        status,
        statusText: response.statusText,
        headers: Object.fromEntries(response.headers.entries()),
        method,
        output: input.output ?? null,
      };

      if (input.output !== undefined) {
        const target = await ctx.sandbox.resolveForCreate(input.output);
        await ctx.permission.assert([{ target, boundary: target.full }]);
        const downloaded = await download(target.full, response, input.maxBytes, checksum, mapError);
        return textResult(
          `Downloaded ${downloaded.bytes} bytes to ${input.output}\n`,
          {
            ...metadata,
            bytes: downloaded.bytes,
            sha256: downloaded.sha256,
            checksum: downloaded.checksum,
          },
        );
      }

      const collected = await collectBody(response, input.maxBytes, checksum, mapError);
      return {
        stdout: collected.body,
        exitCode: 0,
        metadata: {
          ...metadata,
          bytes: collected.body.length,
          sha256: collected.sha256,
          checksum: collected.checksum,
        },
      };
    } catch (error) {
      throw mapError(error);
    } finally {
      clearTimeout(timer);
      ctx.signal.removeEventListener("abort", forwardAbort);
    }
  },
};

interface RequestOptions {
  method: string;
  headers: Record<string, string>;
  body?: string;
  followRedirects: boolean;
  maxRedirects: number;
  signal: AbortSignal;
  mapError: (error: unknown) => FsError;
}

async function request(
  ctx: Parameters<ToolSpec<Input>["run"]>[0],
  url: URL,
  options: RequestOptions,
): Promise<{ response: Response; finalUrl: string }> {
  const gate = ctx.permissionFor("fs_http_request");
  let current = url;
  let method = options.method;
  let body = options.body;

  for (let redirects = 0; ; redirects++) {
    await gate.assertTrusted([current.host]);
    const response = await fetch(current, {
      method,
      headers: options.headers,
      redirect: "manual",
      signal: options.signal,
      ...(body === undefined ? {} : { body }),
    }).catch((error: unknown) => {
      throw options.mapError(error);
    });

    if (!options.followRedirects) return { response, finalUrl: current.toString() };
    const location = response.headers.get("location");
    if (response.status < 300 || response.status >= 400 || location === null) {
      return { response, finalUrl: current.toString() };
    }
    if (redirects >= options.maxRedirects) {
      /* v8 ignore next -- a 3xx response always carries a body stream */
      await response.body?.cancel().catch(() => undefined);
      throw new FsError(`Too many redirects (max ${options.maxRedirects}).`, "io");
    }

    /* v8 ignore next -- a 3xx response always carries a body stream */
    await response.body?.cancel().catch(() => undefined);
    let next: URL;
    try {
      next = parseUrl(new URL(location, current).toString());
    } catch (error) {
      throw options.mapError(error);
    }
    current = next;
    if (response.status === 303 || ((response.status === 301 || response.status === 302) && method === "POST")) {
      method = "GET";
      body = undefined;
    }
  }
}

interface Collected {
  body: Buffer;
  sha256: string;
  checksum: string | undefined;
}

interface Downloaded extends Collected {
  bytes: number;
}

async function collectBody(
  response: Response,
  maxBytes: number | undefined,
  checksum: Checksum | undefined,
  mapError: (error: unknown) => FsError,
): Promise<Collected> {
  const chunks: Buffer[] = [];
  let total = 0;
  const hashers = makeHashers(checksum);
  for await (const chunk of bodyChunks(response, mapError)) {
    total += chunk.length;
    if (maxBytes !== undefined && total > maxBytes) {
      throw new FsError(`Response exceeded maxBytes (${maxBytes}).`, "invalid");
    }
    hashers.update(chunk);
    chunks.push(chunk);
  }
  return { body: Buffer.concat(chunks), ...hashers.digests() };
}

async function download(
  full: string,
  response: Response,
  maxBytes: number | undefined,
  checksum: Checksum | undefined,
  mapError: (error: unknown) => FsError,
): Promise<Downloaded> {
  const directory = path.dirname(full);
  const temp = path.join(
    directory,
    `.${path.basename(full)}.${crypto.randomBytes(6).toString("hex")}.part`,
  );
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  let bytes = 0;
  const hashers = makeHashers(checksum);
  try {
    handle = await fs.open(temp, "wx");
    for await (const chunk of bodyChunks(response, mapError)) {
      bytes += chunk.length;
      if (maxBytes !== undefined && bytes > maxBytes) {
        throw new FsError(`Response exceeded maxBytes (${maxBytes}).`, "invalid");
      }
      hashers.update(chunk);
      await handle.write(chunk);
    }
    await handle.close();
    handle = undefined;
    const digests = hashers.digests();
    await fs.rename(temp, full);
    return { body: Buffer.alloc(0), bytes, ...digests };
  } catch (error) {
    /* v8 ignore next -- cleanup failures must not mask the original error */
    await handle?.close().catch(() => undefined);
    /* v8 ignore next -- cleanup failures must not mask the original error */
    await fs.rm(temp, { force: true }).catch(() => undefined);
    if (error instanceof FsError) throw error;
    throw fromErrno(error);
  }
}

function makeHashers(checksum: Checksum | undefined): {
  update: (chunk: Buffer) => void;
  digests: () => { sha256: string; checksum: string | undefined };
} {
  const sha256 = crypto.createHash("sha256");
  const other =
    checksum === undefined || checksum.algorithm === "sha256"
      ? undefined
      : crypto.createHash(checksum.algorithm);
  return {
    update(chunk) {
      sha256.update(chunk);
      other?.update(chunk);
    },
    digests() {
      const sha256Hex = sha256.digest("hex");
      const actual = checksum === undefined ? undefined : other === undefined ? sha256Hex : other.digest("hex");
      if (checksum !== undefined && actual !== checksum.digest) {
        throw new FsError(
          `Checksum mismatch: expected ${checksum.algorithm}:${checksum.digest}, got ${checksum.algorithm}:${actual}.`,
          "checksum",
        );
      }
      return { sha256: sha256Hex, checksum: actual };
    },
  };
}

async function* bodyChunks(
  response: Response,
  mapError: (error: unknown) => FsError,
): AsyncGenerator<Buffer> {
  if (response.body === null) return;
  const stream = Readable.fromWeb(response.body as never);
  try {
    for await (const chunk of stream) {
      /* v8 ignore next -- Readable.fromWeb yields Buffers */
      yield Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    }
  } catch (error) {
    throw mapError(error);
  }
}

async function readSnippet(
  response: Response,
  limit: number,
  mapError: (error: unknown) => FsError,
): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of bodyChunks(response, mapError)) {
    chunks.push(chunk);
    total += chunk.length;
    if (total >= limit) break;
  }
  return Buffer.concat(chunks).subarray(0, limit).toString("utf8").trim();
}

function parseUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new FsError(`Invalid URL: "${value}".`, "invalid");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new FsError(`Unsupported URL scheme "${url.protocol}" (only http and https).`, "unsupported");
  }
  return url;
}

function parseChecksum(value: string): Checksum {
  const match = /^(?:(md5|sha1|sha256|sha512):)?([0-9a-fA-F]+)$/.exec(value.trim());
  if (match === null) {
    throw new FsError(`Invalid checksum: "${value}" (use <algorithm>:<hex>).`, "invalid");
  }
  return {
    algorithm: (match[1] ?? "sha256") as Algorithm,
    digest: (match[2] as string).toLowerCase(),
  };
}
