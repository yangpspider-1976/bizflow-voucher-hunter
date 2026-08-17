"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "@/lib/api-client";
import type { Campaign, CampaignSlot } from "@/types/voucher";
import { FormCard } from "./FormPage";
import { SelectMenu } from "./SelectMenu";
import { appendDone } from "./SlotForm";

const LIST_HREF = "/dashboard/campaigns";

const STATUS_OPTIONS = [
  { label: "Active", value: "active" },
  { label: "Paused", value: "paused" },
  { label: "Closed", value: "closed" },
];

/** The form's own string-keyed mirror of the editable half of a campaign. */
function formState(campaign: Campaign) {
  return {
    title: campaign.title,
    offerMessage: campaign.offerMessage,
    terms: campaign.terms,
    shopUrl: campaign.shopUrl ?? "",
    status: campaign.status,
    startDate: campaign.startDate,
    endDate: campaign.endDate,
    baseAttempts: String(campaign.baseAttempts),
    referralDailyLimit: String(campaign.referralDailyLimit),
    candidateTimeoutMinutes: String(campaign.candidateTimeoutMinutes),
  };
}

function slotDate(date: string) {
  return new Intl.DateTimeFormat("en-PH", {
    day: "numeric",
    month: "short",
    weekday: "short",
    year: "numeric",
  }).format(new Date(`${date}T00:00:00+08:00`));
}

/**
 * Edit an existing campaign.
 *
 * The dates are the reason this exists. They were write-once — creation was the
 * only thing that ever set them — so a campaign whose window closed before its
 * slots (or one dated by a mistyped year) could not be rescued from the console
 * at all, and it simply vanished from the app with no way back. `heroImage` is
 * still edited on its own route, and `allowReschedule` from the list's toggle;
 * neither is duplicated here.
 */
