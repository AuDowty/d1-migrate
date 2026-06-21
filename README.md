# d1-migrate

Schema migrations for Cloudflare D1 — `up`, `down`, `status`, `dry-run`. The bits the first-party tooling doesn't ship.

## Install

```
npm i -D d1-migrate
# or one-shot
npx d1-migrate --help
```

Requires `wrangler` installed and authed (it's used under the hood for the actual SQL execution).

## Use

Create a migration:

```
npx d1-migrate create create_users
```

Generates `migrations/0001_create_users.up.sql` and `0001_create_users.down.sql`. Edit each.

Apply pending:

```
npx d1-migrate up                # local dev D1
npx d1-migrate up --remote       # production
npx d1-migrate up --dry-run      # print SQL, don't execute
npx d1-migrate up --to 0003_seed # apply up to (and including) one
```

Revert:

```
npx d1-migrate down              # most recent
npx d1-migrate down --to 0002    # revert until 0002 is rolled back too
npx d1-migrate down --dry-run
```

Show what's applied vs pending:

```
npx d1-migrate status
```

## Config

Reads the first `[[d1_databases]]` binding from `wrangler.toml` / `wrangler.json[c]`. Override with `--database <binding>`.

Migrations live in `./migrations/`. State is tracked in a `d1_migrations` table created on first run.

## License

MIT.
