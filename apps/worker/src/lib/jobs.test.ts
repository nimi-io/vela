import { test } from "node:test";
import assert from "node:assert/strict";
import { UnrecoverableError } from "bullmq";
import { isFinalFailure } from "./jobs.js";

test("a failure with retries left is not final", () => {
  assert.equal(isFinalFailure({ attemptsMade: 1, opts: { attempts: 2 } }, new Error("boom")), false);
});

test("the last attempt's failure is final", () => {
  assert.equal(isFinalFailure({ attemptsMade: 2, opts: { attempts: 2 } }, new Error("boom")), true);
  assert.equal(isFinalFailure({ attemptsMade: 1, opts: {} }, new Error("boom")), true);
});

test("a job failed for stalling too often is final although attempts remain", () => {
  // What BullMQ hands the "failed" listener after a worker died more than maxStalledCount times:
  // an UnrecoverableError, attemptsMade 1 of 2, finishedOn set by moveToFailed.
  const err = new UnrecoverableError("job stalled more than allowable limit");
  assert.equal(isFinalFailure({ attemptsMade: 1, opts: { attempts: 2 }, finishedOn: Date.now() }, err), true);
  assert.equal(isFinalFailure({ attemptsMade: 1, opts: { attempts: 2 } }, err), true);
  assert.equal(isFinalFailure({ attemptsMade: 1, opts: { attempts: 2 }, finishedOn: Date.now() }, new Error("x")), true);
});
