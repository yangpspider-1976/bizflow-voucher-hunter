# Screenshots for the Word guides

The four `scripts/build-*-guide.py` / `scripts/build-how-it-works-doc.py`
builders embed any PNG in this folder whose filename appears in their `SHOTS`
map, and print a placeholder line for anything missing. So capturing a shot is:
drop the file here under the exact name below, re-run the builder, done. No
script changes.

To re-run everything after adding images:

```
python scripts/build-customer-guide.py
python scripts/build-staff-guide.py
python scripts/build-admin-guide.py
python scripts/build-how-it-works-doc.py
```

On this machine `python` is a Microsoft Store stub — use
`%LOCALAPPDATA%\Programs\Python\Python312\python.exe`.

## Already captured

`customer-01-directory` · `customer-02-campaign` · `customer-03-roulette` ·
`customer-04-datetime` · `customer-05-voucher` · `staff-01-validate` ·
`staff-02-awarded`

## Still needed

Capture against seeded demo data, never production — these documents go to
partners, and a real customer's name, number or spend must not travel with them.

### Mobile — the customer app (4)

Portrait, one device, no status-bar clutter.

| File | Where | State to set up |
|---|---|---|
| `customer-00-signin.png` | App launch | The sign-in screen, number typed in, before the code is sent |
| `customer-06-more.png` | More tab | Signed in, with a non-zero LP balance so the wallet QR and daily rows are populated |
| `customer-07-quests.png` | Quests tab | Daily tab, with at least one mission incomplete and one claimable |
| `customer-08-shop.png` | LP Shop tab | Browse view, with at least two partners listed |

### Dashboard — staff view (4)

Sign in as a **staff** account so the narrow sidebar is what appears. A shot
taken as an admin will show links the staff guide says are not there.

| File | Route | State to set up |
|---|---|---|
| `staff-00-login.png` | `/login` | Empty form. Also used by the admin guide |
| `staff-03-result.png` | `/dashboard/staff` | A valid voucher validated, result panel showing, **before** Mark as Used |
| `staff-04-dashboard.png` | `/dashboard` | Overview with real seeded numbers, not zeroes |
| `staff-05-billing.png` | `/dashboard/billing` | A month with a statement to show |
| `staff-06-requests.png` | `/dashboard/slots` | The "Your Slot Requests" panel with a row at Pending |

### Dashboard — admin view (8)

Sign in as a **super admin**, or `admin-06-team` and `admin-08-settings` will
not exist.

| File | Route | State to set up |
|---|---|---|
| `admin-01-business.png` | `/dashboard/businesses/new` | Part-filled, with the location picker open |
| `admin-02-campaign.png` | `/dashboard/campaigns/new` | Part-filled, showing the date and mode fields |
| `admin-03-slots.png` | `/dashboard/slots` | A campaign with several slots at different capacities |
| `admin-04-pool.png` | `/dashboard/vouchers/new` | The tier form scrolled to the rarity field and the slot checkboxes |
| `admin-05-requests.png` | `/dashboard/slots` | The "Staff Slot Requests" panel with a Pending row and its approve/reject actions |
| `admin-06-team.png` | `/dashboard/team` | Several members across all three roles |
| `admin-07-missions.png` | `/dashboard/gamification/missions` | The new-mission form with its cost simulation visible |
| `admin-08-settings.png` | `/dashboard/settings` | Scrolled to show the Danger Zone and its typed confirmation |

## Why these are not captured yet

Running the dashboard locally needs `DATABASE_URL` pointing at PostgreSQL —
`src/server/db.ts` throws "Database is not configured" otherwise, and there is
no local-file mode. As of 2026-09-18 this machine has no PostgreSQL install and
no Docker, so the app cannot be started to photograph it. The Android AVD
(`voucher_hunt`) does exist, but the app on it still needs that same API.
