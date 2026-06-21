#!/usr/bin/env node
import { Command } from "commander";
import pc from "picocolors";
import { readFile, writeFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  createMigration,
  discoverMigrations,
  executeSqlFile,
  getAppliedMigrations,
  migrationsToApply,
  migrationsToRevert,
  pendingMigrations,
  resolveConfig,
  sqlForDown,
  sqlForUp,
} from "./lib.js";

const program = new Command();

program
  .name("d1-migrate")
  .description("Schema migrations for Cloudflare D1")
  .version("0.1.0");

program
  .command("create <name>")
  .description("Create a new timestamped up/down migration pair")
  .action(async (name: string) => {
    const cfg = await resolveConfig({ database: "_unused_for_create_" }).catch(
      () => ({ database: "", migrationsDir: path.join(process.cwd(), "migrations") }),
    );
    const out = await createMigration(cfg.migrationsDir, name);
    console.log(pc.green("created:"));
    console.log(`  ${path.relative(process.cwd(), out.up)}`);
    console.log(`  ${path.relative(process.cwd(), out.down)}`);
  });

program
  .command("status")
  .description("Show applied vs pending migrations")
  .option("--database <name>", "D1 database binding (default: first in wrangler config)")
  .option("--remote", "use remote D1 (default: local dev DB)", false)
  .action(async (opts: { database?: string; remote: boolean }) => {
    const cfg = await resolveConfig({ database: opts.database });
    const all = await discoverMigrations(cfg.migrationsDir);
    const applied = await getAppliedMigrations({
      database: cfg.database,
      remote: opts.remote,
    });
    const appliedSet = new Set(applied);
    console.log(pc.bold(`database: ${cfg.database}  (${opts.remote ? "remote" : "local"})`));
    if (all.length === 0) {
      console.log(pc.dim("  no migrations found"));
      return;
    }
    for (const m of all) {
      const mark = appliedSet.has(m.name) ? pc.green("[applied]") : pc.yellow("[pending]");
      console.log(`  ${mark} ${m.name}`);
    }
  });

program
  .command("up")
  .description("Apply pending migrations")
  .option("--to <name>", "apply up to (and including) this migration")
  .option("--dry-run", "print SQL without executing", false)
  .option("--database <name>", "D1 database binding")
  .option("--remote", "use remote D1", false)
  .action(
    async (opts: { to?: string; dryRun: boolean; database?: string; remote: boolean }) => {
      const cfg = await resolveConfig({ database: opts.database });
      const all = await discoverMigrations(cfg.migrationsDir);
      const applied = opts.dryRun
        ? []
        : await getAppliedMigrations({ database: cfg.database, remote: opts.remote });
      const target = migrationsToApply(all, applied, opts.to);
      if (target.length === 0) {
        console.log(pc.dim("nothing to apply"));
        return;
      }
      for (const m of target) {
        const body = await readFile(m.upFile, "utf8");
        const sql = sqlForUp(m, body);
        if (opts.dryRun) {
          console.log(pc.cyan(`-- ${m.name} (up)`));
          console.log(sql);
          continue;
        }
        const tmp = await writeTempSql(sql);
        console.log(pc.cyan(`applying: ${m.name}`));
        await executeSqlFile({ database: cfg.database, remote: opts.remote }, tmp);
      }
      if (!opts.dryRun) console.log(pc.green(`applied ${target.length} migration(s)`));
    },
  );

program
  .command("down")
  .description("Revert applied migrations")
  .option("--to <name>", "revert down to (and including) this migration")
  .option("--dry-run", "print SQL without executing", false)
  .option("--database <name>", "D1 database binding")
  .option("--remote", "use remote D1", false)
  .action(
    async (opts: { to?: string; dryRun: boolean; database?: string; remote: boolean }) => {
      const cfg = await resolveConfig({ database: opts.database });
      const all = await discoverMigrations(cfg.migrationsDir);
      const applied = opts.dryRun
        ? all.map((m) => m.name)
        : await getAppliedMigrations({ database: cfg.database, remote: opts.remote });
      const target = migrationsToRevert(all, applied, opts.to);
      if (target.length === 0) {
        console.log(pc.dim("nothing to revert"));
        return;
      }
      for (const m of target) {
        if (!m.downFile) {
          throw new Error(`no down file for ${m.name}`);
        }
        const body = await readFile(m.downFile, "utf8");
        const sql = sqlForDown(m, body);
        if (opts.dryRun) {
          console.log(pc.cyan(`-- ${m.name} (down)`));
          console.log(sql);
          continue;
        }
        const tmp = await writeTempSql(sql);
        console.log(pc.cyan(`reverting: ${m.name}`));
        await executeSqlFile({ database: cfg.database, remote: opts.remote }, tmp);
      }
      if (!opts.dryRun) console.log(pc.green(`reverted ${target.length} migration(s)`));
    },
  );

async function writeTempSql(sql: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "d1-migrate-"));
  const file = path.join(dir, "exec.sql");
  await writeFile(file, sql, "utf8");
  return file;
}

program.parseAsync(process.argv).catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(pc.red(`error: ${msg}`));
  process.exit(1);
});
