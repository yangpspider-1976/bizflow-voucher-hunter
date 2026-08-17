import { notFound, redirect } from "next/navigation";
import { EditCampaignForm } from "../../../_components/EditCampaignForm";
import { FormPage } from "../../../_components/FormPage";
import { listSlots } from "@/server/admin";
import { manilaDateString } from "@/server/db";
import { cachedCampaigns, currentSession } from "@/server/dashboard-data";

export const dynamic = "force-dynamic";

export default async function EditCampaignPage({
  params,
}: {
  params: { campaignId: string };
}) {
  const session = await currentSession();
  // Staff validate vouchers for a campaign; they do not reschedule it.
  if (session?.role === "staff") redirect("/dashboard");

  const campaign = (await cachedCampaigns()).find((item) => item.id === params.campaignId);
  if (!campaign) notFound();

  return (
    <FormPage
      backHref="/dashboard/campaigns"
      backLabel="Campaigns"
      description={`Schedule, hunt rules, and wording for ${campaign.title}.`}
      title="Edit campaign"
    >
      <EditCampaignForm
        campaign={campaign}
        slots={await listSlots(campaign.id)}
        today={manilaDateString()}
      />
    </FormPage>
  );
}
