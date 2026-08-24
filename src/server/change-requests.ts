import crypto from "node:crypto";
import { z } from "zod";
import { benefitValueProblem } from "@bizflow/shared";
import { createPool, createSlot, getCampaign, slotWindowProblem, type CreatePoolInput, type CreateSlotInput } from "@/server/admin";
import { AppError } from "@/server/errors";
import { all, getDb, one, run, withTx } from "@/server/db";

export type ChangeRequestType = "slot_create" | "pool_create";
export type ChangeRequest = {
  id: string;
  campaignId: string;
  businessId: string;
  requestedBy: string;
  requestType: ChangeRequestType;
  payload: CreateSlotInput | CreatePoolInput;
  status: "Pending" | "Approved" | "Rejected";
  createdAt: string;
  reviewedBy?: string;
  reviewedAt?: string;
};

const slotRequestPayloadSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  startTime: z.string().regex(/^\d{2}:\d{2}$/),
  endTime: z.string().regex(/^\d{2}:\d{2}$/),
  timezone: z.string().optional(),
  branchId: z.string().optional(),
  totalCapacity: z.number().int().min(1),
  status: z.enum(["active", "sold_out", "closed", "paused"]).optional(),
});

const poolRequestPayloadSchema = z.object({
  benefitType: z.enum(["discount_percent", "fixed_amount", "free_item", "free_shipping"]),
  benefitValue: z.string().min(1),
  displayLabel: z.string().min(1),
  totalQuantity: z.number().int().min(1),
  rarity: z.enum(["standard", "rare", "epic", "legendary"]),
  minimumSpend: z.number().int().min(0).optional(),
  restriction: z.string().optional(),
  status: z.enum(["active", "paused", "depleted"]).optional(),
  slotIds: z.array(z.string()).optional(),
}).superRefine((input, ctx) => {
  const problem = benefitValueProblem(input.benefitType, input.benefitValue);
  if (problem) ctx.addIssue({ code: z.ZodIssueCode.custom, message: problem, path: ["benefitValue"] });
});

function map(row: Record<string, unknown>): ChangeRequest {
  return {
    id: String(row.id),
    campaignId: String(row.campaign_id),
    businessId: String(row.business_id),
    requestedBy: String(row.requested_by),
    requestType: row.request_type as ChangeRequestType,
    payload: JSON.parse(String(row.payload)),
    status: row.status as ChangeRequest["status"],
    createdAt: String(row.created_at),
    reviewedBy: row.reviewed_by ? String(row.reviewed_by) : undefined,
    reviewedAt: row.reviewed_at ? String(row.reviewed_at) : undefined,
  };
}

/**
 * A request is checked against the same rules as a direct write.
 *
 * Business accounts reach slot creation through here instead of {@link createSlot},
 * so without this the campaign window is only enforced when an admin approves —
 * the business is told its request went through, then it silently fails days
 * later in front of the reviewer, who cannot fix the date either.
 */
export async function requestCampaignChange(input: Omit<ChangeRequest, "id" | "businessId" | "status" | "createdAt" | "reviewedBy" | "reviewedAt">) {
  const campaign = await getCampaign(input.campaignId);
  if (input.requestType === "slot_create") {
    const problem = slotWindowProblem((input.payload as CreateSlotInput).date, campaign);
    if (problem) {
      throw new AppError(
        "E-SLOT-WINDOW",
        `${problem} Pick a date inside the window, or ask an admin to extend the campaign first.`,
        422
      );
    }
  }
  const request: ChangeRequest = { ...input, id: `chg_${crypto.randomBytes(9).toString("hex")}`, businessId: campaign.businessId, status: "Pending", createdAt: new Date().toISOString() };
  await run(await getDb(), "INSERT INTO change_requests (id,campaign_id,business_id,requested_by,request_type,payload,status,created_at) VALUES (?,?,?,?,?,?,?,?)", [request.id, request.campaignId, request.businessId, request.requestedBy, request.requestType, JSON.stringify(request.payload), request.status, request.createdAt]);
  return request;
}

/** Admin-facing request history. Pending items stay first; reviewed items remain visible. */
export async function listChangeRequests(
  campaignId: string,
  requestType: ChangeRequestType,
) {
  const rows = await all(
    await getDb(),
    `SELECT * FROM change_requests
     WHERE campaign_id = ? AND request_type = ?
     ORDER BY CASE status WHEN 'Pending' THEN 0 ELSE 1 END,
              COALESCE(reviewed_at, created_at) DESC`,
    [campaignId, requestType],
  );
  return rows.map(map);
}

/** Staff-facing request history, limited to one signed-in user's campaign. */
export async function listStaffChangeRequests(
  campaignId: string,
  requestedBy: string,
  requestType: ChangeRequestType,
) {
  const rows = await all(
    await getDb(),
    "SELECT * FROM change_requests WHERE campaign_id = ? AND requested_by = ? AND request_type = ? ORDER BY created_at DESC",
    [campaignId, requestedBy, requestType],
  );
  return rows.map(map);
}

export async function decideChangeRequest(id: string, approved: boolean, reviewedBy: string) {
  return withTx(async (tx) => {
    const row = await one(tx, "SELECT * FROM change_requests WHERE id = ?", [id]);
    if (!row) throw new AppError("E-CHANGE-404", "Change request was not found", 404);
    const request = map(row);
    if (request.status !== "Pending") throw new AppError("E-CHANGE-STATE", "Change request has already been reviewed", 409);

    const changed = await run(
      tx,
      "UPDATE change_requests SET status=?, reviewed_by=?, reviewed_at=? WHERE id=? AND status='Pending'",
      [approved ? "Approved" : "Rejected", reviewedBy, new Date().toISOString(), id],
    );
    if (changed !== 1) throw new AppError("E-CHANGE-STATE", "Change request has already been reviewed", 409);

    if (approved) {
      if (request.requestType === "slot_create") {
        await createSlot(request.campaignId, request.payload as CreateSlotInput, tx);
      } else {
        await createPool(request.campaignId, request.payload as CreatePoolInput, tx);
      }
    }
  });
}

/**
 * Creates a new pending revision without mutating the reviewed request.
 * Keeping the original row immutable preserves the administrative audit trail.
 */
export async function reviseChangeRequest(
  id: string,
  payload: unknown,
) {
  const row = await one(await getDb(), "SELECT * FROM change_requests WHERE id = ?", [id]);
  if (!row) throw new AppError("E-CHANGE-404", "Change request was not found", 404);

  const original = map(row);
  if (original.status === "Pending") {
    throw new AppError(
      "E-CHANGE-STATE",
      "Only approved or rejected requests can be revised",
      409,
    );
  }

  const validatedPayload = original.requestType === "slot_create"
    ? slotRequestPayloadSchema.parse(payload)
    : poolRequestPayloadSchema.parse(payload);

  return requestCampaignChange({
    campaignId: original.campaignId,
    requestedBy: original.requestedBy,
    requestType: original.requestType,
    payload: validatedPayload,
  });
}
