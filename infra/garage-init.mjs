#!/usr/bin/env node
/**
 * One-shot, idempotent Garage bootstrap for Vela (run by the `garage-init` compose service).
 *
 * Uses the Garage v2 admin API (the official image has no shell, so the CLI can't be
 * scripted from inside it). Equivalent CLI steps:
 *   garage status                                  -> node id
 *   garage layout assign -z dc1 -c 10G <node_id>
 *   garage layout apply --version <next>
 *   garage bucket create vela
 *   garage key import <S3_ACCESS_KEY_ID> <S3_SECRET_ACCESS_KEY> -n vela
 *   garage bucket allow --read --write --owner vela --key <S3_ACCESS_KEY_ID>
 *
 * Every step checks current state first, so running it again is a no-op.
 *
 * Env: GARAGE_ADMIN_URL (http://garage:3903), GARAGE_ADMIN_TOKEN, S3_BUCKET,
 *      S3_ACCESS_KEY_ID (GK + 24 hex), S3_SECRET_ACCESS_KEY (64 hex),
 *      GARAGE_ZONE (dc1), GARAGE_CAPACITY (bytes, default 10G)
 */
const ADMIN = (process.env.GARAGE_ADMIN_URL ?? "http://garage:3903").replace(/\/$/, "");
const TOKEN = process.env.GARAGE_ADMIN_TOKEN;
const BUCKET = process.env.S3_BUCKET ?? "vela";
const KEY_ID = process.env.S3_ACCESS_KEY_ID;
const SECRET = process.env.S3_SECRET_ACCESS_KEY;
const ZONE = process.env.GARAGE_ZONE ?? "dc1";
const CAPACITY = Number(process.env.GARAGE_CAPACITY ?? 10 * 1000 ** 3);

for (const [k, v] of Object.entries({ GARAGE_ADMIN_TOKEN: TOKEN, S3_ACCESS_KEY_ID: KEY_ID, S3_SECRET_ACCESS_KEY: SECRET })) {
  if (!v) fail(`${k} is not set`);
}
if (!/^GK[0-9a-f]{24}$/.test(KEY_ID)) fail("S3_ACCESS_KEY_ID must be 'GK' + 24 lowercase hex chars (Garage key format)");
if (!/^[0-9a-f]{64}$/.test(SECRET)) fail("S3_SECRET_ACCESS_KEY must be 64 lowercase hex chars (Garage key format)");

function fail(msg) {
  console.error(`garage-init: ${msg}`);
  process.exit(1);
}

async function api(method, path, body, { allow404 = false } = {}) {
  const res = await fetch(`${ADMIN}${path}`, {
    method,
    headers: { authorization: `Bearer ${TOKEN}`, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (allow404 && (res.status === 404 || (res.status === 400 && /not found/i.test(text)))) return null;
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${text}`);
  return text ? JSON.parse(text) : {};
}

// 1. Wait for the admin API.
for (let i = 0; ; i++) {
  try {
    await api("GET", "/v2/GetClusterStatus");
    break;
  } catch (err) {
    if (i >= 60) fail(`admin API not reachable at ${ADMIN}: ${err.message}`);
  }
  await new Promise((r) => setTimeout(r, 1000));
}

// 2. Layout: assign this node a role if it has none, then apply.
const status = await api("GET", "/v2/GetClusterStatus");
const self = status.nodes.find((n) => n.isUp) ?? status.nodes[0];
if (!self) fail("no node in cluster status");
const layout = await api("GET", "/v2/GetClusterLayout");
const hasRole = layout.roles.some((r) => r.id === self.id);
if (hasRole) {
  console.log(`layout: node ${self.id.slice(0, 16)} already has a role (layout v${layout.version})`);
} else {
  const staged = layout.stagedRoleChanges.some((r) => r.id === self.id);
  if (!staged) {
    await api("POST", "/v2/UpdateClusterLayout", {
      roles: [{ id: self.id, zone: ZONE, capacity: CAPACITY, tags: [] }],
    });
  }
  const applied = await api("POST", "/v2/ApplyClusterLayout", { version: layout.version + 1 });
  console.log(`layout: assigned ${self.id.slice(0, 16)} zone=${ZONE} capacity=${CAPACITY}, applied v${layout.version + 1}`);
  for (const m of applied.message ?? []) console.log(`  ${m}`);
}

// 3. Bucket.
let bucket = await api("GET", `/v2/GetBucketInfo?globalAlias=${encodeURIComponent(BUCKET)}`, undefined, { allow404: true });
if (bucket) {
  console.log(`bucket: ${BUCKET} exists (${bucket.id.slice(0, 16)})`);
} else {
  bucket = await api("POST", "/v2/CreateBucket", { globalAlias: BUCKET });
  console.log(`bucket: created ${BUCKET} (${bucket.id.slice(0, 16)})`);
}

// 4. Access key (imported so the credentials in .env are the source of truth).
let key = await api("GET", `/v2/GetKeyInfo?id=${encodeURIComponent(KEY_ID)}&showSecretKey=true`, undefined, { allow404: true });
if (key) {
  if (key.secretAccessKey && key.secretAccessKey !== SECRET) {
    fail(`key ${KEY_ID} exists in Garage with a different secret; delete it (garage key delete) or fix .env`);
  }
  console.log(`key: ${KEY_ID} exists`);
} else {
  key = await api("POST", "/v2/ImportKey", { accessKeyId: KEY_ID, secretAccessKey: SECRET, name: "vela" });
  console.log(`key: imported ${KEY_ID}`);
}

// 5. Permissions (AllowBucketKey only ever adds flags, so it is idempotent).
await api("POST", "/v2/AllowBucketKey", {
  bucketId: bucket.id,
  accessKeyId: KEY_ID,
  permissions: { read: true, write: true, owner: true },
});
console.log(`permissions: ${KEY_ID} has read/write/owner on ${BUCKET}`);
console.log(`S3_ACCESS_KEY_ID=${KEY_ID}`);
console.log(`S3_SECRET_ACCESS_KEY=${SECRET.slice(0, 4)}… (full value is in .env)`);
