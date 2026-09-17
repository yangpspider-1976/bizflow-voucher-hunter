import { redirect } from "next/navigation";
import { filterCampaignsForSession } from "@/server/auth";
import { listChangeRequests } from "@/server/change-requests";
import { campaignSlotPerformance, type SlotPerformance } from "@/server/voucher-engine";
import { FormPage } from "../../_components/FormPage";
import { PoolForm, type PoolRequestDraft } from "../../_components/PoolForm";
import { scopedHref, selectScope } from "../../_components/selectCampaign";
import { cachedBusinesses, cachedCampaignsWithIndustry, currentSession } from "@/server/dashboard-data";

export default async function NewPoolPage({
  searchParams,
}: {
  searchParams: { business?: string; campaign?: string; revise?: string };
}) {
  const session = await currentSession();
  const campaigns = filterCampaignsForSession(
    session!,
    await cachedCampaignsWithIndustry(),
  );
  const businesses = await cachedBusinesses();
  const scope = selectScope(businesses, campaigns, searchParams);
  const campaign = scope.campaign;
  if (!campaign) redirect("/dashboard/vouchers");

  const returnHref = scopedHref("/dashboard/vouchers", scope.business?.id, campaign.slug);
  const isBusinessScoped = session?.role === "staff";

  let slots: SlotPerformance[] = [];
  try {
    slots = await campaignSlotPerformance(campaign.id);
  } catch {
    slots = [];
  }

  let initialValues: PoolRequestDraft | undefined;
  if (searchParams.revise && !isBusinessScoped) {
    const request = (await listChangeRequests(campaign.id, "pool_create")).find(
      (item) => item.id === searchParams.revise,
    );
    if (!request) redirect(returnHref);
    initialValues = request.payload as PoolRequestDraft;
  }

  const revising = initialValues !== undefined;

  return (
    <FormPage
      backHref={returnHref}
      backLabel="Vouchers"
      description={
        revising
          ? "Review the previous values and submit a new pending request. The original decision stays in request history."
          : isBusinessScoped
            ? `Submit a voucher benefit tier on ${campaign.title} for admin approval.`
            : `Define a voucher benefit on ${campaign.title} and the slots it can be booked at.`
      }
      title={
        revising
          ? "Revise voucher tier request"
          : isBusinessScoped
            ? "Request a benefit tier"
            : "New benefit tier"
      }
    >
      <PoolForm
        campaignId={campaign.id}
        initialValues={initialValues}
        requestMode={isBusinessScoped}
        returnHref={returnHref}
        revisionRequestId={revising ? searchParams.revise : undefined}
        slots={slots.map((row) => row.slot)}
      />
    </FormPage>
  );
}
