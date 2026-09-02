"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { api } from "@/lib/api-client";
import type { MissionSimulation } from "@/server/gamification/mission-admin";

type Partner = { id: string; name: string };

/**
 * The mission builder.
 *
 * Two rules from §10.1 are built into the shape of this form rather than left
 * to a policy document. Nothing is edited: submitting always writes a new
 * `definition_version`, so the button says "Publish", never "Save". And nothing
 * is published unsimulated — the pre-flight has to have been run, and its
 * warnings are shown next to the button that acts on them.
 *
 * Loyalty Points are entered in whole points because that is the unit
 * operations think in; the API takes centavos, so the conversion happens on
 * submit rather than in anyone's head.
 */
export function MissionBuilder({
  partners,
  canApprove,
}: {
  partners: Partner[];
  canApprove: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [missionKey, setMissionKey] = useState("");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [type, setType] = useState("URGENT");
  const [triggerEvent, setTriggerEvent] = useState("qr_redeem");
  const [targetCount, setTargetCount] = useState("1");
  const [partnerId, setPartnerId] = useState(partners[0]?.id ?? "");
  const [minLevel, setMinLevel] = useState("1");
  const [segment, setSegment] = useState("all");
  const [segmentDays, setSegmentDays] = useState("");
  const [firstVisitOnly, setFirstVisitOnly] = useState(false);
  const [areaLat, setAreaLat] = useState("");
  const [areaLng, setAreaLng] = useState("");
  const [areaRadius, setAreaRadius] = useState("");
  const [xp, setXp] = useState("50");
  const [lp, setLp] = useState("0");
  const [funding, setFunding] = useState("PLATFORM");
  const [budget, setBudget] = useState("");
  const [quotaMode, setQuotaMode] = useState("ON_COMPLETION");
  const [globalQuota, setGlobalQuota] = useState("");
  const [userQuota, setUserQuota] = useState("1");
  const [requiresProof, setRequiresProof] = useState(false);
  const [autoClaim, setAutoClaim] = useState(true);
  const [exposureChannel, setExposureChannel] = useState("app");
  const [startsAt, setStartsAt] = useState("");
  const [endsAt, setEndsAt] = useState("");
  const [termsUrl, setTermsUrl] = useState("");

  const [simulation, setSimulation] = useState<MissionSimulation | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState("");

  /**
   * The payload both the simulation and the publish send.
   *
   * One builder rather than two, because a pre-flight that describes a slightly
   * different campaign from the one that gets published is worse than no
   * pre-flight: it tells an approver a number they have no reason to doubt.
   */
  function payload(status: string) {
    const reward = [] as Array<Record<string, unknown>>;
    if (Number(xp) > 0) reward.push({ type: "XP", amount: Number(xp) });
    if (Number(lp) > 0) {
      reward.push({
        type: "LP",
        amount: Math.round(Number(lp) * 100),
        fundingSource: funding,
      });
    }
    const area =
      areaLat && areaLng && areaRadius
        ? {
            latitude: Number(areaLat),
            longitude: Number(areaLng),
            radiusMeters: Math.round(Number(areaRadius)),
          }
        : undefined;
    return {
      missionKey: missionKey.trim(),
      type,
      title: title.trim(),
      description: description.trim(),
      triggerEvent,
      targetCount: Number(targetCount) || 1,
      minLevel: Number(minLevel) || 1,
      partnerId: partnerId || null,
      reward,
      audience: {
        segment,
        ...(segmentDays ? { segmentDays: Number(segmentDays) } : {}),
        ...(area ? { area } : {}),
        ...(firstVisitOnly ? { firstVisitOnly: true } : {}),
      },
      autoClaim,
      requiresProof,
      quotaMode,
      userQuota: Number(userQuota) || 1,
      globalQuota: globalQuota ? Number(globalQuota) : null,
      rewardBudgetCentavos: budget ? Math.round(Number(budget) * 100) : null,
      status,
      startsAt: startsAt ? new Date(startsAt).toISOString() : null,
      endsAt: endsAt ? new Date(endsAt).toISOString() : null,
      exposureChannel,
      termsUrl: termsUrl.trim() || null,
      sortOrder: 100,
    };
  }

  async function simulate() {
    setError("");
    setSaved("");
    setBusy(true);
    try {
      setSimulation(
        await api<MissionSimulation>("/api/admin/gamification/missions?simulate=1", {
          method: "POST",
          body: JSON.stringify(payload("Draft")),
        }),
      );
    } catch (caught) {
      setSimulation(null);
      setError(caught instanceof Error ? caught.message : "The simulation could not run.");
    } finally {
      setBusy(false);
    }
  }

  async function publish(status: string) {
    setError("");
    setSaved("");
    setBusy(true);
    try {
      const result = await api<{ missionKey: string; definitionVersion: number; status: string }>(
        "/api/admin/gamification/missions",
        { method: "POST", body: JSON.stringify(payload(status)) },
      );
      setSaved(
        `${result.missionKey} v${result.definitionVersion} is ${result.status.toLowerCase()}.`,
      );
      setSimulation(null);
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The mission could not be published.");
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <div className="admin-form-actions mission-builder-launch">
        <button className="button" onClick={() => setOpen(true)} type="button">
          New mission
        </button>
      </div>
    );
  }

  return (
    <div>
      <div className="admin-form-grid">
        <label className="field">
          <span>Key (lower case, digits, underscores)</span>
          <input
            onChange={(event) => setMissionKey(event.target.value)}
            placeholder="offpeak_lunch_march"
            value={missionKey}
          />
        </label>
        <label className="field">
          <span>Title</span>
          <input onChange={(event) => setTitle(event.target.value)} value={title} />
        </label>
        <label className="field">
          <span>Description</span>
          <input
            onChange={(event) => setDescription(event.target.value)}
            placeholder="Visit on a weekday afternoon and scan your voucher"
            value={description}
          />
        </label>
        <label className="field">
          <span>Type</span>
          <select onChange={(event) => setType(event.target.value)} value={type}>
            <option value="URGENT">Urgent</option>
            <option value="PARTNER">Partner</option>
            <option value="ONBOARDING">Onboarding</option>
          </select>
        </label>
        <label className="field">
          <span>Completed when</span>
          <select
            onChange={(event) => setTriggerEvent(event.target.value)}
            value={triggerEvent}
          >
            <option value="qr_redeem">A voucher QR is scanned</option>
            <option value="booking_complete">A booking is made</option>
            <option value="purchase_verified">A purchase is verified</option>
            <option value="review_verified">A review is verified</option>
            <option value="hunt_complete">A hunt is finished</option>
            <option value="voucher_select">A voucher is claimed</option>
            <option value="referral_verified">A referral converts</option>
          </select>
        </label>
        <label className="field">
          <span>How many times</span>
          <input
            onChange={(event) => setTargetCount(event.target.value)}
            type="number"
            value={targetCount}
          />
        </label>
        <label className="field">
          <span>Partner</span>
          <select onChange={(event) => setPartnerId(event.target.value)} value={partnerId}>
            <option value="">No partner (network-wide)</option>
            {partners.map((partner) => (
              <option key={partner.id} value={partner.id}>
                {partner.name}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Minimum level</span>
          <input
            onChange={(event) => setMinLevel(event.target.value)}
            type="number"
            value={minLevel}
          />
        </label>
      </div>

      <h3>Audience</h3>
      <div className="admin-form-grid">
        <label className="field">
          <span>Segment</span>
          <select onChange={(event) => setSegment(event.target.value)} value={segment}>
            <option value="all">Everyone</option>
            <option value="new">New players</option>
            <option value="dormant">Dormant players</option>
            <option value="returning">Players who just came back</option>
          </select>
        </label>
        <label className="field">
          <span>Segment window (days, optional)</span>
          <input
            onChange={(event) => setSegmentDays(event.target.value)}
            placeholder="30"
            type="number"
            value={segmentDays}
          />
        </label>
        <label className="field">
          <span>Area centre latitude</span>
          <input onChange={(event) => setAreaLat(event.target.value)} value={areaLat} />
        </label>
        <label className="field">
          <span>Area centre longitude</span>
          <input onChange={(event) => setAreaLng(event.target.value)} value={areaLng} />
        </label>
        <label className="field">
          <span>Radius (metres)</span>
          <input
            onChange={(event) => setAreaRadius(event.target.value)}
            placeholder="500"
            type="number"
            value={areaRadius}
          />
        </label>
        <label className="field">
          <span>First visit only</span>
          <input
            checked={firstVisitOnly}
            onChange={(event) => setFirstVisitOnly(event.target.checked)}
            type="checkbox"
          />
        </label>
      </div>

      <h3>Reward, quota and budget</h3>
      <div className="admin-form-grid">
        <label className="field">
          <span>XP</span>
          <input onChange={(event) => setXp(event.target.value)} type="number" value={xp} />
        </label>
        <label className="field">
          <span>Loyalty Points</span>
          <input onChange={(event) => setLp(event.target.value)} type="number" value={lp} />
        </label>
        <label className="field">
          <span>Funded by</span>
          <select onChange={(event) => setFunding(event.target.value)} value={funding}>
            <option value="PLATFORM">Voucher Hunt</option>
            <option value="PARTNER">The partner</option>
          </select>
        </label>
        <label className="field">
          <span>Campaign budget (LP)</span>
          <input onChange={(event) => setBudget(event.target.value)} type="number" value={budget} />
        </label>
        <label className="field">
          <span>Places counted</span>
          <select onChange={(event) => setQuotaMode(event.target.value)} value={quotaMode}>
            <option value="ON_COMPLETION">When somebody finishes</option>
            <option value="RESERVE_ON_JOIN">Reserved when somebody joins</option>
          </select>
        </label>
        <label className="field">
          <span>Total places</span>
          <input
            onChange={(event) => setGlobalQuota(event.target.value)}
            placeholder="Unlimited"
            type="number"
            value={globalQuota}
          />
        </label>
        <label className="field">
          <span>Times one player may do it</span>
          <input
            onChange={(event) => setUserQuota(event.target.value)}
            type="number"
            value={userQuota}
          />
        </label>
        <label className="field">
          <span>Needs evidence review</span>
          <input
            checked={requiresProof}
            onChange={(event) => setRequiresProof(event.target.checked)}
            type="checkbox"
          />
        </label>
        <label className="field">
          <span>Pays automatically</span>
          <input
            checked={autoClaim}
            onChange={(event) => setAutoClaim(event.target.checked)}
            type="checkbox"
          />
        </label>
      </div>

      <h3>Schedule and exposure</h3>
      <div className="admin-form-grid">
        <label className="field">
          <span>Starts</span>
          <input
            onChange={(event) => setStartsAt(event.target.value)}
            type="datetime-local"
            value={startsAt}
          />
        </label>
        <label className="field">
          <span>Ends</span>
          <input
            onChange={(event) => setEndsAt(event.target.value)}
            type="datetime-local"
            value={endsAt}
          />
        </label>
        <label className="field">
          <span>Announce by</span>
          <select
            onChange={(event) => setExposureChannel(event.target.value)}
            value={exposureChannel}
          >
            <option value="app">In the app only</option>
            <option value="both">In the app and by push</option>
            <option value="push">Push</option>
          </select>
        </label>
        <label className="field">
          <span>Terms URL (optional)</span>
          <input onChange={(event) => setTermsUrl(event.target.value)} value={termsUrl} />
        </label>
      </div>

      {simulation ? (
        <div className="panel">
          <h3>Before you publish</h3>
          <p className="muted">
            Upper bounds, not forecasts. Nobody can say how many people will
            actually do a mission, but nothing can cost more than this.
          </p>
          <table className="data-table">
            <tbody>
              <tr>
                <td>Players who would see it</td>
                <td>{simulation.audienceSize.toLocaleString()}</td>
              </tr>
              <tr>
                <td>Most completions possible</td>
                <td>{simulation.maxCompletions.toLocaleString()}</td>
              </tr>
              <tr>
                <td>Most it could pay</td>
                <td>{simulation.maxLpCost}</td>
              </tr>
              <tr>
                <td>Budget</td>
                <td>{simulation.budget}</td>
              </tr>
              {simulation.funding === "PARTNER" ? (
                <tr>
                  <td>Partner deposit</td>
                  <td>{simulation.partnerDeposit}</td>
                </tr>
              ) : null}
            </tbody>
          </table>
          {simulation.warnings.map((warning) => (
            <p className="alert" key={warning}>
              {warning}
            </p>
          ))}
        </div>
      ) : null}

      <div className="admin-form-actions">
        <button className="button secondary" disabled={busy} onClick={simulate} type="button">
          {busy ? "Working…" : "Simulate"}
        </button>
        <button
          className="button secondary"
          disabled={busy}
          onClick={() => publish("Draft")}
          type="button"
        >
          Save as draft
        </button>
        <button
          className="button"
          disabled={busy || !simulation}
          onClick={() => publish(canApprove ? "Active" : "Review")}
          type="button"
        >
          {canApprove ? "Publish live" : "Send for approval"}
        </button>
        <button className="button secondary" onClick={() => setOpen(false)} type="button">
          Close
        </button>
        {saved ? <span className="badge success">{saved}</span> : null}
        {error ? <span className="badge warning">{error}</span> : null}
      </div>
      {!simulation ? (
        <p className="muted">
          Run the simulation first. Publishing without knowing the audience and
          the ceiling is how a campaign empties a budget in an afternoon.
        </p>
      ) : null}
    </div>
  );
}
