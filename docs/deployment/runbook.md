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
# production — pass the Turso credentials in, do not commit them
DATABASE_URL=libsql://... DATABASE_AUTH_TOKEN=... \
  node scripts/create-admin-user.mjs admin@email.com <password> --role super_admin
```

Passwords must be at least 10 characters, matching the console's own rule.

## Production Notes
- Provision PostgreSQL/Supabase before real traffic.
- Replace local JSON datastore with transactional database repository.
- Configure real SMS provider credentials. The SMPP path needs a dedicated host
  holding the provider-whitelisted IP — see `smpp-worker.md` in this directory.
- Set `NEXT_PUBLIC_APP_URL`, `ADMIN_ACCESS_TOKEN`, and SMS variables in hosting environment.
