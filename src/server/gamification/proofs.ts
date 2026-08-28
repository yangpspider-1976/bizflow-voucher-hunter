/**
 * Evidence submission and review.
 *
 * Some urgent missions cannot be verified by an event. "Order the set menu",
 * "post a photo of the new branch", "show us the receipt" — a QR scan proves
 * somebody was there, not what they did. Those missions carry `requires_proof`,
 * finish in VERIFYING rather than CLAIMABLE, and pay only once a person has
 * looked at what was submitted.
 *
 * Two tables, deliberately. `mission_proofs` is the decision — who submitted
 * what, who reviewed it, and why they said no — and is read by the queue, the
 * support screens and the mission engine. `mission_proof_files` is the picture,
 * read by nothing except the one endpoint that renders it for a reviewer, and
 * emptied on a retention schedule. Keeping a receipt image out of the row that
 * every other query touches is the whole reason the split exists.
 */
import crypto from "node:crypto";
import type { MissionProofKind, MissionProofResult, MissionProofState, MissionState } from "@bizflow/shared";
import { all, getDb, one, run, withTx, type Exec } from "@/server/db";
import { AppError } from "@/server/errors";
import { ensureRewardWallet, recordRewardAudit } from "@/server/rewards-network";
import { publishEvent } from "./events";
import { definitionFor, payMission } from "./missions";

const isoNow = () => new Date().toISOString();
const id = (prefix: string) => `${prefix}_${crypto.randomBytes(10).toString("hex")}`;

/**
 * The largest image a phone may send, decoded.
 *
 * Two megabytes is a generous receipt photo and a hard ceiling on what one
 * mission can put in a row. The app should downscale before it uploads; this is
 * the wall behind that, not the intended limit.
 */
export const MAX_PROOF_BYTES = 2 * 1024 * 1024;

/** What a browser will render and what a decoder will not surprise us with. */
const ALLOWED_CONTENT_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

/**
 * How long a submitted image is kept.
 *
 * Long enough to settle a dispute about a rejected mission, short enough that
 * an approved one does not leave somebody's receipt on our disk indefinitely.
 * The decision row outlives it; only the picture goes.
 */
const PROOF_FILE_RETENTION_DAYS = 90;

export type ProofSubmission = {
  phone: string;
  missionKey: string;
  kind: MissionProofKind;
  note?: string;
  file?: { contentBase64: string; contentType: string } | null;
};

/**
 * Records one player's evidence for one mission.
 *
 * Idempotency here is not a key: a player who submits twice means it, and the
 * second submission supersedes the first rather than being swallowed. What is
 * guarded is the state — a mission that has already been paid cannot take new
 * evidence, and a mission the player is not in cannot take any.
 */
