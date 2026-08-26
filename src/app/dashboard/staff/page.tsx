"use client";

import Image from "next/image";
import { useEffect, useRef, useState } from "react";
import {
  FiAlertTriangle,
  FiCalendar,
  FiCamera,
  FiCheck,
  FiClock,
  FiCreditCard,
  FiGift,
  FiSearch,
  FiStopCircle,
  FiUpload,
  FiUser,
  FiXCircle,
} from "react-icons/fi";
import type { IScannerControls } from "@zxing/browser";
import { ApiError, api } from "@/lib/api-client";
import { MAX_MONEY_PESOS } from "@/lib/limits";
import { toDisplayPhone } from "@/lib/phone-display";
import type { Campaign, CampaignSlot, EndUser, Voucher } from "@/types/voucher";
import { SelectMenu } from "../_components/SelectMenu";

type Validation = {
  voucher: Voucher;
  user?: EndUser;
  slot?: CampaignSlot;
  campaign?: Campaign;
  business?: { name: string };
  /** Set only when the tier carries one; the server rejects a smaller sale. */
  minimumSpend?: number;
  /**
   * The slot has not opened yet, judged in the slot's own timezone. Advisory
   * only — the voucher is valid and redemption is not blocked.
   */
  slotNotStarted?: boolean;
};

/**
 * The other thing a customer can present at the counter: a voucher bought with
 * Loyalty Points, either a plain balance or one pinned to a storefront item.
 */
type LpValidation = {
  voucher: {
    voucherCode: string;
    remainingCentavos: number;
    /**
     * Set on fixed-denomination vouchers converted from global LP. Its presence
     * means the checkout must enter the bill and the voucher goes in one piece.
     */
    minimumSpendCentavos?: number;
    status: string;
    expiresAt?: string;
  };
  wallet: { maskedPhone: string; status: string };
  product?: {
    id: string;
    name: string;
    description: string;
    businessId: string;
    businessName: string;
  };
};

const statusPresentation: Record<Voucher["status"], { label: string; tone: "success" | "warning" | "danger"; icon: typeof FiCheck }> = {
  Issued: { label: "Valid & Confirmed", tone: "success", icon: FiCheck },
  Delivered: { label: "Valid & Confirmed", tone: "success", icon: FiCheck },
  Redeemed: { label: "Already Used", tone: "warning", icon: FiAlertTriangle },
  Expired: { label: "Voucher Expired", tone: "danger", icon: FiXCircle },
  Cancelled: { label: "Voucher Cancelled", tone: "danger", icon: FiXCircle },
  NoShow: { label: "Marked as No-show", tone: "danger", icon: FiXCircle },
};

function statusExplanation(validation: Validation) {
  switch (validation.voucher.status) {
    case "Expired":
      return `This voucher expired on ${new Date(validation.voucher.expiresAt).toLocaleString()} and can no longer be redeemed.`;
    case "Redeemed":
      return "This voucher has already been redeemed and cannot be used again.";
    case "Cancelled":
      return "This reservation was cancelled, so its voucher is no longer valid.";
    case "NoShow":
      return "This reservation was marked as a no-show and its voucher can no longer be redeemed.";
    case "Issued":
    case "Delivered":
      return "This voucher is active and can be marked as used.";
  }
}

