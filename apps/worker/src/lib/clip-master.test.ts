import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { spawnSync } from "node:child_process";

const hasFfmpeg = spawnSync(process.env.FFMPEG_PATH ?? "ffmpeg", ["-version"]).status === 0;

test("cutClipMaster produces a standalone master of exactly the clip range", { skip: !hasFfmpeg && "ffmpeg not installed" }, async () => {
  process.env.DATABASE_URL ??= "postgres://unused@127.0.0.1:1/x";
  process.env.S3_BUCKET ??= "t";
  process.env.S3_ACCESS_KEY_ID ??= "t";
  process.env.S3_SECRET_ACCESS_KEY ??= "t";
  process.env.MASTER_KEY ??= "0".repeat(64);
  const { cutClipMaster } = await import("./source.js");
  const { probe } = await import("./media.js");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vela-clip-"));
  const parent = path.join(dir, "parent.mp4");
  // 10 s test source with a 2 s GOP, so a keyframe-aligned stream copy would be visibly off.
  const gen = spawnSync(process.env.FFMPEG_PATH ?? "ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=30:duration=10",
    "-f", "lavfi", "-i", "sine=frequency=440:duration=10", "-c:v", "libx264", "-g", "60", "-c:a", "aac", "-shortest", parent,
  ]);
  assert.equal(gen.status, 0, gen.stderr.toString());
  const out = path.join(dir, "clip.mp4");
  await cutClipMaster(parent, out, 3.5, 6.5);
  const info = await probe(out);
  assert.ok(Math.abs(info.duration - 3) < 0.15, `duration ${info.duration}`);
  assert.equal(info.video?.width, 320);
  assert.ok(info.audio, "keeps audio");
  fs.rmSync(dir, { recursive: true, force: true });
});
