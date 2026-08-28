import { z } from "zod";
import { requireSignedInCustomerPhone } from "@/server/customer-auth";
import { fail, ok } from "@/server/errors";
import { MAX_PROOF_BYTES, submitMissionProof } from "@/server/gamification/proofs";
import { enforceRateLimit } from "@/server/rate-limit";

const paramsSchema = z.object({ missionKey: z.string().min(1).max(64) });

/**
 * Base64 rather than multipart: the app already speaks JSON to every other
 * endpoint, and a single image under the size cap is not worth a second
 * transport. The bound here is on the encoded string; the service re-checks the
 * decoded size, which is the number that actually matters.
 */
const B64_CEILING = Math.ceil((MAX_PROOF_BYTES * 4) / 3) + 128;

const bodySchema = z.object({
  kind: z.enum(["photo", "receipt", "text"]),
  note: z.string().max(600).optional(),
  file: z
    .object({
      contentBase64: z.string().min(1).max(B64_CEILING),
      contentType: z.string().min(3).max(64),
    })
    .nullable()
    .optional(),
});

export const dynamic = "force-dynamic";
/** A 2MB body through JSON parsing and a base64 decode; past the default. */
export const maxDuration = 30;

/**
 * Submits evidence for a mission that needs a person to look at it.
 *
 * Rate limited hard compared with the rest of the gamification API: every call
 * can write a couple of megabytes, and the legitimate rate is a few per day.
 */
export async function POST(
  request: Request,
  { params }: { params: { missionKey: string } },
) {
  try {
    await enforceRateLimit(request, "gamification/mission-proof", {
      limit: 10,
      windowMs: 10 * 60_000,
    });
    const phone = await requireSignedInCustomerPhone(request);
    const { missionKey } = paramsSchema.parse(params);
    const body = bodySchema.parse(await request.json());
    return ok(
      await submitMissionProof({
        phone,
        missionKey,
        kind: body.kind,
        note: body.note,
        file: body.file ?? null,
      }),
    );
  } catch (error) {
    return fail(error);
  }
}
