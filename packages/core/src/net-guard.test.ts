import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { isPrivateAddress, assertSafeUrlSyntax, assertPublicUrl, guardedLookup, BlockedUrlError } from "./net-guard.js";

test("private, loopback, link-local, CGNAT, reserved and IPv4-in-IPv6 addresses are private", () => {
  for (const ip of [
    "127.0.0.1",
    "127.1.2.3",
    "10.1.2.3",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.65.254",
    "169.254.169.254",
    "100.64.0.1",
    "0.0.0.0",
    "0.1.2.3",
    "224.0.0.1",
    "255.255.255.255",
    "::1",
    "::",
    "fd00::1",
    "fe80::1",
    "::ffff:127.0.0.1",
    "::ffff:7f00:1",
    "::ffff:169.254.169.254",
    "0:0:0:0:0:ffff:a00:1",
    "::127.0.0.1",
    "64:ff9b::a9fe:a9fe",
    "2002:7f00:1::",
    "fe80::1%eth0",
  ]) {
    assert.equal(isPrivateAddress(ip), true, ip);
  }
  for (const ip of ["93.184.216.34", "8.8.8.8", "172.32.0.1", "100.128.0.1", "2606:4700:4700::1111", "::ffff:8.8.8.8"]) {
    assert.equal(isPrivateAddress(ip), false, ip);
  }
  assert.equal(isPrivateAddress("not-an-ip"), true);
});

test("URL syntax check: schemes and literal private hosts in all the usual spellings", () => {
  const blocked = [
    "file:///etc/passwd",
    "ftp://example.com/x.mp4",
    "gopher://127.0.0.1:6379/_x",
    "not a url",
    "http://localhost/x",
    "http://localhost./x",
    "http://LOCALHOST/x",
    "http://foo.localhost/x",
    "http://127.0.0.1/x",
    "http://127.1/x",
    "http://2130706433/x", // decimal
    "http://0x7f000001/x", // hex
    "http://0177.0.0.1/x", // octal
    "http://10.0.0.1/x",
    "http://169.254.169.254/latest/meta-data/",
    "http://[::1]/x",
    "http://[::ffff:127.0.0.1]/x",
    "http://[0:0:0:0:0:ffff:7f00:1]/x",
    "http://0.0.0.0/x",
    "http://0/x",
  ];
  for (const u of blocked) assert.throws(() => assertSafeUrlSyntax(u, { allowPrivate: false }), BlockedUrlError, u);
  assert.equal(assertSafeUrlSyntax("https://example.com/v.mp4", { allowPrivate: false }).hostname, "example.com");
  // allowPrivate keeps the scheme check but allows private hosts
  assert.doesNotThrow(() => assertSafeUrlSyntax("http://127.0.0.1/x", { allowPrivate: true }));
  assert.throws(() => assertSafeUrlSyntax("file:///etc/passwd", { allowPrivate: true }), BlockedUrlError);
});

test("names that resolve to private addresses are refused (DNS check)", async () => {
  // "localhost." / names in /etc/hosts resolve without network access.
  await assert.rejects(assertPublicUrl("http://localhost./x", { allowPrivate: false }), BlockedUrlError);
  await new Promise<void>((resolve, reject) =>
    guardedLookup("localhost", { family: 0 } as any, (err: any, address: any) => {
      try {
        assert.ok(err instanceof BlockedUrlError, `expected block, got ${address}`);
        resolve();
      } catch (e) {
        reject(e);
      }
    }),
  );
});

test("guardedLookup stops http.get from connecting to a private address", async () => {
  let hits = 0;
  const server = http.createServer((_req, res) => {
    hits++;
    res.end("secret");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  try {
    const err = await new Promise<Error>((resolve) => {
      const req = http.get(`http://localhost:${port}/`, { lookup: guardedLookup }, () => resolve(new Error("connected")));
      req.on("error", resolve);
    });
    assert.ok(err instanceof BlockedUrlError, String(err));
    assert.equal(hits, 0);
  } finally {
    server.close();
  }
});
