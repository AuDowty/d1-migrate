import { readdir, readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import * as toml from "smol-toml";

export interface Migration {
  id: number;
  name: string;
  upFile: string;
  downFile: string | null;
}

export const STATE_TABLE_SQL =
  "CREATE TABLE IF NOT EXISTS d1_migrations (" +
  "id INTEGER PRIMARY KEY AUTOINCREMENT," +
  "name TEXT NOT NULL UNIQUE," +
  "applied_at INTEGER NOT NULL DEFAULT (unixepoch()));";

export async function discoverMigrations(dir: string): Promise<Migration[]> {
  if (!existsSync(dir)) return [];
  const entries = await readdir(dir);
  const ups = entries
    .filter((e) => /^\d+_.+\.up\.sql$/.test(e))
    .sort();
  return ups.map((up) => {
    const m = up.match(/^(\d+)_(.+)\.up\.sql$/)!;
    const idStr = m[1];
    const name = `${idStr}_${m[2]}`;
    const id = Number(idStr);
    const downCandidate = `${idStr}_${m[2]}.down.sql`;
    const downFile = entries.includes(downCandidate)
      ? path.join(dir, downCandidate)
      : null;
    return { id, name, upFile: path.join(dir, up), downFile };
  });
}

export async function createMigration(
  dir: string,
  rawName: string,
): Promise<{ up: string; down: string }> {
  await mkdir(dir, { recursive: true });
  const existing = await discoverMigrations(dir);
  const next = existing.reduce((a, m) => Math.max(a, m.id), 0) + 1;
  const num = String(next).padStart(4, "0");
  const slug = rawName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (!slug) throw new Error("migration name must contain letters or digits");
  const upPath = path.join(dir, `${num}_${slug}.up.sql`);
  const downPath = path.join(dir, `${num}_${slug}.down.sql`);
  await writeFile(upPath, "");
  await writeFile(downPath, "");
  return { up: upPath, down: downPath };
}

export interface ResolvedConfig {
  database: string;
  migrationsDir: string;
}

export async function resolveConfig(
  opts: { database?: string; cwd?: string } = {},
): Promise<ResolvedConfig> {
  const cwd = opts.cwd ?? process.cwd();
  const migrationsDir = path.join(cwd, "migrations");
  if (opts.database) return { database: opts.database, migrationsDir };

  const wranglerToml = path.join(cwd, "wrangler.toml");
  const wranglerJsonc = path.join(cwd, "wrangler.jsonc");
  const wranglerJson = path.join(cwd, "wrangler.json");

  let database: string | undefined;
  if (existsSync(wranglerToml)) {
    const parsed = toml.parse(await readFile(wranglerToml, "utf8")) as Record<
      string,
      unknown
    >;
    const dbs = parsed["d1_databases"] as Array<{ binding?: string }> | undefined;
    if (dbs?.[0]?.binding) database = dbs[0].binding;
  } else {
    const file = existsSync(wranglerJsonc)
      ? wranglerJsonc
      : existsSync(wranglerJson)
        ? wranglerJson
        : null;
    if (file) {
      const raw = await readFile(file, "utf8");
      const stripped = raw
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^(\s*)\/\/.*$/gm, "$1");
      const parsed = JSON.parse(stripped) as Record<string, unknown>;
      const dbs = parsed["d1_databases"] as
        | Array<{ binding?: string }>
        | undefined;
      if (dbs?.[0]?.binding) database = dbs[0].binding;
    }
  }
  if (!database) {
    throw new Error(
      "no database specified and no d1_databases binding found in wrangler config — pass --database <binding>",
    );
  }
  return { database, migrationsDir };
}

export function pendingMigrations(
  all: Migration[],
  applied: string[],
): Migration[] {
  const appliedSet = new Set(applied);
  return all.filter((m) => !appliedSet.has(m.name));
}

export function migrationsToApply(
  all: Migration[],
  applied: string[],
  to?: string,
): Migration[] {
  const pending = pendingMigrations(all, applied);
  if (!to) return pending;
  const idx = pending.findIndex((m) => m.name === to || m.name.startsWith(`${to}_`) || m.name === `${to}`);
  if (idx < 0) {
    throw new Error(`pending migration not found: ${to}`);
  }
  return pending.slice(0, idx + 1);
}

export function migrationsToRevert(
  all: Migration[],
  applied: string[],
  to?: string,
): Migration[] {
  const appliedInOrder = all.filter((m) => applied.includes(m.name));
  const stack = [...appliedInOrder].reverse();
  if (!to) return stack.slice(0, 1);
  const idx = stack.findIndex(
    (m) => m.name === to || m.name.startsWith(`${to}_`) || m.name === `${to}`,
  );
  if (idx < 0) {
    throw new Error(`applied migration not found: ${to}`);
  }
  return stack.slice(0, idx + 1);
}

function escapeSqlLiteral(s: string): string {
  return s.replace(/'/g, "''");
}

export function sqlForUp(migration: Migration, body: string): string {
  return (
    `${STATE_TABLE_SQL}\n` +
    `${body.trim()}\n` +
    `INSERT INTO d1_migrations (name) VALUES ('${escapeSqlLiteral(migration.name)}');\n`
  );
}

export function sqlForDown(migration: Migration, body: string): string {
  return (
    `${body.trim()}\n` +
    `DELETE FROM d1_migrations WHERE name = '${escapeSqlLiteral(migration.name)}';\n`
  );
}

export interface WranglerOpts {
  database: string;
  remote: boolean;
}

export async function getAppliedMigrations(
  opts: WranglerOpts,
): Promise<string[]> {
  await spawnWrangler(["d1", "execute", opts.database, remoteFlag(opts.remote), "--command", STATE_TABLE_SQL]);
  const out = await spawnWrangler([
    "d1",
    "execute",
    opts.database,
    remoteFlag(opts.remote),
    "--json",
    "--command",
    "SELECT name FROM d1_migrations ORDER BY id",
  ]);
  return parseWranglerRows(out).map((r) => r["name"] as string);
}

export async function executeSqlFile(
  opts: WranglerOpts,
  filePath: string,
): Promise<void> {
  await spawnWrangler([
    "d1",
    "execute",
    opts.database,
    remoteFlag(opts.remote),
    "--file",
    filePath,
  ]);
}

function remoteFlag(remote: boolean): string {
  return remote ? "--remote" : "--local";
}

function parseWranglerRows(out: string): Array<Record<string, unknown>> {
  const start = out.indexOf("[");
  if (start < 0) return [];
  let depth = 0;
  let end = -1;
  for (let i = start; i < out.length; i++) {
    const c = out[i];
    if (c === "[") depth++;
    else if (c === "]") {
      depth--;
      if (depth === 0) {
        end = i + 1;
        break;
      }
    }
  }
  if (end < 0) return [];
  const json = out.slice(start, end);
  try {
    const parsed = JSON.parse(json);
    const first = Array.isArray(parsed) ? parsed[0] : parsed;
    return (first?.results ?? []) as Array<Record<string, unknown>>;
  } catch {
    return [];
  }
}

function spawnWrangler(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const cmd = process.platform === "win32" ? "npx.cmd" : "npx";
    const child = spawn(cmd, ["wrangler", ...args], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", (e) => reject(e));
    child.on("close", (code) => {
      if (code === 0) resolve(stdout);
      else
        reject(
          new Error(
            `wrangler exited ${code}\n${stderr.trim() || stdout.trim()}`,
          ),
        );
    });
  });
}
