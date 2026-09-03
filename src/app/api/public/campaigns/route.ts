import { getSignedInCustomerPhone } from "@/server/customer-auth";
import { fail, ok } from "@/server/errors";
import { listPublicCampaignCards } from "@/server/voucher-engine";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET(request: Request) {
  try {
    // Signed in is optional, and the directory is public either way. The phone
    // decides only what the level gate on each card says: a visitor sees the
    // floor of the ladder, which is what a visitor is.
    const phone = await getSignedInCustomerPhone(request);
    return ok(await listPublicCampaignCards(phone));
  } catch (error) {
    return fail(error);
  }
}
