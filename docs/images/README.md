# Screenshots for the Word guides

The four `scripts/build-*-guide.py` / `scripts/build-how-it-works-doc.py`
builders embed any PNG in this folder whose filename appears in their `SHOTS`
map, and print a placeholder line for anything missing. So capturing a shot is:
put the file here under the exact name below, re-run the builder, done. No
script changes.

On this machine `python` is a Microsoft Store stub — use
`%LOCALAPPDATA%\Programs\Python\Python312\python.exe`.

## The dashboard shots are scripted

`scripts/capture-guide-screenshots.mjs` takes all 13 of them. Re-run it after
any dashboard UI change rather than re-cropping by hand:

```
# 1. a database for it to seed into
C:\Users\jiral\pgsql\bin\pg_ctl.exe start -D C:\Users\jiral\pgsql\data ^
  -l C:\Users\jiral\pgsql\server.log -o "-p 55432"
createdb -h 127.0.0.1 -p 55432 -U postgres voucher_hunt_shots

# 2. the app, pointed at it
$env:DATABASE_URL="postgres://postgres@127.0.0.1:55432/voucher_hunt_shots"
$env:ADMIN_SESSION_SECRET="<32+ chars>"
npm run dev

# 3. the shots (VOUCHER_CODE = an issued, unredeemed voucher, for the
#    validation-result panel; run a hunt against the seeded campaign to make one)
$env:VOUCHER_CODE="BIZ-..."
node scripts/capture-guide-screenshots.mjs
```

It reads `ADMIN_EMAIL` / `ADMIN_PASSWORD` / `STAFF_EMAIL` / `STAFF_PASSWORD`
from the environment — the local `.env` sets all four. It signs in as staff for
the staff-view shots and as super admin for the admin-view ones, because a shot
taken under the wrong role shows a sidebar the guides say is not there.

It also submits a slot request as staff on the way through. That is deliberate:
it is what puts a Pending row on both `staff-06-requests` and
`admin-05-requests`, so the two are the same request seen from each side.

## Still needed — the customer app (4)

These four are from the Android app and are **not** scripted. They need the
emulator running a dev build against a local API, which is a longer job than
the dashboard shots. Capture portrait, one device.

| File | Where | State to set up |
|---|---|---|
| `customer-00-signin.png` | App launch | Sign-in screen, number typed, before the code is sent |
| `customer-06-more.png` | More tab | Signed in, non-zero LP balance so the wallet QR and daily rows are populated |
| `customer-07-quests.png` | Quests tab | Daily tab, at least one mission incomplete and one claimable |
| `customer-08-shop.png` | LP Shop tab | Browse view, at least two partners listed |

Capture against seeded demo data, never production — these documents go to
partners, and a real customer's name, number or spend must not travel with them.
The five hunt-flow shots already here (`customer-01` … `customer-05`) predate
this note.
