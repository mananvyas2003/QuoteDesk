import { test } from "node:test";
import assert from "node:assert/strict";
import { CONFIDENCE_THRESHOLDS } from "../src/lib/types";

test("test runner is wired", () => {
  assert.equal(CONFIDENCE_THRESHOLDS.minComparables, 3);
});