export async function submitMissionProof(input: ProofSubmission): Promise<MissionProofResult> {
  const note = input.note?.trim() ?? "";
  const file = input.file ?? null;

  if (input.kind === "text" && note.length < 4) {
    throw new AppError("E-PROOF-REQUIRED", "Write a few words about what you did", 400);
  }
  if (input.kind !== "text" && !file) {
    throw new AppError("E-PROOF-REQUIRED", "Attach a photo or receipt", 400);
  }

  const stored = file ? decodeProofFile(file) : null;

  return withTx(async (tx) => {
    const wallet = await ensureRewardWallet(tx, { phone: input.phone });
    const instance = await one(
      tx,
      `SELECT * FROM user_missions
       WHERE wallet_id = ? AND mission_key = ?
         AND state IN ('AVAILABLE', 'IN_PROGRESS', 'VERIFYING')
       ORDER BY assigned_at DESC
       LIMIT 1
       FOR UPDATE`,
      [wallet.id, input.missionKey],
    );
    if (!instance) {
      throw new AppError(
        "E-MISSION-NOT-ACTIVE",
        "Join the mission before sending evidence for it",
        409,
      );
    }

    const definition = await definitionFor(
      tx,
      input.missionKey,
      Number(instance.definition_version),
    );
    if (!definition.requiresProof) {
      throw new AppError("E-MISSION-NOT-ACTIVE", "This mission does not need evidence", 400);
    }

    const previous = await one(
      tx,
      `SELECT id FROM mission_proofs
       WHERE user_mission_id = ? AND review_status IN ('Pending', 'Rejected')
       ORDER BY submitted_at DESC LIMIT 1`,
      [String(instance.id)],
    );
    // Superseded rather than deleted: a rejected submission and the reason it
    // was rejected are the audit trail for a decision somebody may query later.
    if (previous) {
      await run(
        tx,
        "UPDATE mission_proofs SET review_status = 'Superseded' WHERE id = ?",
        [String(previous.id)],
      );
    }

    let fileRef: string | null = null;
    if (stored) {
      fileRef = id("pfile");
      await run(
        tx,
        `INSERT INTO mission_proof_files
         (file_ref, wallet_id, content_type, byte_size, content, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          fileRef,
          wallet.id,
          stored.contentType,
          stored.byteSize,
          stored.contentBase64,
          isoNow(),
          new Date(Date.now() + PROOF_FILE_RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString(),
        ],
      );
    }

    const proofId = id("proof");
    const now = isoNow();
    await run(
      tx,
      `INSERT INTO mission_proofs
       (id, user_mission_id, wallet_id, mission_key, definition_version, partner_id, kind,
        file_ref, note, review_status, supersedes, submitted_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'Pending', ?, ?, ?)`,
      [
        proofId,
        String(instance.id),
        wallet.id,
        input.missionKey,
        definition.definitionVersion,
        definition.partnerId,
        input.kind,
        fileRef,
        note || null,
        previous ? String(previous.id) : null,
        now,
        now,
      ],
    );

    await run(
      tx,
      `UPDATE user_missions SET state = 'VERIFYING', proof_id = ?, updated_at = ?
       WHERE id = ?`,
      [proofId, now, String(instance.id)],
    );

    return {
      missionKey: input.missionKey,
      state: "VERIFYING" as MissionState,
      proof: {
        proofId,
        kind: input.kind,
        status: "Pending",
        submittedAt: now,
      } satisfies MissionProofState,
    };
  });
}

/**
 * Turns a base64 payload into something safe to store.
 *
 * The size is measured on the decoded bytes, not on the string, because base64
 * is a third larger and a cap on the wire format is a cap on the wrong number.
 * The content type is checked against an allowlist rather than sniffed: this is
 * never executed or served as HTML, and an allowlist is the check that does not
 * depend on getting a parser right.
 */
function decodeProofFile(file: { contentBase64: string; contentType: string }) {
  const contentType = file.contentType.trim().toLowerCase();
  if (!ALLOWED_CONTENT_TYPES.has(contentType)) {
    throw new AppError("E-PROOF-REQUIRED", "Send a JPEG, PNG or WebP image", 400);
  }
  // Tolerate a data: URL, which is what an image picker hands the app.
  const payload = file.contentBase64.includes(",")
    ? file.contentBase64.slice(file.contentBase64.indexOf(",") + 1)
    : file.contentBase64;
  const cleaned = payload.trim();
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(cleaned)) {
    throw new AppError("E-PROOF-REQUIRED", "That file could not be read", 400);
  }
  const byteSize = Math.floor((cleaned.length * 3) / 4);
  if (byteSize <= 0) {
    throw new AppError("E-PROOF-REQUIRED", "That file is empty", 400);
  }
  if (byteSize > MAX_PROOF_BYTES) {
    throw new AppError("E-PROOF-REQUIRED", "That image is too large. Try a smaller photo.", 400);
  }
  return { contentBase64: cleaned, contentType, byteSize };
}

/* Review -------------------------------------------------------------------- */

export type ProofQueueRow = {
  proofId: string;
  userMissionId: string;
  missionKey: string;
  missionTitle: string;
  definitionVersion: number;
  partnerId: string | null;
  partnerName: string | null;
  phone: string;
  kind: MissionProofKind;
  hasFile: boolean;
  note: string;
  status: string;
  submittedAt: string;
  reviewer: string;
  reviewedAt: string;
  rejectReason: string;
  /** Where the mission itself stands, so a reviewer can see what approving pays. */
  missionState: MissionState;
  reward: string;
};

/**
 * The review queue.
 *
 * Scoped by partner when the caller is partner staff, so a pilot partner
 * reviews their own campaign's evidence and nobody else's.
 */
export async function listProofQueue(input: {
  status?: string;
  partnerIds?: string[] | null;
  limit?: number;
} = {}): Promise<ProofQueueRow[]> {
  const db = await getDb();
  const clauses: string[] = [];
  const args: Array<string | number> = [];

  clauses.push("p.review_status = ?");
  args.push(input.status ?? "Pending");

  // Null means "every partner" (an operations account). An empty array means a
  // partner account with no businesses, which must see nothing rather than all.
  if (input.partnerIds) {
    if (input.partnerIds.length === 0) return [];
    clauses.push(`p.partner_id IN (${input.partnerIds.map(() => "?").join(", ")})`);
    args.push(...input.partnerIds);
  }

  const limit = Math.min(200, Math.max(1, input.limit ?? 100));
  args.push(limit);

  const rows = await all(
    db,
    `SELECT p.*, um.state AS mission_state, d.title AS mission_title, d.reward_json,
            w.phone AS phone, b.name AS partner_name
     FROM mission_proofs p
     JOIN user_missions um ON um.id = p.user_mission_id
     JOIN mission_definitions d
       ON d.mission_key = p.mission_key AND d.definition_version = p.definition_version
     JOIN reward_wallets w ON w.id = p.wallet_id
     LEFT JOIN businesses b ON b.id = p.partner_id
     WHERE ${clauses.join(" AND ")}
     ORDER BY p.submitted_at ASC
     LIMIT ?`,
    args,
  );

  return rows.map((row) => ({
    proofId: String(row.id),
    userMissionId: String(row.user_mission_id),
    missionKey: String(row.mission_key),
    missionTitle: String(row.mission_title ?? row.mission_key),
    definitionVersion: Number(row.definition_version),
    partnerId: row.partner_id ? String(row.partner_id) : null,
    partnerName: row.partner_name ? String(row.partner_name) : null,
    phone: String(row.phone),
    kind: String(row.kind) as MissionProofKind,
    hasFile: Boolean(row.file_ref),
    note: String(row.note ?? ""),
    status: String(row.review_status),
    submittedAt: String(row.submitted_at),
    reviewer: String(row.reviewer ?? ""),
    reviewedAt: String(row.reviewed_at ?? ""),
    rejectReason: String(row.reject_reason ?? ""),
    missionState: String(row.mission_state) as MissionState,
    reward: String(row.reward_json ?? "[]"),
  }));
}

/**
 * The image behind one proof, for a reviewer's screen.
 *
 * Returns null once the retention sweep has taken it: the decision row outlives
 * the picture, and a queue that has already been worked through is expected to
 * lose its attachments.
 */
export async function readProofFile(proofId: string) {
  const db = await getDb();
  const row = await one(
    db,
    `SELECT f.content, f.content_type, f.byte_size, p.partner_id
     FROM mission_proofs p
     JOIN mission_proof_files f ON f.file_ref = p.file_ref
     WHERE p.id = ?`,
    [proofId],
  );
  if (!row) return null;
  return {
    contentBase64: String(row.content),
    contentType: String(row.content_type),
    byteSize: Number(row.byte_size),
    partnerId: row.partner_id ? String(row.partner_id) : null,
  };
}

export type ProofDecision = {
  proofId: string;
  decision: "Approved" | "Rejected";
  reviewer: string;
  reason?: string;
  /**
   * Partners this reviewer may act for, or null for operations.
   *
   * Checked inside the transaction that reads the row rather than against a
   * list fetched beforehand: a scope test done on a separate read is a scope
   * test with a gap in it.
   */
  allowedPartnerIds?: string[] | null;
};

/**
 * Records a reviewer's decision and moves the mission accordingly.
 *
 * Approving is where the payout happens, and it happens in the same transaction
 * as the decision — the same rule the rest of the engine follows, for the same
 * reason. Rejecting deliberately leaves the mission in VERIFYING with the
 * reason attached rather than sending it back to IN_PROGRESS: the player did
 * the thing, what failed was the evidence, and the screen they need is "here is
 * why, send another" rather than a progress bar reset to zero.
 */
export async function reviewMissionProof(input: ProofDecision) {
  if (input.decision === "Rejected" && !(input.reason ?? "").trim()) {
    throw new AppError("E-VALIDATION-400", "A rejection needs a reason the player can read", 400);
  }

  return withTx(async (tx) => {
    const proof = await one(
      tx,
      "SELECT * FROM mission_proofs WHERE id = ? FOR UPDATE",
      [input.proofId],
    );
    if (!proof) {
      throw new AppError("E-PROOF-NOT-FOUND", "That submission no longer exists", 404);
    }
    if (
      input.allowedPartnerIds &&
      !input.allowedPartnerIds.includes(String(proof.partner_id ?? ""))
    ) {
      throw new AppError(
        "E-STAFF-BUSINESS-SCOPE",
        "You can only review evidence for your own business",
        403,
      );
    }
    if (String(proof.review_status) !== "Pending") {
      throw new AppError(
        "E-ALREADY-COMPLETED",
        `That submission was already ${String(proof.review_status).toLowerCase()}`,
        409,
      );
    }

    const now = isoNow();
    await run(
      tx,
      `UPDATE mission_proofs
       SET review_status = ?, reviewer = ?, reviewed_at = ?, reject_reason = ?
       WHERE id = ?`,
      [
        input.decision,
        input.reviewer,
        now,
        input.decision === "Rejected" ? (input.reason ?? "").trim() : null,
        input.proofId,
      ],
    );

    const instance = await one(
      tx,
      "SELECT * FROM user_missions WHERE id = ? FOR UPDATE",
      [String(proof.user_mission_id)],
    );
    if (!instance) {
      throw new AppError("E-MISSION-NOT-ACTIVE", "That mission instance is gone", 404);
    }
    const wallet = await one(tx, "SELECT phone FROM reward_wallets WHERE id = ?", [
      String(proof.wallet_id),
    ]);
    const phone = String(wallet?.phone ?? "");
    const titleRow = await one(
      tx,
      "SELECT title FROM mission_definitions WHERE mission_key = ? AND definition_version = ?",
      [String(proof.mission_key), Number(proof.definition_version)],
    );
    const missionTitle = String(titleRow?.title ?? proof.mission_key);

    await publishEvent(tx, {
      eventName: input.decision === "Approved" ? "proof_approved" : "proof_rejected",
      walletId: String(proof.wallet_id),
      phone,
      source: "admin",
      partnerId: proof.partner_id ? String(proof.partner_id) : null,
      objectType: "mission_proof",
      objectId: input.proofId,
      idempotencyKey: `proof_${input.decision.toLowerCase()}:${input.proofId}`,
      metadata: { missionKey: String(proof.mission_key) },
      status: "Processed",
    });

    await recordRewardAudit(tx, {
      actorType: "admin",
      actorId: input.reviewer,
      action: `gamification_proof_${input.decision.toLowerCase()}`,
      entityType: "mission_proof",
      entityId: input.proofId,
      metadata: {
        missionKey: String(proof.mission_key),
        reason: input.reason ?? null,
      },
    });

    if (input.decision === "Rejected") {
      await run(
        tx,
        "UPDATE user_missions SET reject_reason = ?, updated_at = ? WHERE id = ?",
        [(input.reason ?? "").trim(), now, String(instance.id)],
      );
      return {
        proofId: input.proofId,
        decision: input.decision,
        paid: false,
        missionKey: String(proof.mission_key),
        missionTitle,
        phone,
      };
    }

    // Approved. Whether that finishes the mission depends on whether the
    // player's progress had already reached the target — evidence can arrive
    // before the qualifying scan does.
    const complete = Number(instance.progress) >= Number(instance.target);
    if (!complete) {
      await run(
        tx,
        "UPDATE user_missions SET state = 'IN_PROGRESS', reject_reason = NULL, updated_at = ? WHERE id = ?",
        [now, String(instance.id)],
      );
      return {
        proofId: input.proofId,
        decision: input.decision,
        paid: false,
        missionKey: String(proof.mission_key),
        missionTitle,
        phone,
      };
    }

    const definition = await definitionFor(
      tx,
      String(proof.mission_key),
      Number(proof.definition_version),
    );
    await run(
      tx,
      "UPDATE user_missions SET state = 'CLAIMABLE', reject_reason = NULL, updated_at = ? WHERE id = ?",
      [now, String(instance.id)],
    );

    if (!definition.autoClaim) {
      return {
        proofId: input.proofId,
        decision: input.decision,
        paid: false,
        missionKey: String(proof.mission_key),
        missionTitle,
        phone,
      };
    }

    const payout = await payMission(tx, {
      walletId: String(proof.wallet_id),
      phone,
      instanceId: String(instance.id),
      definition,
      missionDate: String(instance.mission_date ?? ""),
    });
    return {
      proofId: input.proofId,
      decision: input.decision,
      paid: !payout.rejected,
      missionKey: String(proof.mission_key),
      missionTitle,
      phone,
    };
  });
}

/**
 * Drops proof images whose retention window has passed.
 *
 * Called from the nightly sweep beside the other retention promises. Only the
 * file goes; `mission_proofs` keeps the decision, so a reward that was paid on
 * a photo can still be explained after the photo is gone.
 */
export async function sweepExpiredProofFiles(now = new Date()) {
  const db = await getDb();
  return run(db, "DELETE FROM mission_proof_files WHERE expires_at < ?", [now.toISOString()]);
}

/** Every submission for one player, for the support screens. */
export async function proofHistoryFor(db: Exec, walletId: string, limit = 50) {
  return all(
    db,
    `SELECT p.id, p.mission_key, p.kind, p.review_status, p.submitted_at, p.reviewed_at,
            p.reviewer, p.reject_reason
     FROM mission_proofs p
     WHERE p.wallet_id = ?
     ORDER BY p.submitted_at DESC
     LIMIT ?`,
    [walletId, limit],
  );
}