export default function StaffPage() {
  const [code, setCode] = useState("");
  const [purchaseAmount, setPurchaseAmount] = useState("");
  const [note, setNote] = useState("");
  const [result, setResult] = useState<Validation | null>(null);
  const [lpResult, setLpResult] = useState<LpValidation | null>(null);
  const [lpAmount, setLpAmount] = useState("");
  // The bill a fixed-denomination voucher is being applied to, which is a
  // different number from how much of the voucher is spent.
  const [lpPurchaseAmount, setLpPurchaseAmount] = useState("");
  const [validationFailure, setValidationFailure] = useState<{
    message: string;
    title: string;
  } | null>(null);
  const [rescheduleSlots, setRescheduleSlots] = useState<CampaignSlot[]>([]);
  const [newSlotId, setNewSlotId] = useState("");
  const [scanMessage, setScanMessage] = useState("");
  const [scanMessageTone, setScanMessageTone] = useState<
    "error" | "info" | "success"
  >("info");
  const [scanning, setScanning] = useState(false);
  // No camera (typical on desktop) → hide "Scan QR" entirely and let upload fill
  // the row, instead of offering a button that only ever errors.
  const [cameraAvailable, setCameraAvailable] = useState(false);
  const [validationToast, setValidationToast] = useState<{
    id: number;
    message: string;
    tone: "error" | "success";
  } | null>(null);
  const [validationToastExiting, setValidationToastExiting] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const scannerControlsRef = useRef<IScannerControls | null>(null);
  const uploadRef = useRef<HTMLInputElement>(null);

  function showAdminToast(
    message: string,
    tone: "error" | "success" = "error",
  ) {
    setValidationToastExiting(false);
    setValidationToast({ id: Date.now(), message, tone });
  }

  async function validate(codeOrToken = code) {
    try {
      const validation = await api<Validation>("/api/staff/vouchers/validate", {
        method: "POST",
        body: JSON.stringify({ codeOrToken }),
      });
      setValidationFailure(null);
      setLpResult(null);
      setResult(validation);
    } catch (error) {
      // Staff should not have to know which kind of code they are holding, so
      // a miss on campaign vouchers falls through to Loyalty Points vouchers
      // before anything is reported as invalid.
      if (error instanceof ApiError && error.code === "E-VOUCHER-404") {
        try {
          const lp = await api<LpValidation>(
            "/api/staff/rewards/validate-voucher",
            { method: "POST", body: JSON.stringify({ codeOrToken }) },
          );
          setResult(null);
          setValidationFailure(null);
          setLpResult(lp);
          // Both an item voucher and a fixed-denomination one go in whole, so
          // the amount is prefilled and locked rather than typed.
          setLpAmount(
            lp.product || lp.voucher.minimumSpendCentavos
              ? (lp.voucher.remainingCentavos / 100).toString()
              : "",
          );
          setLpPurchaseAmount("");
          return;
        } catch {
          // Not an LP voucher either — fall through to the original message.
        }
      }
      setResult(null);
      setLpResult(null);
      const nextMessage =
        error instanceof Error ? error.message : "Unable to validate voucher.";
      setValidationFailure(
        error instanceof ApiError && error.code === "E-VOUCHER-404"
          ? {
              title: "Voucher Not Found",
              message:
                "This code or QR token does not match any voucher. Check the value and try again.",
            }
          : {
              title: "Validation Failed",
              message: nextMessage,
            },
      );
      showAdminToast(nextMessage);
    }
  }

  useEffect(() => {
    if (!validationToast) return;
    const fadeTimeout = window.setTimeout(
      () => setValidationToastExiting(true),
      3400,
    );
    const dismissTimeout = window.setTimeout(() => {
      setValidationToast(null);
      setValidationToastExiting(false);
    }, 4000);
    return () => {
      window.clearTimeout(fadeTimeout);
      window.clearTimeout(dismissTimeout);
    };
  }, [validationToast]);

  // Detect a video input once on mount. enumerateDevices reports the device kind
  // even before camera permission is granted, so this works pre-permission.
  useEffect(() => {
    let active = true;
    const media = navigator.mediaDevices;
    if (!media?.enumerateDevices) {
      setCameraAvailable(false);
      return;
    }
    media
      .enumerateDevices()
      .then((devices) => {
        if (active) {
          setCameraAvailable(
            devices.some((device) => device.kind === "videoinput"),
          );
        }
      })
      .catch(() => {
        if (active) setCameraAvailable(false);
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (!scanning || !videoRef.current) return;

    let cancelled = false;
    async function startCamera() {
      setScanMessageTone("info");
      setScanMessage("Point the camera at the voucher QR code.");
      try {
        const { BrowserQRCodeReader } = await import("@zxing/browser");
        if (cancelled || !videoRef.current) return;

        const reader = new BrowserQRCodeReader();
        const controls = await reader.decodeFromConstraints(
          { video: { facingMode: { ideal: "environment" } }, audio: false },
          videoRef.current,
          (scanResult, _error, activeControls) => {
            if (!scanResult) return;
            const value = scanResult.getText().trim();
            activeControls.stop();
            scannerControlsRef.current = null;
            setCode(value);
            setScanning(false);
            setScanMessageTone("success");
            setScanMessage("QR scanned successfully.");
            void validate(value);
          },
        );

        if (cancelled) {
          controls.stop();
          return;
        }
        scannerControlsRef.current = controls;
      } catch (error) {
        setScanning(false);
        setScanMessageTone("error");
        setScanMessage(
          error instanceof Error && error.name === "NotAllowedError"
            ? "Camera permission was denied. Allow camera access or upload a QR image instead."
            : "Unable to start the camera. Upload a QR image instead.",
        );
      }
    }

    void startCamera();
    return () => {
      cancelled = true;
      scannerControlsRef.current?.stop();
      scannerControlsRef.current = null;
    };
    // validate intentionally uses the latest scanned value passed as an argument.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scanning]);

  function stopScanner() {
    scannerControlsRef.current?.stop();
    scannerControlsRef.current = null;
    setScanning(false);
    setScanMessageTone("info");
    setScanMessage("");
  }

  async function decodeUpload(file?: File) {
    if (!file) return;
    setScanMessageTone("info");
    setScanMessage("Reading QR image...");
    const url = URL.createObjectURL(file);
    try {
      const { BrowserQRCodeReader } = await import("@zxing/browser");
      const result = await new BrowserQRCodeReader().decodeFromImageUrl(url);
      const value = result.getText().trim();
      setCode(value);
      setScanMessageTone("success");
      setScanMessage("QR image read successfully.");
      await validate(value);
    } catch {
      setScanMessageTone("error");
      setScanMessage("No readable QR code was found in that image.");
    } finally {
      URL.revokeObjectURL(url);
      if (uploadRef.current) uploadRef.current.value = "";
    }
  }

  async function redeem() {
    const nextPurchaseAmount = purchaseAmount.trim()
      ? Number(purchaseAmount)
      : undefined;
    if (
      nextPurchaseAmount !== undefined &&
      (!Number.isFinite(nextPurchaseAmount) || nextPurchaseAmount < 0)
    ) {
      showAdminToast("Enter a valid purchase amount.");
      return;
    }

    try {
      const redeemed = await api<
        Validation & {
          loyalty?: { awarded: boolean; amount?: string; balance?: string; reason?: string };
        }
      >("/api/staff/vouchers/redeem", {
        method: "POST",
        body: JSON.stringify({
          codeOrToken: code,
          purchaseAmount: nextPurchaseAmount,
          note: note.trim() || undefined,
        })
      });
      setResult(redeemed);
      // The 5% is awarded automatically with the sale, so staff are told what
      // the customer earned without having to check anywhere else.
      showAdminToast(
        redeemed.loyalty?.awarded
          ? `Voucher used — ${redeemed.loyalty.amount} awarded to the customer.`
          : redeemed.loyalty?.reason
            ? `Voucher used, but no Loyalty Points: ${redeemed.loyalty.reason}`
            : "Voucher marked as used successfully.",
        // Still a success either way: the voucher was accepted. Only the
        // Loyalty Points side can come up short, and the message says so.
        "success",
      );
    } catch (error) {
      showAdminToast(
        error instanceof Error ? error.message : "Unable to redeem voucher.",
      );
    }
  }

  async function redeemLpVoucher() {
    if (!lpResult) return;
    try {
      const redeemed = await api<{
        amount: string;
        settlementAmount: string;
        voucher: LpValidation["voucher"];
      }>("/api/staff/rewards/redeem", {
        method: "POST",
        body: JSON.stringify({
          codeOrToken: lpResult.voucher.voucherCode,
          businessId: lpResult.product?.businessId,
          amount: lpAmount,
          purchaseAmount: lpPurchaseAmount || undefined,
        }),
      });
      setLpResult({ ...lpResult, voucher: redeemed.voucher });
      showAdminToast(
        lpResult.product
          ? `${lpResult.product.name} handed over — ${redeemed.amount} credited to this partner.`
          : `${redeemed.amount} payment recorded.`,
        "success",
      );
    } catch (error) {
      showAdminToast(
        error instanceof Error ? error.message : "Unable to accept LP voucher.",
      );
    }
  }

  async function markNoShowAction() {
    try {
      await api("/api/staff/vouchers/no-show", {
        method: "POST",
        body: JSON.stringify({ codeOrToken: code }),
      });
      showAdminToast("Reservation marked as no-show.", "success");
      await validate(code);
    } catch (error) {
      showAdminToast(error instanceof Error ? error.message : "Unable to mark no-show.");
    }
  }

  async function rescheduleAction() {
    if (!newSlotId) {
      showAdminToast("Choose a new slot first.");
      return;
    }
    try {
      await api("/api/staff/reservations/reschedule", {
        method: "POST",
        body: JSON.stringify({ codeOrToken: code, newSlotId }),
      });
      showAdminToast("Reservation rescheduled.", "success");
      setNewSlotId("");
      await validate(code);
    } catch (error) {
      showAdminToast(error instanceof Error ? error.message : "Unable to reschedule.");
    }
  }

  // Load alternate slots when the current voucher belongs to a reschedule-enabled campaign.
  useEffect(() => {
    const slug = result?.campaign?.slug;
    if (!slug || !result?.campaign?.allowReschedule) {
      setRescheduleSlots([]);
      return;
    }
    let active = true;
    api<Array<CampaignSlot & { remainingPoolQuantity: number }>>(`/api/public/campaigns/${slug}/slots`)
      .then((slots) => {
        if (active) {
          setRescheduleSlots(
            slots.filter((slot) => slot.status === "active" && slot.remainingCapacity > 0 && slot.id !== result.slot?.id),
          );
        }
      })
      .catch(() => {
        if (active) setRescheduleSlots([]);
      });
    return () => {
      active = false;
    };
  }, [result?.campaign?.slug, result?.campaign?.allowReschedule, result?.slot?.id]);

  const presentation = result ? statusPresentation[result.voucher.status] : undefined;
  const canRedeem = result?.voucher.status === "Issued" || result?.voucher.status === "Delivered";
  // Mirrors the server's rule so the checkout learns before pressing the button
  // rather than through a rejected request. A blank amount stays allowed: it
  // records the visit without a sale to judge.
  const belowMinimumSpend =
    result?.minimumSpend !== undefined &&
    purchaseAmount.trim() !== "" &&
    Number(purchaseAmount) < result.minimumSpend;
  const isRestaurant = result?.campaign?.mode === "restaurant";
  const canManageReservation = canRedeem && isRestaurant;

  return (
    <>
      <header className="admin-topbar">
        <div>
          <h1>Scan &amp; Redeem</h1>
          <p className="muted">Scan the customer’s QR code or type their voucher code, check it is valid, then record the sale.</p>
        </div>
      </header>

      <div className="admin-grid">
        <section className="panel span-6 staff-validation-panel">
          <h2>Validate Voucher</h2>
          <label className="field">
            <span>Voucher Code or QR Token</span>
            <input value={code} onChange={(event) => setCode(event.target.value)} placeholder="BF20-15MAY-12PM-X7A8" />
          </label>
          <div
            className={`qr-input-actions ${cameraAvailable ? "" : "single"}`}
          >
            {cameraAvailable ? (
              <button
                className="button secondary qr-action qr-action-camera"
                onClick={() => setScanning(true)}
                type="button"
              >
                <FiCamera aria-hidden="true" />
                Scan QR
              </button>
            ) : null}
            <button
              className="button secondary qr-action"
              onClick={() => uploadRef.current?.click()}
              type="button"
            >
              <FiUpload aria-hidden="true" />
              Upload QR Image
            </button>
            <input
              ref={uploadRef}
              accept="image/*"
              className="visually-hidden"
              onChange={(event) => void decodeUpload(event.target.files?.[0])}
              type="file"
            />
          </div>
          {scanning ? (
            <div className="qr-scanner">
              <video ref={videoRef} muted playsInline />
              <span className="qr-scanner-frame" aria-hidden="true" />
              <button
                aria-label="Stop QR scanner"
                className="qr-scanner-stop"
                onClick={stopScanner}
                type="button"
              >
                <FiStopCircle aria-hidden="true" />
                Stop scanning
              </button>
            </div>
          ) : null}
          {scanMessage ? (
            <p
              className={`qr-scan-message ${scanMessageTone}`}
              role={scanMessageTone === "error" ? "alert" : "status"}
            >
              {scanMessage}
            </p>
          ) : null}
          <label className="field">
            <span className="field-label-row">
              <span>Internal Note (optional)</span>
              <small>{note.length}/500</small>
            </span>
            <textarea
              className="staff-note"
              maxLength={500}
              rows={4}
              value={note}
              onChange={(event) => setNote(event.target.value)}
            />
          </label>
          <button
            className="button full staff-panel-action staff-validate-button"
            disabled={!code}
            onClick={() => void validate()}
          >
            <FiSearch aria-hidden="true" />
            Validate voucher
          </button>
        </section>

        <section className="panel span-6 staff-result-panel">
          <h2 className="staff-result-heading">Validation Result</h2>
          {result && presentation ? (
            <>
              {presentation.tone === "success" ? (
                <div className="confirmation-check staff-confirmation-check">
                  <Image
                    alt="Valid and confirmed"
                    height={76}
                    priority
                    src="/assets/confirmation-check.png"
                    width={76}
                  />
                </div>
              ) : result.voucher.status === "Redeemed" ? (
                <div className="confirmation-check staff-confirmation-check used-voucher-check">
                  <Image
                    alt="Voucher already used"
                    height={76}
                    priority
                    src="/assets/already-used-voucher.png"
                    width={76}
                  />
                </div>
              ) : (
                <div className={`checkmark ${presentation.tone}`}>
                  <presentation.icon aria-hidden="true" />
                </div>
              )}
              <h3 className="staff-result-status">{presentation.label}</h3>
              <p
                className={`staff-result-explanation ${presentation.tone}`}
                role="status"
              >
                {statusExplanation(result)}
              </p>
              {/*
                Only worth saying while the voucher can still be used: on an
                already-redeemed or cancelled one the slot time is history, and
                a second notice under the first would just crowd the result.
              */}
              {result.slotNotStarted && canRedeem && result.slot ? (
                <p className="staff-result-explanation warning" role="status">
                  Not redeemable yet — this voucher&apos;s slot starts on{" "}
                  {result.slot.date} at {result.slot.startTime}. It is still
                  valid, so you can serve an early arrival if you choose.
                </p>
              ) : null}
              <div className="summary-list staff-result-summary">
                <div className="summary-row">
                  <span className="icon-box">
                    <FiUser aria-hidden="true" />
                  </span>
                  <div>
                    <strong>Customer</strong>
                    <p className="muted">{result.user?.name || "Unknown"} · {result.user?.phone ? toDisplayPhone(result.user.phone) : "-"}</p>
                  </div>
                </div>
                <div className="summary-row">
                  <span className="icon-box">
                    <FiGift aria-hidden="true" />
                  </span>
                  <div>
                    <strong>Benefit</strong>
                    <p className="muted">{result.voucher.displayLabel}</p>
                  </div>
                </div>
                {result.minimumSpend !== undefined ? (
                  <div className="summary-row">
                    <span className="icon-box">
                      <FiAlertTriangle aria-hidden="true" />
                    </span>
                    <div>
                      <strong>Minimum Spend</strong>
                      <p className="muted">
                        ₱{result.minimumSpend.toLocaleString()} — this voucher
                        cannot be used on a smaller bill.
                      </p>
                    </div>
                  </div>
                ) : null}
                <div className="summary-row">
                  <span className="icon-box">
                    <FiClock aria-hidden="true" />
                  </span>
                  <div>
                    <strong>Selected Slot</strong>
                    <p className="muted">{result.slot ? `${result.slot.date} ${result.slot.startTime}-${result.slot.endTime}` : "-"}</p>
                  </div>
                </div>
                <div className="summary-row">
                  <span className="icon-box">
                    <FiCalendar aria-hidden="true" />
                  </span>
                  <div>
                    <strong>Expires</strong>
                    <p className="muted">{new Date(result.voucher.expiresAt).toLocaleString()}</p>
                  </div>
                </div>
              </div>
              {/* The amount belongs to the redemption, not the lookup: it is only
                  meaningful once a voucher has been confirmed, and it is what
                  the customer's 5% is calculated from. */}
              {canRedeem ? (
                <label className="field staff-amount-field">
                  <span>Amount paid (₱)</span>
                  <input
                    value={purchaseAmount}
                    onChange={(event) => setPurchaseAmount(event.target.value)}
                    placeholder="0.00"
                    type="number"
                    min={0}
                    // The server refuses anything above this. Saying so on the
                    // field is the difference between a typo caught while it is
                    // still being typed and a rejected redemption at a counter.
                    max={MAX_MONEY_PESOS}
                  />
                  {belowMinimumSpend ? (
                    <small className="alert" role="alert">
                      Below the ₱{result.minimumSpend?.toLocaleString()} minimum
                      spend for this voucher. It cannot be marked as used.
                    </small>
                  ) : (
                    <small className="muted">
                      The customer earns 5% of this as Loyalty Points. Leave blank
                      to record the visit without awarding points.
                    </small>
                  )}
                </label>
              ) : null}
              <button className="button full staff-panel-action" disabled={!canRedeem || belowMinimumSpend} onClick={redeem}>Mark as Used</button>
              {canManageReservation ? (
                <div className="staff-reservation-actions">
                  <button className="button secondary full" onClick={markNoShowAction} type="button">
                    <FiStopCircle aria-hidden="true" />
                    Mark No-show
                  </button>
                  {result?.campaign?.allowReschedule ? (
                    <div className="staff-reschedule-row">
                      <SelectMenu
                        ariaLabel="Move reservation to another slot"
                        className="staff-reschedule-select"
                        onChange={setNewSlotId}
                        options={rescheduleSlots.map((slot) => ({
                          value: slot.id,
                          label: `${slot.date} ${slot.startTime}-${slot.endTime}`,
                          hint: `${slot.remainingCapacity} left`,
                        }))}
                        placeholder="Move to another slot…"
                        value={newSlotId}
                      />
                      <button className="button secondary" disabled={!newSlotId} onClick={rescheduleAction} type="button">
                        Reschedule
                      </button>
                    </div>
                  ) : null}
                </div>
              ) : null}
            </>
          ) : lpResult ? (
            <>
              {/* A Loyalty Points voucher. Same panel, because to staff this is
                  the same job: a customer presented a code. */}
              <span
                className={`staff-result-empty-icon ${
                  lpResult.voucher.status === "Active" ? "" : "danger"
                }`}
              >
                <FiGift aria-hidden="true" />
              </span>
              <h3 className="staff-result-status">
                {lpResult.product
                  ? lpResult.product.name
                  : "Loyalty Points voucher"}
              </h3>
              <p
                className={`staff-result-explanation ${
                  lpResult.voucher.status === "Active" ? "success" : "warning"
                }`}
              >
                {lpResult.voucher.status === "Active"
                  ? lpResult.product
                    ? `Hand this item over at ${lpResult.product.businessName}.`
                    : "This voucher is active and can be accepted as payment."
                  : `This voucher is ${lpResult.voucher.status.toLowerCase()} and cannot be accepted.`}
              </p>
              <div className="summary-list staff-result-summary">
                <div className="summary-row">
                  <span className="icon-box">
                    <FiUser aria-hidden="true" />
                  </span>
                  <div>
                    <strong>Customer</strong>
                    <p className="muted">{lpResult.wallet.maskedPhone}</p>
                  </div>
                </div>
                <div className="summary-row">
                  <span className="icon-box">
                    <FiGift aria-hidden="true" />
                  </span>
                  <div>
                    <strong>Voucher</strong>
                    <p className="muted">{lpResult.voucher.voucherCode}</p>
                  </div>
                </div>
                <div className="summary-row">
                  <span className="icon-box">
                    <FiCreditCard aria-hidden="true" />
                  </span>
                  <div>
                    <strong>Remaining</strong>
                    <p className="muted">
                      {(lpResult.voucher.remainingCentavos / 100).toLocaleString(
                        "en-PH",
                      )}{" "}
                      LP
                    </p>
                  </div>
                </div>
              </div>
              {lpResult.voucher.status === "Active" ? (
                <>
                  <label className="field staff-amount-field">
                    <span>
                      {lpResult.product
                        ? "Item price (fixed)"
                        : lpResult.voucher.minimumSpendCentavos
                          ? "Voucher value (fixed)"
                          : "LP to accept"}
                    </span>
                    <input
                      inputMode="decimal"
                      onChange={(event) => setLpAmount(event.target.value)}
                      placeholder="0.00"
                      readOnly={Boolean(
                        lpResult.product || lpResult.voucher.minimumSpendCentavos,
                      )}
                      value={lpAmount}
                    />
                    <small className="muted">
                      {lpResult.product
                        ? "An item voucher is redeemed in full, at the partner that sold it."
                        : lpResult.voucher.minimumSpendCentavos
                          ? "A fixed voucher is applied whole — it is not spent down."
                          : "The partner is credited this amount on their monthly statement."}
                    </small>
                  </label>
                  {/*
                    Only fixed vouchers carry a floor, and the server refuses
                    them without a bill to check it against, so the field appears
                    exactly when it is required rather than sitting empty on
                    every scan.
                  */}
                  {lpResult.voucher.minimumSpendCentavos ? (
                    <label className="field staff-amount-field">
                      <span>Purchase amount</span>
                      <input
                        inputMode="decimal"
                        onChange={(event) =>
                          setLpPurchaseAmount(event.target.value)
                        }
                        placeholder="0.00"
                        value={lpPurchaseAmount}
                      />
                      <small className="muted">
                        This voucher applies to bills of ₱
                        {(
                          lpResult.voucher.minimumSpendCentavos / 100
                        ).toLocaleString()}{" "}
                        or more.
                      </small>
                    </label>
                  ) : null}
                </>
              ) : null}
              <button
                className="button full staff-panel-action"
                disabled={
                  lpResult.voucher.status !== "Active" ||
                  !lpAmount.trim() ||
                  // A fixed voucher cannot be submitted without the bill: the
                  // server would only reject it a round trip later.
                  Boolean(
                    lpResult.voucher.minimumSpendCentavos &&
                      !lpPurchaseAmount.trim(),
                  )
                }
                onClick={redeemLpVoucher}
                type="button"
              >
                {lpResult.product ? "Confirm Handover" : "Accept LP Payment"}
              </button>
            </>
          ) : validationFailure ? (
            <div className="staff-result-empty staff-result-invalid">
              <div className="staff-result-empty-content">
                <span className="staff-result-empty-icon danger">
                  <FiXCircle aria-hidden="true" />
                </span>
                <h3>{validationFailure.title}</h3>
                <p>{validationFailure.message}</p>
              </div>
            </div>
          ) : (
            <div className="staff-result-empty">
              <div className="staff-result-empty-content">
                <span className="staff-result-empty-icon">
                  <FiSearch aria-hidden="true" />
                </span>
                <p>Enter a voucher code or scan a QR code. Both booking vouchers and Loyalty Points vouchers are accepted here.</p>
              </div>
            </div>
          )}
        </section>
      </div>
      {validationToast ? (
        <div
          className={`snackbar admin-snackbar ${validationToast.tone === "success" ? "success" : ""} ${validationToastExiting ? "snackbar-exit" : ""}`}
          role={validationToast.tone === "error" ? "alert" : "status"}
          aria-live={validationToast.tone === "error" ? "assertive" : "polite"}
        >
          {validationToast.tone === "success" ? (
            <FiCheck aria-hidden="true" />
          ) : (
            <FiXCircle aria-hidden="true" />
          )}
          {validationToast.message}
        </div>
      ) : null}
    </>
  );
}
