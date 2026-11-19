import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import type { AddressInfo } from "node:net";
import { BlockedUrlError } from "@vela/core";
import { downloadUrl } from "./source.js";

let server: http.Server;
let port = 0;
let hits: string[] = [];
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vela-src-"));

before(async () => {
  server = http.createServer((req, res) => {
    hits.push(req.url!);
    if (req.url === "/redirect") return res.writeHead(302, { Location: `http://localhost:${port}/secret` }).end();
    res.end("secret");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  port = (server.address() as AddressInfo).port;
});
after(() => server.close());

test("with ALLOW_PRIVATE_INPUT_URLS unset, private/loopback inputs are refused before any request", async () => {
  delete process.env.ALLOW_PRIVATE_INPUT_URLS;
  hits = [];
  for (const u of [
    `http://localhost:${port}/secret`,
    `http://localhost.:${port}/secret`,
    `http://127.0.0.1:${port}/secret`,
    `http://2130706433:${port}/secret`,
    `http://[::ffff:127.0.0.1]:${port}/secret`,
  ]) {
    await assert.rejects(downloadUrl(u, path.join(dir, "out")), BlockedUrlError, u);
  }
  await assert.rejects(downloadUrl("file:///etc/passwd", path.join(dir, "out")), BlockedUrlError);
  assert.deepEqual(hits, []);
});

test("ALLOW_PRIVATE_INPUT_URLS=true allows local sources and follows redirects", async () => {
  process.env.ALLOW_PRIVATE_INPUT_URLS = "true";
  hits = [];
  const out = await downloadUrl(`http://127.0.0.1:${port}/redirect`, path.join(dir, "ok"));
  assert.equal(fs.readFileSync(out, "utf8"), "secret");
  assert.deepEqual(hits, ["/redirect", "/secret"]);
  delete process.env.ALLOW_PRIVATE_INPUT_URLS;
});
