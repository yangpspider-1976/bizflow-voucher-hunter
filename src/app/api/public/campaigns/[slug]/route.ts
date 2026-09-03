import { getSignedInCustomerPhone } from "@/server/customer-auth";
import { fail, ok } from "@/server/errors";
import { getPublicCampaign } from "@/server/voucher-engine";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET(request: Request, { params }: { params: { slug: string } }) {
  try {
    // The page is reachable by slug whoever asks; the phone only decides what
    // the level gate on the response says.
    const phone = await getSignedInCustomerPhone(request);
    return ok(await getPublicCampaign(params.slug, phone));
  } catch (error) {
    return fail(error);
  }
}
