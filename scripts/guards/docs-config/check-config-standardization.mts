#!/usr/bin/env node
import nodeAssert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createInstalledConfig,
  mergeInstalledConfig,
  migrationSyncPolicies,
} from "../../../bin/config-contract.mjs";
import { at, recordOf } from "../../lib/json.mts";
import { assert, ok } from "../lib/assertions.mts";
import { ROOT, readJson } from "../lib/repository.mts";

export function check(root = ROOT): void {
  const schema = readJson("supaschema-config.schema.json", root);
  assert(
    at(schema, "$id") === "https://supaschema.com/schemas/supaschema-config.schema.json",
    "config schema must use the canonical absolute identifier"
  );
  const properties = recordOf(at(schema, "properties"));
  assert(
    JSON.stringify(at(properties, "adapter", "enum")) === JSON.stringify(["auto"]),
    "adapter must allow only auto"
  );
  assert(
    JSON.stringify(
      Object.keys(recordOf(at(properties, "sources", "properties"))).sort(
        (left, right) => Number(left > right) - Number(left < right)
      )
    ) === JSON.stringify(["from"]),
    "sources must expose only from"
  );
  assert(at(properties, "sources", "additionalProperties") === false, "sources must be strict");
  assert(
    JSON.stringify(at(properties, "workflow", "properties", "migration_sync", "enum")) ===
      JSON.stringify(["disabled", "manual", "auto"]),
    "migration_sync must expose only canonical policies"
  );
  assert(
    JSON.stringify(migrationSyncPolicies) === JSON.stringify(["disabled", "manual", "auto"]),
    "generated contract migration policies must match the schema"
  );

  const installed = createInstalledConfig();
  assert(
    JSON.stringify(installed.sources) === JSON.stringify({ from: "auto" }),
    "installed config must have one source owner"
  );
  nodeAssert.throws(
    () => mergeInstalledConfig({ sources: { from: "auto", to: "dir:legacy" } }),
    "config repair must reject removed source fields"
  );
  nodeAssert.throws(
    () =>
      mergeInstalledConfig({
        workflow: { migration_sync: "explicit_request_only" },
      }),
    "config repair must reject removed workflow policies"
  );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  check();
  ok("CONFIG_STANDARDIZATION_OK");
}
