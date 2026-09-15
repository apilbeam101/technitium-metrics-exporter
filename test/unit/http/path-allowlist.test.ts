import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { assertPathAllowed } from "../../../src/http/path-allowlist.ts";

describe("assertPathAllowed", () => {
  for (const path of [
    "/api/user/session/get",
    "/api/dashboard/metrics/text",
    "/api/zones/list",
    "/api/dashboard/stats/get",
    "/api/admin/cluster/state",
  ]) {
    it(`allows ${path}`, () => {
      assert.doesNotThrow(() => assertPathAllowed(path));
    });
  }

  for (const path of [
    "/api/zones/delete",
    "/api/zones/create",
    "/api/user/delete",
    "/api/settings/set",
    "/api/admin/cluster/leave",
    "/api/user/session/get/../../zones/delete",
  ]) {
    it(`rejects the destructive path ${path}`, () => {
      assert.throws(() => assertPathAllowed(path));
    });
  }
});
