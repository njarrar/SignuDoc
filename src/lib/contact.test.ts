import assert from "node:assert/strict";
import { test } from "node:test";

import { formatSubmittedAt } from "./contact.ts";

test("the submitted time reads as UTC whatever its milliseconds", () => {
  assert.equal(
    formatSubmittedAt(new Date("2026-11-16T10:15:30.000Z")),
    "2026-11-16 10:15:30 UTC",
  );
  assert.equal(
    formatSubmittedAt(new Date("2026-11-16T10:15:30.123Z")),
    "2026-11-16 10:15:30 UTC",
  );
});
