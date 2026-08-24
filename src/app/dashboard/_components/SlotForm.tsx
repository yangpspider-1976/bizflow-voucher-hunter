"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { api } from "@/lib/api-client";
import { FormCard } from "./FormPage";

const emptySlot = { date: "", startTime: "", endTime: "", totalCapacity: "20" };

export type SlotRequestDraft = {
  date: string;
  startTime: string;
  endTime: string;
  totalCapacity: number;
};

function slotState(initialValues?: SlotRequestDraft) {
  return initialValues
    ? {
        date: initialValues.date,
        startTime: initialValues.startTime,
        endTime: initialValues.endTime,
        totalCapacity: String(initialValues.totalCapacity),
      }
    : emptySlot;
}

/**
 * Create (or re-request) a date/time slot.
 *
 * The date picker is bounded by the campaign window, because a slot outside it
 * is rejected on save either way — for a request, only once an admin gets to it.
 *
 * `returnHref` carries the scope the operator came from, so submitting lands
 * back on the slots list for the same campaign rather than whichever one sorts
 * first.
 */
export function SlotForm({
  campaignId,
  campaignWindow,
  requestMode = false,
  revisionRequestId,
  initialValues,
  returnHref,
}: {
  campaignId: string;
  campaignWindow: { startDate: string; endDate: string };
  requestMode?: boolean;
  revisionRequestId?: string;
  initialValues?: SlotRequestDraft;
  returnHref: string;
}) {
  const router = useRouter();
  const [slot, setSlot] = useState(() => slotState(initialValues));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError("");
    setBusy(true);
    try {
      const payload = {
        date: slot.date,
        startTime: slot.startTime,
        endTime: slot.endTime,
        totalCapacity: Number(slot.totalCapacity),
      };
      await api(
        revisionRequestId
          ? `/api/admin/change-requests/${revisionRequestId}`
          : `/api/campaigns/${campaignId}/slots`,
        { method: "POST", body: JSON.stringify(payload) },
      );
      const done = revisionRequestId
        ? "slot-revised"
        : requestMode
          ? "slot-requested"
          : "slot-created";
      router.push(appendDone(returnHref, done));
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Unable to create slot.");
      setBusy(false);
    }
  }

  return (
    <form className="form-page-form" onSubmit={handleSubmit}>
      {error ? <p className="alert form-page-alert">{error}</p> : null}

      <FormCard
        title="Slot details"
        description="The window customers can book, and how many vouchers it can take."
      >
        <div className="admin-form-grid">
          <label className="field">
            <span>Date</span>
            <input
              max={campaignWindow.endDate}
              min={campaignWindow.startDate}
              required
              type="date"
              value={slot.date}
              onChange={(event) => setSlot({ ...slot, date: event.target.value })}
            />
            <small className="muted">
              Campaign runs {campaignWindow.startDate} to {campaignWindow.endDate}.
            </small>
          </label>
          <label className="field">
            <span>Total Capacity</span>
            <input
              min={1}
              required
              type="number"
              value={slot.totalCapacity}
              onChange={(event) => setSlot({ ...slot, totalCapacity: event.target.value })}
            />
          </label>
          <label className="field">
            <span>Start Time</span>
            <input
              required
              type="time"
              value={slot.startTime}
              onChange={(event) => setSlot({ ...slot, startTime: event.target.value })}
            />
          </label>
          <label className="field">
            <span>End Time</span>
            <input
              required
              type="time"
              value={slot.endTime}
              onChange={(event) => setSlot({ ...slot, endTime: event.target.value })}
            />
          </label>
        </div>
      </FormCard>

      <div className="form-page-actions">
        <Link className="button secondary" href={returnHref}>
          Cancel
        </Link>
        <button className="button" disabled={busy} type="submit">
          {busy
            ? "Submitting..."
            : revisionRequestId
              ? "Submit Revision"
              : requestMode
                ? "Submit Request"
                : "Create Slot"}
        </button>
      </div>
    </form>
  );
}

/** Adds the flash key to a href that may already carry scope search params. */
export function appendDone(href: string, done: string) {
  return `${href}${href.includes("?") ? "&" : "?"}done=${done}`;
}
