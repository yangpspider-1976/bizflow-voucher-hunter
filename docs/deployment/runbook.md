# Deployment Runbook

## Local
1. `npm install`
2. copy `.env.example` to `.env.local` if needed
3. `npm run dev`

## Validation
- `npm run typecheck`
- `npm run lint`
- `npm run test`
- `npm run build`

## Console accounts
Normally created at `/dashboard/team` by a super admin. When no one can sign in
(the bootstrap `ADMIN_PASSWORD` is lost, or the last super admin was disabled),
create or reset one directly against the database:

```
# local
node scripts/create-admin-user.mjs admin@email.com <password>
# production — pass the connection string in, do not commit it
DATABASE_URL=postgres://... node scripts/create-admin-user.mjs admin@email.com <password> --role super_admin
```

Passwords must be at least 10 characters, matching the console's own rule.

## Database cutover (Turso to PostgreSQL)

Run in one sitting: the copy is a point-in-time snapshot, and anything written
to the old database between the copy and the switch is lost.

1. Create a PostgreSQL database **in the region the Vercel functions run in**.
   The first one provisioned here landed in `us-east-1` while the functions run
   in Tokyo, which put ~200ms on every query; moving it to Singapore made the
   integration suite three times faster on its own.

2. Copy the data, passing both connection strings in the environment:

   ```
   SOURCE_DATABASE_URL=libsql://...
   SOURCE_DATABASE_AUTH_TOKEN=...
   DATABASE_URL=postgres://...
   npx vite-node --config vitest.config.ts scripts/migrate-to-postgres.ts -- --yes
   ```

   It prints a row count per table and fails loudly if any count disagrees
   with the source.

3. Confirm `meta.schema_version` in the target matches `SCHEMA_VERSION` in
   `src/server/db.ts`. **Do not skip this.** If they differ, `init()` treats the
   database as out of date on the first request: it drops the voucher tables,
   empties every other one, and reseeds demo data over the migration.

4. Set `DATABASE_URL` in Vercel (Production) and redeploy — environment changes
   only take effect on a new deployment. `DATABASE_AUTH_TOKEN` is vestigial once
   Turso is gone and should be removed.

5. Verify in the app, not the dashboard: draw a voucher, leave the reel
   mid-spin, reopen the campaign. The button must read **Continue** and return
   to the reel holding the prize already drawn. That is the behaviour the old
   database broke, and the only check that proves the cutover worked — the
   fault was invisible to admin reads.

Rollback is putting the old `DATABASE_URL` and `DATABASE_AUTH_TOKEN` back and
redeploying: about a minute, minus anything written since the switch. Keep the
Turso database until you are satisfied.

## Production Notes
- Use a pooled PostgreSQL connection string; serverless functions open and drop connections constantly.
- Configure real SMS provider credentials. The SMPP path needs a dedicated host
  holding the provider-whitelisted IP — see `smpp-worker.md` in this directory.
- Set `NEXT_PUBLIC_APP_URL`, `ADMIN_ACCESS_TOKEN`, and SMS variables in hosting environment.
