import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { jobWorkDir, makeJobWorkDir, removeJobWorkDir, runWithJobWorkDir } from "./workdir.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "vela-work-"));
// A fresh object per attempt, as BullMQ hands each attempt its own Job instance.
const attempt = (queueName: string, id: string) => ({ queueName, id });

test("each job gets its own stable directory, and each attempt its own subdirectory", async () => {
  const a = jobWorkDir(attempt("video", "143"), root);
  assert.equal(a, jobWorkDir(attempt("video", "143"), root));
  assert.notEqual(a, jobWorkDir(attempt("video", "144"), root));
  assert.notEqual(a, jobWorkDir(attempt("live", "143"), root));
  // Custom job IDs can't escape the work root.
  assert.equal(path.dirname(jobWorkDir(attempt("live", "../../etc/x"), root)), root);
  const d1 = await makeJobWorkDir(attempt("video", "143"), root);
  const d2 = await makeJobWorkDir(attempt("video", "143"), root);
  assert.notEqual(d1, d2);
  assert.equal(path.dirname(d1), a);
  await removeJobWorkDir(attempt("video", "143"), root);
});

test("files of an attempt killed mid-job are removed when a later attempt completes the job", async () => {
  // Attempt 1: writes the source, then its worker dies (no finally runs).
  const dead = await makeJobWorkDir(attempt("video", "7"), root);
  await fsp.writeFile(path.join(dead, "source"), "x".repeat(1024));
  // Attempt 2 on another worker completes.
  const a2 = attempt("video", "7");
  await runWithJobWorkDir(a2, async () => {
    await fsp.writeFile(path.join(await makeJobWorkDir(a2, root), "out"), "y");
  }, root);
  assert.equal(fs.existsSync(jobWorkDir(a2, root)), false);
});

test("a failing attempt removes only its own files, not those of an overlapping attempt of the same job", async () => {
  // A worker that lost its lock (zombie) and the worker that now owns the job run at the same time.
  const owner = attempt("video", "167");
  const ownerDir = await makeJobWorkDir(owner, root);
  await fsp.writeFile(path.join(ownerDir, "source"), "downloaded");
  const zombie = attempt("video", "167");
  await assert.rejects(
    runWithJobWorkDir(zombie, async () => {
      await fsp.writeFile(path.join(await makeJobWorkDir(zombie, root), "partial"), "z");
      throw new Error("ffmpeg exited with code 1");
    }, root),
    /ffmpeg/,
  );
  assert.equal(await fsp.readFile(path.join(ownerDir, "source"), "utf8"), "downloaded");
  assert.deepEqual(fs.readdirSync(jobWorkDir(owner, root)), [path.basename(ownerDir)]);
  await removeJobWorkDir(owner, root);
});

test("the final-failure cleanup removes everything the job left", async () => {
  const job = attempt("ai", "9");
  await fsp.writeFile(path.join(await makeJobWorkDir(job, root), "f"), "z");
  await removeJobWorkDir(job, root);
  assert.deepEqual(fs.readdirSync(root), []);
});
