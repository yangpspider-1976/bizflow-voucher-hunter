import { z } from "zod";
import { requireAdmin } from "@/server/auth";
import { AppError, fail } from "@/server/errors";
import { readProofFile } from "@/server/gamification/proofs";

const paramsSchema = z.object({ proofId: z.string().min(4).max(72) });

export const dynamic = "force-dynamic";

/**
 * The image behind one submission, for the reviewer's screen.
 *
 * Served as bytes rather than as a data URL in the queue payload: the queue is
 * a list of a hundred rows and each attachment is up to two megabytes, so the
 * picture is fetched only for the one being looked at.
 *
 * `Content-Disposition: inline` with a fixed content type from the stored
 * allowlist, and a no-store cache header — this is somebody's receipt, and it
 * has no business in a shared cache.
 */
export async function GET(
  request: Request,
  { params }: { params: { proofId: string } },
) {
  try {
    const session = await requireAdmin(request);
    const { proofId } = paramsSchema.parse(params);
    const file = await readProofFile(proofId);
    if (!file) {
      throw new AppError("E-PROOF-NOT-FOUND", "That attachment is no longer stored", 404);
    }

    const operations =
      session.role === "super_admin" ||
      (session.role === "admin" && session.businessIds.includes("*"));
    if (!operations && (!file.partnerId || !session.businessIds.includes(file.partnerId))) {
      throw new AppError(
        "E-STAFF-BUSINESS-SCOPE",
        "You can only open evidence for your own business",
        403,
      );
    }

    return new Response(Buffer.from(file.contentBase64, "base64"), {
      headers: {
        "content-type": file.contentType,
        "content-length": String(file.byteSize),
        "content-disposition": "inline",
        "cache-control": "no-store, private",
      },
    });
  } catch (error) {
    return fail(error);
  }
}