export function EditCampaignForm({
  campaign,
  slots,
  today,
}: {
  campaign: Campaign;
  /** Every slot on the campaign; upcoming ones constrain the window. */
  slots: CampaignSlot[];
  /** Server's Manila date — "upcoming" has to mean the same thing at both ends. */
  today: string;
}) {
  const router = useRouter();
  const initial = useMemo(() => formState(campaign), [campaign]);
  const [form, setForm] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const upcomingSlots = useMemo(
    () => slots.filter((slot) => slot.date >= today).sort((a, b) => a.date.localeCompare(b.date)),
    [slots, today],
  );

  // The same rule `updateCampaign` enforces, run as you type so a window that
  // strands a slot is visible before the save is rejected rather than after.
  const strandedDates = useMemo(() => {
    if (!form.startDate || !form.endDate) return [];
    return Array.from(
      new Set(
        upcomingSlots
          .filter((slot) => slot.date < form.startDate || slot.date > form.endDate)
          .map((slot) => slot.date),
      ),
    );
  }, [form.endDate, form.startDate, upcomingSlots]);

  const datesReversed = Boolean(form.startDate && form.endDate && form.endDate < form.startDate);
  // Mirrors the public directory's filter: `status = 'active' AND end_date >= today`.
  const hiddenFromApp = form.status !== "active" || form.endDate < today;

  function update<K extends keyof typeof form>(key: K, value: (typeof form)[K]) {
    setForm((current) => ({ ...current, [key]: value }));
  }

  /**
   * Only what actually changed. Sending the whole form would re-validate fields
   * the admin never touched — and would arm the window check on every save,
   * including one that only renames a campaign already inconsistent.
   */
  function changedFields() {
    const patch: Record<string, unknown> = {};
    if (form.title !== initial.title) patch.title = form.title;
    if (form.offerMessage !== initial.offerMessage) patch.offerMessage = form.offerMessage;
    if (form.terms !== initial.terms) patch.terms = form.terms;
    if (form.status !== initial.status) patch.status = form.status;
    if (form.startDate !== initial.startDate) patch.startDate = form.startDate;
    if (form.endDate !== initial.endDate) patch.endDate = form.endDate;
    if (form.baseAttempts !== initial.baseAttempts) patch.baseAttempts = Number(form.baseAttempts);
    if (form.referralDailyLimit !== initial.referralDailyLimit) {
      patch.referralDailyLimit = Number(form.referralDailyLimit);
    }
    if (form.candidateTimeoutMinutes !== initial.candidateTimeoutMinutes) {
      patch.candidateTimeoutMinutes = Number(form.candidateTimeoutMinutes);
    }
    // The API has no way to clear a shop URL, so an emptied field means "leave
    // it alone" rather than silently failing its `url()` check.
    if (form.shopUrl.trim() && form.shopUrl.trim() !== initial.shopUrl) {
      patch.shopUrl = form.shopUrl.trim();
    }
    return patch;
  }

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError("");

    if (datesReversed) {
      setError("The end date must be on or after the start date.");
      return;
    }
    if (strandedDates.length > 0) {
      setError(
        `This window leaves ${strandedDates.length === 1 ? "an upcoming slot" : "upcoming slots"} outside it: ${strandedDates
          .map(slotDate)
          .join(", ")}. Widen the dates to cover them.`,
      );
      return;
    }

    const patch = changedFields();
    if (Object.keys(patch).length === 0) {
      setError("Nothing has changed yet.");
      return;
    }

    setBusy(true);
    try {
      await api<Campaign>(`/api/campaigns/${campaign.id}`, {
        method: "PATCH",
        body: JSON.stringify(patch),
      });
      router.push(appendDone(LIST_HREF, "campaign-saved"));
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Unable to save the campaign.");
      setBusy(false);
    }
  }

  return (
    <form className="form-page-form" onSubmit={handleSubmit}>
      {error ? <p className="alert form-page-alert">{error}</p> : null}

      <FormCard
        title="Schedule and status"
        description="Customers only see a campaign while it is active and its end date has not passed. The window also has to cover every slot they can still book."
      >
        <div className="admin-form-grid">
          <label className="field">
            <span>Start Date</span>
            <input
              required
              type="date"
              value={form.startDate}
              onChange={(event) => update("startDate", event.target.value)}
            />
          </label>
          <label className="field">
            <span>End Date</span>
            <input
              required
              type="date"
              value={form.endDate}
              onChange={(event) => update("endDate", event.target.value)}
            />
          </label>
          <SelectMenu
            hint="Paused and closed campaigns are hidden from the app."
            label="Status"
            onChange={(status) => update("status", status as Campaign["status"])}
            options={STATUS_OPTIONS}
            value={form.status}
          />
        </div>

        {datesReversed ? (
          <p className="alert" role="alert">
            The end date must be on or after the start date.
          </p>
        ) : strandedDates.length > 0 ? (
          <p className="alert" role="alert">
            {strandedDates.length === 1 ? "An upcoming slot falls" : "Upcoming slots fall"} outside
            this window: {strandedDates.map(slotDate).join(", ")}. Widen the dates to cover{" "}
            {strandedDates.length === 1 ? "it" : "them"}, or the campaign cannot be saved.
          </p>
        ) : hiddenFromApp ? (
          <p className="alert" role="alert">
            With these settings the campaign is hidden from the app
            {form.status !== "active"
              ? ` because it is ${form.status}.`
              : " because its end date has passed."}
          </p>
        ) : null}

        {upcomingSlots.length > 0 ? (
          <div className="field">
            <span>Upcoming slots this window must cover</span>
            <ul className="muted">
              {upcomingSlots.map((slot) => (
                <li key={slot.id}>
                  {slotDate(slot.date)} · {slot.startTime}–{slot.endTime}
                </li>
              ))}
            </ul>
          </div>
        ) : (
          <p className="muted">This campaign has no upcoming slots.</p>
        )}
      </FormCard>

      <FormCard
        title="Hunt rules"
        description="How many draws a customer gets, and how long a drawn voucher is held before it returns to the pool."
      >
        <div className="admin-form-grid">
          <label className="field">
            <span>Base Attempts</span>
            <input
              min={1}
              required
              type="number"
              value={form.baseAttempts}
              onChange={(event) => update("baseAttempts", event.target.value)}
            />
          </label>
          <label className="field">
            <span>Referral Daily Limit</span>
            <input
              min={0}
              required
              type="number"
              value={form.referralDailyLimit}
              onChange={(event) => update("referralDailyLimit", event.target.value)}
            />
          </label>
          <label className="field">
            <span>Candidate Timeout (minutes)</span>
            <input
              min={1}
              required
              type="number"
              value={form.candidateTimeoutMinutes}
              onChange={(event) => update("candidateTimeoutMinutes", event.target.value)}
            />
          </label>
        </div>
      </FormCard>

      <FormCard
        title="Content"
        description="The customer-facing wording. The campaign's business, category, and artwork are changed elsewhere."
      >
        <div className="admin-form-grid">
          <label className="field">
            <span>Campaign Title</span>
            <input
              required
              value={form.title}
              onChange={(event) => update("title", event.target.value)}
            />
          </label>
          <label className="field">
            <span>Shop URL (optional)</span>
            <input
              placeholder="https://example.com"
              type="url"
              value={form.shopUrl}
              onChange={(event) => update("shopUrl", event.target.value)}
            />
          </label>
        </div>
        <label className="field">
          <span>Offer Message</span>
          <textarea
            required
            rows={2}
            value={form.offerMessage}
            onChange={(event) => update("offerMessage", event.target.value)}
          />
        </label>
        <label className="field">
          <span>Terms</span>
          <textarea
            required
            rows={3}
            value={form.terms}
            onChange={(event) => update("terms", event.target.value)}
          />
        </label>
      </FormCard>

      <div className="form-page-actions">
        <Link className="button secondary" href={LIST_HREF}>
          Cancel
        </Link>
        <button
          className="button"
          disabled={busy || datesReversed || strandedDates.length > 0}
          type="submit"
        >
          {busy ? "Saving..." : "Save Campaign"}
        </button>
      </div>
    </form>
  );
}
