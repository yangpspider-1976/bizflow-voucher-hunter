import { z } from "zod";
import { canAccessBusiness, requireAdmin } from "@/server/auth";
import { createBusiness, listBusinesses } from "@/server/admin";
import { AppError, fail, ok } from "@/server/errors";

export const dynamic = "force-dynamic";

const schema = z.object({
  name: z.string().min(1),
  /** Optional: derived from the name when the caller does not supply one. */
  logoText: z.string().min(1).max(4).optional(),
  industry: z.enum(["restaurant", "online_shop", "beauty", "pet", "retail", "other"]),
  address: z.string().trim().min(1, "Address is required").max(300),
  contactNumber: z.string().trim().min(1, "Contact number is required").max(40),
  latitude: z.number().min(-90).max(90).optional(),
  longitude: z.number().min(-180).max(180).optional(),
});

export async function GET(request: Request) {
  try {
    const session = await requireAdmin(request);
    const businesses = await listBusinesses();
    // Filtered by the same predicate `assertBusinessAccess` enforces, rather
    // than by a role check of its own: the staff checkout builds its "Redeeming
    // at" list from this, so anything listed here and refused there is a dead
    // end the operator cannot diagnose.
    return ok(businesses.filter((business) => canAccessBusiness(session, business.id)));
  } catch (error) {
    return fail(error);
  }
}

export async function POST(request: Request) {
  try {
    const session = await requireAdmin(request);
    if (session.role === "staff") {
      throw new AppError("E-STAFF-BUSINESS-CREATE", "Staff cannot create businesses", 403);
    }
    const input = schema.parse(await request.json());
    return ok(await createBusiness(input), { status: 201 });
  } catch (error) {
    return fail(error);
  }
}
