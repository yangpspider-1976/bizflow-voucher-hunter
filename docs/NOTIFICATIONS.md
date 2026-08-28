# Push notifications

Ten notifications, delivered through Expo's push service (which relays to FCM,
so the server needs no Firebase credentials for the default setup).

| # | Trigger | Category | When |
|---|---|---|---|
| 1 | Daily LP nudge | `daily` | Scheduled — customers who have not collected today's app-use LP |
| 2 | Booking reminder | `reservation` | Scheduled — a day before a `Reserved` slot |
| 3 | Held purchase approved | `rewards` | Event — an admin approves a flagged scan and the LP lands |
| 4 | Referral converted | `rewards` | Event — someone opens a shared link and the referrer earns a spin (+10 LP) |
| 5 | Urgent mission published | `missions` | Event — a campaign goes live, to the players who qualify. **Marketing** |
| 6 | Daily window open | `missions` | Scheduled hourly — the time-boxed mission that is open right now |
| 7 | Closing soon | `missions` | Scheduled — a mission expiring within four hours, or a reward left unclaimed |
| 8 | Evidence reviewed | `missions` | Event — an operator approved or declined a submission |
| 9 | Level up | `rewards` | Event — a promotion that happened with the app closed |
| 10 | Badge unlocked | `rewards` | Event — an achievement tier unlocked with the app closed |

The daily nudge is the reason this exists: `loyalty_daily_rewards` grants a
random 1-10 LP once per Manila day and the product advertises "up to 600 LP in 30 days", which
only holds if the customer returns daily. Nothing else pulls them back.

## Design

**Sends never fail the operation that triggered them.** `sendPush` swallows all
errors and returns a count. Every trigger fires **after** its transaction
commits — a push is a network call, and holding a write transaction open across
it would be a correctness and throughput problem. This mirrors how
`sendVoucherConfirmationSms` is called from the route rather than from inside
`selectFinalVoucher`.

**Duplicates are prevented in the database, not the scheduler.** `push_logs`
carries a `dedupe_key` with a unique index. The daily nudge keys on
`daily:<phone>:<manila-date>` and the booking reminder on
`reservation:<voucherId>:<date>`, so re-running a job — or running it hourly —
cannot notify anyone twice.

**Dead tokens self-prune.** When Expo returns `DeviceNotRegistered` (app
uninstalled, notifications revoked), the device row is deleted rather than
retried forever.

**Tokens are keyed per install, not per phone.** Re-registering an existing
token reassigns it to the current phone, so a handed-on handset stops
delivering the previous owner's notifications. Sign-out unregisters explicitly.

## Consent, quiet hours and the cap

Three rules apply to the mission notifications, enforced inside `sendPush` so no
call site can forget one:

- **Quiet hours.** 22:00–08:00 Manila by default, published as gamification
  economy configuration and changeable without a deploy. Checked per device,
  because the opt-out is a per-device setting: a household phone whose owner
  turned quiet hours off still rings.
- **Marketing consent.** `marketing_enabled` is separate from the `missions`
  category and is required only for #5. "Tell me about my missions" and "tell me
  about partner promotions near me" are different questions, and the app asks
  them separately.
- **A frequency cap.** Three `missions` pushes per phone per Manila day, counted
  on delivered messages, however many campaigns happen to launch.

#9 and #10 are sent from the gamification hook layer after the event commits —
those are the grants that happen with the app closed. Neither clears
`announced_level` or `seen_at`, so the push tells the player and the in-app
celebration still runs when they next open it, once each.

## Layout

| File | Role |
|---|---|
| `src/server/push.ts` | Transport — Expo API, device registry, preferences, logging |
| `src/server/notifications.ts` | Copy and audience queries |
| `src/server/gamification/notify.ts` | Mission, level and badge copy, plus the consent and quiet-hours policy |
| `src/app/api/public/notifications/devices/route.ts` | Register / list / toggle / unregister |
| `src/app/api/cron/notifications/route.ts` | Scheduled fan-out |
| `apps/mobile/src/notifications/push.ts` | Permission, token, registration |
| `apps/mobile/src/notifications/useNotificationRouting.ts` | Routes a tapped notification |
| `apps/mobile/src/components/NotificationSettings.tsx` | Per-category opt-out in More |

## Scheduling

Set `CRON_SECRET`, then call the endpoint on a schedule. It refuses to run when
the variable is unset, so a misconfigured deploy is never publicly invocable.

```
POST /api/cron/notifications?job=daily        # once a day, mid-morning Manila
POST /api/cron/notifications?job=reservation  # once a day
POST /api/cron/notifications?job=missions     # hourly: open windows, closing soon
POST /api/cron/notifications                  # all three
Authorization: Bearer $CRON_SECRET
```

Both jobs are safe to over-run, because every send is deduped. On Vercel, add to
`vercel.json` (Vercel Cron sends the secret as a bearer token automatically):

```json
{
  "crons": [
    { "path": "/api/cron/notifications?job=daily", "schedule": "0 2 * * *" },
    { "path": "/api/cron/notifications?job=reservation", "schedule": "30 2 * * *" }
  ]
}
```

`0 2 * * *` UTC is 10:00 Manila. Vercel Cron only accepts UTC.

## Opt-out

Three independent categories (`daily`, `reservation`, `rewards`), all on by
default, toggled per phone from the app's More screen. The toggles are hidden
when no device is registered, since they could not take effect.

## Before the Play release

- **A development or production build is required.** Remote push has not worked
  in Expo Go on Android since SDK 53, and emulators have no push transport —
  `acquirePushToken` returns `null` on both, so nothing registers.
- **`projectId` must resolve.** The token request needs an EAS project id from
  `expoConfig.extra.eas.projectId`. Until `eas init` has run (Phase 6), it is
  absent and registration is skipped.
- **Data Safety form.** Declare the push token as collected data.
- **Android 13+** shows a runtime permission prompt. It is requested right after
  OTP verification, so the ask arrives in context rather than cold at launch.
