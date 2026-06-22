# d1-migrate

Schema migrations for Cloudflare D1 — `up`, `down`, `status`, `dry-run`. The bits the first-party tooling doesn't ship.

## Install

```
npm i -D d1-migrate
```

Requires `wrangler` installed and authed.

## Use

```bash
npx d1-migrate create create_users     # generates up + down SQL files

npx d1-migrate up                      # apply pending (local)
npx d1-migrate up --remote             # apply pending (production)
npx d1-migrate up --dry-run            # print SQL, don't execute

npx d1-migrate down                    # revert most recent
npx d1-migrate status                  # show applied vs pending
```

Reads the first `[[d1_databases]]` binding from your `wrangler.toml`. Migrations live in `./migrations/`, state tracked in a `d1_migrations` table.

## License

MIT
