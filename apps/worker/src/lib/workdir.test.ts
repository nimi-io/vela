import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { jobWorkDir, makeJobWorkDir, runWithJobWorkDir } from "./workdir.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "vela-work-"));

test("each job gets its own stable directory", () => {
  const a = jobWorkDir({ queueName: "video", id: "143" }, root);
  assert.equal(a, jobWorkDir({ queueName: "video", id: "143" }, root));
  assert.notEqual(a, jobWorkDir({ queueName: "video", id: "144" }, root));
  assert.notEqual(a, jobWorkDir({ queueName: "live", id: "143" }, root));
  // Custom job IDs can't escape the work root.
  assert.equal(path.dirname(jobWorkDir({ queueName: "live", id: "../../etc/x" }, root)), root);
});

test("an attempt killed mid-job leaves files that the next attempt removes", async () => {
  const job = { queueName: "video", id: "7" };
  // Attempt 1: the worker writes a large file, then dies (no finally runs).
  const dir1 = await makeJobWorkDir(job, root);
  await fsp.writeFile(path.join(dir1, "source"), "x".repeat(1024));
  assert.ok(fs.existsSync(path.join(dir1, "source")));

  // Attempt 2 (another worker, after stall recovery) starts from an empty directory...
  await runWithJobWorkDir(
    job,
    async () => {
      assert.equal(fs.existsSync(path.join(dir1, "source")), false);
      const dir2 = await makeJobWorkDir(job, root);
      await fsp.writeFile(path.join(dir2, "out"), "y");
    },
    root,
  );
  // ...and nothing remains once it ends.
  assert.equal(fs.existsSync(jobWorkDir(job, root)), false);
});

test("the directory is removed when the attempt throws", async () => {
  const job = { queueName: "ai", id: "9" };
  await assert.rejects(
    runWithJobWorkDir(
      job,
      async () => {
        await fsp.writeFile(path.join(await makeJobWorkDir(job, root), "f"), "z");
        throw new Error("boom");
      },
      root,
    ),
    /boom/,
  );
  assert.equal(fs.existsSync(jobWorkDir(job, root)), false);
  assert.deepEqual(fs.readdirSync(root), []);
});
