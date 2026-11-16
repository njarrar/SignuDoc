import assert from "node:assert/strict";
import { test } from "node:test";

import { resolveLocalStorageDir } from "./local.ts";

test("an unset or empty STORAGE_LOCAL_DIR falls back to the default directory", () => {
  const fallback = resolveLocalStorageDir({});

  assert.notEqual(fallback, "");
  assert.equal(resolveLocalStorageDir({ STORAGE_LOCAL_DIR: "" }), fallback);
  assert.equal(resolveLocalStorageDir({ STORAGE_LOCAL_DIR: "   " }), fallback);
});

test("a set STORAGE_LOCAL_DIR is used, without the space around it", () => {
  assert.equal(
    resolveLocalStorageDir({ STORAGE_LOCAL_DIR: " /var/signudoc " }),
    "/var/signudoc",
  );
});
