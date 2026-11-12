/*
 * SPDX-License-Identifier: EPL-2.0
 * license-wizard managed-header v1 EPL-2.0 short 73897e75828f
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import * as path from "node:path";
import type { FsError } from "../../src/core/errors.js";
import { Sandbox } from "../../src/core/sandbox.js";
import { httpRequestTool } from "../../src/tools/http_request.js";
import { pipeTool } from "../../src/tools/pipe.js";
import { makeRoot, runSpec } from "../helpers.js";

let server: Server;
let base: string;
const bodies = new Map<string, string>();

const roots: string[] = [];
const cleanups: Array<() => void> = [];

beforeAll(async () => {
  server = createServer((request, response) => {
    route(request, response);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no server address");
  base = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
});

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
  bodies.clear();
});

function route(request: IncomingMessage, response: ServerResponse): void {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  switch (url.pathname) {
    case "/text":
      response.writeHead(200, { "content-type": "text/plain", "x-test": "yes" });
      response.end("hello world\n");
      return;
    case "/json":
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true }));
      return;
    case "/binary":
      response.writeHead(200, { "content-type": "application/octet-stream" });
      response.end(Buffer.from([0x00, 0x01, 0xff, 0xfe]));
      return;
    case "/redirect":
      response.writeHead(302, { location: "/text" });
      response.end();
      return;
    case "/redirect-303":
      response.writeHead(303, { location: "/text" });
      response.end();
      return;
    case "/loop":
      response.writeHead(302, { location: "/loop" });
      response.end();
      return;
    case "/bad-scheme":
      response.writeHead(302, { location: "ftp://example.com/file" });
      response.end();
      return;
    case "/notfound":
      response.writeHead(404, { "content-type": "text/plain" });
      response.end("nope\n");
      return;
    case "/notfound-empty":
      response.writeHead(404);
      response.end();
      return;
    case "/notfound-big":
      response.writeHead(404, { "content-type": "text/plain" });
      response.end("x".repeat(5000));
      return;
    case "/broken":
      response.writeHead(200, { "content-type": "text/plain", "content-length": "100" });
      response.flushHeaders();
      response.write("partial");
      setTimeout(() => response.destroy(), 20);
      return;
    case "/big":
      response.writeHead(200, { "content-type": "text/plain" });
      response.end("0123456789".repeat(10));
      return;
    case "/echo": {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        bodies.set("echo", Buffer.concat(chunks).toString("utf8"));
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            method: request.method,
            body: bodies.get("echo"),
            contentType: request.headers["content-type"] ?? null,
          }),
        );
      });
      return;
    }
    case "/slow":
      setTimeout(() => {
        response.writeHead(200, { "content-type": "text/plain" });
        response.end("slow\n");
      }, 400);
      return;
    default:
      response.writeHead(200, { "content-type": "text/plain" });
      response.end("head\n");
  }
}

async function setup() {
  const root = await makeRoot("fs-http-request-");
  roots.push(root);
  return { root, sb: await Sandbox.create(root) };
}

async function run(input: Record<string, unknown>) {
  const { root, sb } = await setup();
  const result = await runSpec(httpRequestTool, input, sb);
  return { root, ...result };
}

describe("http_request", () => {
  it("fetches text, json and binary bodies", async () => {
    const text = await run({ url: `${base}/text` });
    expect(text.result.stdout.toString()).toBe("hello world\n");
    expect(text.result.metadata).toMatchObject({
      status: 200,
      url: `${base}/text`,
      bytes: 12,
      output: null,
    });
    expect((text.result.metadata.headers as Record<string, string>)["x-test"]).toBe("yes");
    expect(text.requests[0]).toMatchObject({
      action: "fs_http_request",
      resources: [new URL(base).host],
    });

    const json = await run({ url: `${base}/json` });
    expect(JSON.parse(json.result.stdout.toString())).toEqual({ ok: true });

    const binary = await run({ url: `${base}/binary` });
    expect([...binary.result.stdout]).toEqual([0x00, 0x01, 0xff, 0xfe]);
    expect(binary.result.metadata.sha256).toBe(
      crypto.createHash("sha256").update(Buffer.from([0x00, 0x01, 0xff, 0xfe])).digest("hex"),
    );
  });

  it("downloads to a file atomically with checksum verification", async () => {
    const digest = crypto.createHash("sha256").update("hello world\n").digest("hex");
    const { root, sb } = await setup();
    await fs.mkdir(path.join(root, "downloads"));
    const download = await runSpec(
      httpRequestTool,
      { url: `${base}/text`, output: "downloads/text.txt", checksum: `sha256:${digest}` },
      sb,
    );
    expect(download.result.stdout.toString()).toContain("Downloaded 12 bytes");
    expect(await fs.readFile(path.join(root, "downloads/text.txt"), "utf8")).toBe("hello world\n");
    expect(download.result.metadata).toMatchObject({ bytes: 12, sha256: digest });

    const bare = await runSpec(
      httpRequestTool,
      { url: `${base}/text`, output: "bare.txt", checksum: digest },
      sb,
    );
    expect(bare.result.metadata.checksum).toBe(digest);
    expect(await fs.readFile(path.join(root, "bare.txt"), "utf8")).toBe("hello world\n");

    const md5 = crypto.createHash("md5").update("hello world\n").digest("hex");
    const other = await runSpec(
      httpRequestTool,
      { url: `${base}/text`, output: "md5.txt", checksum: `md5:${md5}` },
      sb,
    );
    expect(other.result.metadata.checksum).toBe(md5);

    await expect(
      runSpec(
        httpRequestTool,
        { url: `${base}/text`, output: "mismatch.txt", checksum: "sha256:deadbeef" },
        sb,
      ),
    ).rejects.toMatchObject({ code: "checksum" });
    expect(await fs.readdir(root)).not.toContain("mismatch.txt");
  });

  it("leaves no temp files behind when a download fails", async () => {
    const { root, sb } = await setup();
    await fs.mkdir(path.join(root, "out"));
    await expect(
      runSpec(
        httpRequestTool,
        { url: `${base}/big`, output: "out/big.txt", maxBytes: 5 },
        sb,
      ),
    ).rejects.toMatchObject({ code: "invalid" });
    expect(await fs.readdir(path.join(root, "out"))).toEqual([]);
  });

  it("follows redirects, rewrites 303, and bounds redirect loops", async () => {
    const followed = await run({ url: `${base}/redirect` });
    expect(followed.result.stdout.toString()).toBe("hello world\n");
    expect(followed.result.metadata.url).toBe(`${base}/text`);

    const posted = await run({
      url: `${base}/redirect-303`,
      method: "POST",
      body: "payload",
    });
    expect(posted.result.stdout.toString()).toBe("hello world\n");

    await expect(
      run({ url: `${base}/loop`, maxRedirects: 2 }),
    ).rejects.toMatchObject({ code: "io" });

    const manual = await run({ url: `${base}/redirect`, followRedirects: false });
    expect(manual.result.metadata.status).toBe(302);
    expect((manual.result.metadata.headers as Record<string, string>).location).toBe("/text");

    await expect(run({ url: `${base}/bad-scheme` })).rejects.toMatchObject({
      code: "unsupported",
    });

    await expect(run({ url: `${base}/loop`, maxRedirects: 0 })).rejects.toMatchObject({
      code: "io",
    });
  });

  it("sends text and JSON request bodies", async () => {
    const text = await run({ url: `${base}/echo`, method: "POST", body: "raw" });
    const textPayload = JSON.parse(text.result.stdout.toString()) as Record<string, unknown>;
    expect(textPayload).toMatchObject({ method: "POST", body: "raw" });

    const json = await run({
      url: `${base}/echo`,
      method: "PUT",
      json: { hello: "world" },
      headers: { "x-custom": "1" },
    });
    expect(JSON.parse(json.result.stdout.toString())).toMatchObject({
      method: "PUT",
      body: JSON.stringify({ hello: "world" }),
      contentType: "application/json",
    });

    const custom = await run({
      url: `${base}/echo`,
      method: "POST",
      json: [1, 2],
      headers: { "Content-Type": "application/vnd.test+json" },
    });
    expect(JSON.parse(custom.result.stdout.toString())).toMatchObject({
      contentType: "application/vnd.test+json",
    });

    await expect(run({ url: `${base}/echo`, body: "x", json: {} })).rejects.toMatchObject({
      code: "invalid",
    });
    await expect(run({ url: `${base}/echo`, body: "x" })).rejects.toMatchObject({
      code: "invalid",
    });
    await expect(run({ url: `${base}/echo`, method: "HEAD", json: {} })).rejects.toMatchObject({
      code: "invalid",
    });
  });

  it("honors failOnError, maxBytes, HEAD and status metadata", async () => {
    await expect(run({ url: `${base}/notfound` })).rejects.toMatchObject({ code: "io" });

    const empty = await run({ url: `${base}/notfound-empty` }).catch((error: FsError) => error);
    expect(empty.message).toBe(`HTTP 404 Not Found for ${base}/notfound-empty`);

    const big = await run({ url: `${base}/notfound-big` }).catch((error: FsError) => error);
    expect(big.message).toContain("x".repeat(100));
    expect(big.message.length).toBeLessThan(5000);

    await expect(run({ url: `${base}/broken` })).rejects.toMatchObject({ code: "io" });

    await expect(
      run({ url: `${base}/text`, output: "missing/text.txt" }),
    ).rejects.toMatchObject({ code: "not-found" });

    const ignored = await run({ url: `${base}/notfound`, failOnError: false });
    expect(ignored.result.metadata.status).toBe(404);
    expect(ignored.result.stdout.toString()).toBe("nope\n");

    await expect(run({ url: `${base}/big`, maxBytes: 5 })).rejects.toMatchObject({
      code: "invalid",
    });

    const head = await run({ url: `${base}/text`, method: "HEAD" });
    expect(head.result.stdout.length).toBe(0);
  });

  it("rejects bad URLs, schemes and checksums", async () => {
    await expect(run({ url: "not a url" })).rejects.toMatchObject({ code: "invalid" });
    await expect(run({ url: "ftp://example.com/file" })).rejects.toMatchObject({
      code: "unsupported",
    });
    await expect(
      run({ url: `${base}/text`, checksum: "sha256:zzzz" }),
    ).rejects.toMatchObject({ code: "invalid" });
    await expect(run({ url: `${base}/text`, checksum: "sha256" })).rejects.toMatchObject({
      code: "invalid",
    });
  });

  it("times out, aborts, and maps connection failures", async () => {
    await expect(run({ url: `${base}/slow`, timeoutMs: 100 })).rejects.toMatchObject({
      code: "interrupted",
    });

    const { sb } = await setup();
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 50);
    await expect(
      runSpec(httpRequestTool, { url: `${base}/slow`, timeoutMs: 5_000 }, sb, {
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ code: "interrupted" });

    const aborted = new AbortController();
    aborted.abort();
    await expect(
      runSpec(httpRequestTool, { url: `${base}/text` }, sb, { signal: aborted.signal }),
    ).rejects.toMatchObject({ code: "interrupted" });

    await expect(run({ url: "http://127.0.0.1:1/" })).rejects.toMatchObject({ code: "io" });
  });

  it("propagates permission denials", async () => {
    const { sb } = await setup();
    await expect(
      runSpec(httpRequestTool, { url: `${base}/text` }, sb, { deny: true }),
    ).rejects.toThrow(/permission denied/);
  });

  it("works as a pipe source", async () => {
    const { sb } = await setup();
    const result = await runSpec(
      pipeTool,
      {
        stages: [
          { tool: "http_request", args: { url: `${base}/text` } },
          { tool: "grep", args: { pattern: "hello" } },
          { tool: "wc", args: { lines: true } },
        ],
      },
      sb,
    );
    expect(result.result.stdout.toString().trim()).toBe("1");
    expect(result.requests.map((request) => request.action)).toContain("fs_http_request");
    expect(result.requests[0]).toMatchObject({ resources: [new URL(base).host] });
  });
});
