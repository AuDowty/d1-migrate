import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  createMigration,
  discoverMigrations,
  migrationsToApply,
  migrationsToRevert,
  pendingMigrations,
  sqlForDown,
  sqlForUp,
  STATE_TABLE_SQL,
} from "../dist/lib.js";

async function scratch() {
  return await mkdtemp(path.join(tmpdir(), "d1-migrate-test-"));
}

test("createMigration: numbers + pairs", async () => {
  const dir = await scratch();
  try {
    const a = await createMigration(dir, "create users");
    const b = await createMigration(dir, "Add Orders!");
    assert.match(a.up, /0001_create_users\.up\.sql$/);
    assert.match(a.down, /0001_create_users\.down\.sql$/);
    assert.match(b.up, /0002_add_orders\.up\.sql$/);
    const all = await discoverMigrations(dir);
    assert.equal(all.length, 2);
    assert.equal(all[0].name, "0001_create_users");
    assert.equal(all[1].name, "0002_add_orders");
    assert.ok(all[0].downFile);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("discoverMigrations: skips junk + missing dir = empty", async () => {
  const dir = await scratch();
  try {
    await writeFile(path.join(dir, "0001_ok.up.sql"), "");
    await writeFile(path.join(dir, "0001_ok.down.sql"), "");
    await writeFile(path.join(dir, "README.md"), "");
    await writeFile(path.join(dir, "0002_only_up.up.sql"), "");
    const all = await discoverMigrations(dir);
    assert.equal(all.length, 2);
    assert.equal(all[1].downFile, null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  const missing = await discoverMigrations(path.join(tmpdir(), "does-not-exist-xyz"));
  assert.deepEqual(missing, []);
});

test("pendingMigrations + migrationsToApply --to", () => {
  const all = [
    { id: 1, name: "0001_a", upFile: "a.up", downFile: "a.down" },
    { id: 2, name: "0002_b", upFile: "b.up", downFile: "b.down" },
    { id: 3, name: "0003_c", upFile: "c.up", downFile: "c.down" },
  ];
  assert.deepEqual(
    pendingMigrations(all, ["0001_a"]).map((m) => m.name),
    ["0002_b", "0003_c"],
  );
  assert.deepEqual(
    migrationsToApply(all, ["0001_a"], "0002").map((m) => m.name),
    ["0002_b"],
  );
  assert.deepEqual(
    migrationsToApply(all, [], undefined).map((m) => m.name),
    ["0001_a", "0002_b", "0003_c"],
  );
});

test("migrationsToRevert: stack order", () => {
  const all = [
    { id: 1, name: "0001_a", upFile: "", downFile: "" },
    { id: 2, name: "0002_b", upFile: "", downFile: "" },
    { id: 3, name: "0003_c", upFile: "", downFile: "" },
  ];
  assert.deepEqual(
    migrationsToRevert(all, ["0001_a", "0002_b", "0003_c"], undefined).map((m) => m.name),
    ["0003_c"],
  );
  assert.deepEqual(
    migrationsToRevert(all, ["0001_a", "0002_b", "0003_c"], "0002").map((m) => m.name),
    ["0003_c", "0002_b"],
  );
});

test("sqlForUp/Down: escape quotes + include state table", () => {
  const m = { id: 1, name: "0001_o'reilly", upFile: "", downFile: "" };
  const up = sqlForUp(m, "CREATE TABLE foo (id INT);");
  assert.ok(up.includes(STATE_TABLE_SQL));
  assert.ok(up.includes("CREATE TABLE foo"));
  assert.ok(up.includes("'0001_o''reilly'"));
  const down = sqlForDown(m, "DROP TABLE foo;");
  assert.ok(down.includes("DROP TABLE foo"));
  assert.ok(down.includes("DELETE FROM d1_migrations WHERE name = '0001_o''reilly'"));
});
