import { all, getDb } from "@/server/db";
import { manilaDateParts } from "@/server/rewards-network";
import { sendPush, type PushResult } from "@/server/push";

/**
 * Notification copy and audience selection.
 *
 * Kept separate from `push.ts` (transport) and the engines (business rules) so
 * wording lives in one place and the engines stay free of presentation.
 *
 * Every function here is fire-and-forget and must be called **after** the
 * originating transaction commits — `sendPush` performs a network call, and
 * holding a write transaction open across it would be a correctness and
 * throughput problem. This mirrors how `sendVoucherConfirmationSms` is invoked
 * from the route rather than from inside `selectFinalVoucher`.
 */

/** A referral converted and the referrer earned LP for it. */
export function notifyReferralConverted(input: {
  phone: string;
  campaignSlug: string;
  loyaltyAwarded: boolean;
}): Promise<PushResult> {
  return sendPush({
    phone: input.phone,
    category: "rewards",
    title: "Someone used your link",
    body: input.loyaltyAwarded
      ? "You earned an extra spin and 10 LP. Tap to spin again."
      : "You earned an extra spin. Tap to spin again.",
    data: { type: "referral_converted", campaignSlug: input.campaignSlug },
  });
}

/** A purchase held for fraud review was approved and the LP has landed. */
export function notifyHeldPurchaseApproved(input: {
  phone: string;
  rewardAmount: string;
  balance: string;
}): Promise<PushResult> {
  return sendPush({
    phone: input.phone,
    category: "rewards",
    title: "Your Loyalty Points are in",
    body: `${input.rewardAmount} LP has been added. Balance: ${input.balance} LP.`,
    data: { type: "loyalty_credited" },
  });
}

/**
 * The daily "come back and collect your LP" nudge.
 *
 * Deduped on the Manila date, matching how `loyalty_daily_rewards` decides
 * whether the award is still available, so a retried scheduler run cannot
 * notify the same customer twice in one day.
 */
export function notifyDailyLoyaltyAvailable(input: {
  phone: string;
  date: string;
}): Promise<PushResult> {
  return sendPush({
    phone: input.phone,
    category: "daily",
    title: "Your daily LP is waiting",
    body: "Open Voucher Hunt today to collect your daily Loyalty Points.",
    data: { type: "daily_loyalty" },
    dedupeKey: `daily:${input.phone}:${input.date}`,
  });
}

/** Upcoming reservation reminder. */
export function notifyReservationReminder(input: {
  phone: string;
  campaignSlug: string;
  businessName: string;
  time: string;
  date: string;
  voucherId: string;
}): Promise<PushResult> {
  return sendPush({
    phone: input.phone,
    category: "reservation",
    title: `Your ${input.businessName} booking is tomorrow`,
    body: `${input.time}. Show your voucher QR at the outlet.`,
    data: {
      type: "reservation_reminder",
      campaignSlug: input.campaignSlug,
      voucherId: input.voucherId,
    },
    dedupeKey: `reservation:${input.voucherId}:${input.date}`,
  });
}

/**
 * Phones that have a registered device, have not yet collected today's app-use
 * LP, and are therefore worth nudging.
 *
 * A phone with no wallet row has never opened the rewards screen; it is still
 * eligible, since the award is created on first load.
 */
export async function phonesAwaitingDailyLoyalty(): Promise<string[]> {
  const db = await getDb();
  const date = manilaDateParts().date;
  const rows = await all(
    db,
    `SELECT DISTINCT d.phone AS phone
     FROM push_devices d
     LEFT JOIN reward_wallets w ON w.phone = d.phone
     WHERE d.daily_enabled = 1
       AND NOT EXISTS (
         SELECT 1 FROM loyalty_daily_rewards r
         WHERE r.wallet_id = w.id
           AND r.reward_type = 'app_use'
           AND r.reward_date = ?
       )`,
    [date],
  );
  return rows.map((row: any) => String(row.phone));
}

export type DueReservation = {
  phone: string;
  voucherId: string;
  campaignSlug: string;
  businessName: string;
  date: string;
  startTime: string;
};

/**
 * Reservations whose slot falls on `date` (a `YYYY-MM-DD` Manila day), for
 * customers with a registered device.
 *
 * Only `Reserved` rows qualify: a redeemed or cancelled booking needs no
 * reminder.
 */
export async function reservationsDueOn(date: string): Promise<DueReservation[]> {
  const db = await getDb();
  const rows = await all(
    db,
    `SELECT u.phone AS phone,
            v.id AS voucher_id,
            c.slug AS campaign_slug,
            b.name AS business_name,
            s.date AS date,
            s.start_time AS start_time
     FROM reservations res
     JOIN vouchers v ON v.id = res.voucher_id
     JOIN users u ON u.id = res.user_id
     JOIN slots s ON s.id = res.slot_id
     JOIN campaigns c ON c.id = res.campaign_id
     JOIN businesses b ON b.id = c.business_id
     JOIN push_devices d ON d.phone = u.phone
     WHERE s.date = ?
       AND res.status = 'Reserved'
       AND d.reservation_enabled = 1`,
    [date],
  );
  return rows.map((row: any) => ({
    phone: String(row.phone),
    voucherId: String(row.voucher_id),
    campaignSlug: String(row.campaign_slug),
    businessName: String(row.business_name),
    date: String(row.date),
    startTime: String(row.start_time),
  }));
}
