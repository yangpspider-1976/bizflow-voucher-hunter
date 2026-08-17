import { FiEdit2, FiImage } from "react-icons/fi";
import { CampaignFlagToggles } from "../_components/CampaignFlagToggles";
import { FlashNotice } from "../_components/FlashNotice";
import { FormLink } from "../_components/FormLink";
import { redirect } from "next/navigation";
import { campaignCategoryLabel } from "@/lib/campaign-category";
import {
  cachedBusinesses,
  cachedCampaignsWithIndustry,
  currentSession,
} from "@/server/dashboard-data";

function statusVariant(status: string) {
  if (status === "active") return "";
  if (status === "paused") return "warning";
  return "danger";
}

function formatDate(value: string) {
  const parsed = new Date(`${value}T00:00:00`);
  return Number.isNaN(parsed.getTime())
    ? value
    : parsed.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

export default async function CampaignsPage() {
  const session = await currentSession();
  if (session?.role === "staff") redirect("/dashboard");
  // Campaigns carry their owning business's industry: that is the category
  // customers see in the directory, and it is not the campaign's `mode` — a
  // clinic can run an appointment campaign in restaurant mode.
  const [businesses, campaigns] = await Promise.all([
    cachedBusinesses(),
    cachedCampaignsWithIndustry(),
  ]);

  return (
    <>
      <header className="admin-topbar">
        <div>
          <h1>Campaigns</h1>
          <p className="muted">Configured campaigns and current operational status.</p>
        </div>
      </header>

      <FlashNotice />

      <section className="panel table-wrap">
        <FormLink
          className="button admin-form-toggle"
          href="/dashboard/campaigns/new"
          skeleton="newCampaign"
        >
          New Campaign
        </FormLink>
        <table className="admin-table">
          <thead>
            <tr>
              <th>Campaign</th>
              <th>Business</th>
              <th>Category</th>
              <th>Status</th>
              <th>Date Range</th>
              <th>Reschedule</th>
            </tr>
          </thead>
          <tbody>
            {campaigns.length === 0 ? (
              <tr>
                <td colSpan={6} className="table-empty">
                  No campaigns yet. Create one above.
                </td>
              </tr>
            ) : (
              campaigns.map((campaign) => (
                <tr key={campaign.id}>
                  <td>
                    <div className="campaign-table-title">
                      <div className="cell-title">{campaign.title}</div>
                      <div className="campaign-table-actions">
                        <FormLink
                          className="campaign-edit-image-button"
                          href={`/dashboard/campaigns/${campaign.id}/edit`}
                          skeleton="editCampaign"
                        >
                          <FiEdit2 aria-hidden="true" />
                          Edit
                        </FormLink>
                        <FormLink
                          className="campaign-edit-image-button"
                          href={`/dashboard/campaigns/${campaign.id}/image`}
                          skeleton="campaignImage"
                        >
                          <FiImage aria-hidden="true" />
                          Edit image
                        </FormLink>
                      </div>
                    </div>
                  </td>
                  <td>{businesses.find((b) => b.id === campaign.businessId)?.name ?? "-"}</td>
                  <td>
                    <span className="chip">{campaignCategoryLabel(campaign.industry)}</span>
                  </td>
                  <td>
                    <span className={`badge ${statusVariant(campaign.status)}`}>{campaign.status}</span>
                  </td>
                  <td className="cell-nowrap">
                    {formatDate(campaign.startDate)} – {formatDate(campaign.endDate)}
                  </td>
                  <td>
                    <CampaignFlagToggles
                      campaignId={campaign.id}
                      allowReschedule={campaign.allowReschedule}
                    />
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </section>
    </>
  );
}
