"use client";

import type { ReactNode } from "react";
import { useMemo, useTransition } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { campaignCategoryIcon } from "@/lib/campaign-category";
import type { Business, Campaign } from "@/types/voucher";
import { SelectMenu } from "./SelectMenu";

type SelectorCampaign = Campaign & { industry?: string };

/**
 * The scope a campaign-bound page is showing: which business, and which of its
 * campaigns.
 *
 * Deliberately per-page rather than in the sidebar. Only Dashboard, Slots and
 * Vouchers are campaign-scoped; a persistent sidebar control would sit there
 * while you were on Businesses or Settings and imply those were scoped too.
 *
 * Staff see only the campaign half. Their session is bound to one business, so
 * a business picker would be a control with a single option.
 */
export function ScopeSelector({
  businesses,
  campaigns,
  selectedBusinessId,
  selectedCampaignSlug,
  showBusiness,
}: {
  businesses: Business[];
  campaigns: SelectorCampaign[];
  selectedBusinessId?: string;
  selectedCampaignSlug?: string;
  showBusiness: boolean;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const searchParams = useSearchParams();
  const [switching, startSwitch] = useTransition();

  const business =
    businesses.find((item) => item.id === selectedBusinessId) ?? businesses[0];
  const scopedCampaigns = useMemo(
    () =>
      business
        ? campaigns.filter((campaign) => campaign.businessId === business.id)
        : campaigns,
    [business, campaigns],
  );
  const campaign =
    scopedCampaigns.find((item) => item.slug === selectedCampaignSlug) ??
    scopedCampaigns[0];

  // Client-side navigation, not window.location.assign: changing scope only
  // needs the page's server components re-rendered with new search params, and
  // a full document load threw away the whole dashboard bundle each time.
  //
  // Inside a transition so the round trip has a visible state. Without one the
  // tiles snapped back to the old scope the instant the menu closed and sat
  // there until the server answered — on a slow campaign that reads as a click
  // that did nothing, and invites a second one against a navigation already in
  // flight.
  function navigate(params: URLSearchParams) {
    startSwitch(() => {
      router.push(`${pathname}?${params.toString()}`);
    });
  }

  function onBusinessChange(businessId: string) {
    const params = new URLSearchParams(searchParams.toString());
    params.set("business", businessId);
    // The previously selected campaign belongs to the previous business, so it
    // would resolve to nothing. Drop it and let the page pick that business's
    // first campaign.
    params.delete("campaign");
    navigate(params);
  }

  function onCampaignChange(slug: string) {
    const params = new URLSearchParams(searchParams.toString());
    params.set("campaign", slug);
    navigate(params);
  }

  // Rebuilt only when their source list changes. SelectMenu takes `options` as
  // a prop and derives the selected and active rows from it, so a fresh array
  // on every render invalidated that work for nothing.
  const businessOptions = useMemo(
    () => businesses.map((item) => ({ value: item.id, label: item.name })),
    [businesses],
  );
  const campaignOptions = useMemo(
    () => scopedCampaigns.map((item) => ({ value: item.slug, label: item.title })),
    [scopedCampaigns],
  );

  // A single option is shown but not made switchable. Hiding it outright left
  // the page silent about what it was scoped to — a campaign's slots looked
  // like the business's slots.
  const showBusinessScope = showBusiness && businesses.length > 0;
  const showCampaignScope = scopedCampaigns.length > 0;
  if (!showBusinessScope && !showCampaignScope) return null;

  const category = campaign?.industry ?? campaign?.mode ?? "other";

  return (
    <div aria-busy={switching || undefined} className="scope-selector">
      {showBusinessScope ? (
        <ScopeTile
          category={business?.industry ?? "other"}
          icon={campaignCategoryIcon(business?.industry ?? "other")}
          label="Business"
          onChange={onBusinessChange}
          options={businessOptions}
          pending={switching}
          selectLabel="Viewing business"
          value={business?.id ?? ""}
          valueLabel={business?.name ?? "All businesses"}
        />
      ) : null}

      {showCampaignScope ? (
        // No icon: the category glyph belongs to the business, and repeating it
        // here produced two identical tiles for a shop running a shop campaign.
        <ScopeTile
          label="Campaign"
          onChange={onCampaignChange}
          options={campaignOptions}
          pending={switching}
          selectLabel="Viewing campaign"
          value={campaign?.slug ?? ""}
          valueLabel={campaign?.title ?? "No campaigns"}
        />
      ) : null}
    </div>
  );
}

/**
 * One scope tile: always a picker, even when there is a single option today.
 * A tile that reads as inert gives no hint that the scope is switchable at all,
 * and the option list is how you find out what else exists.
 */
function ScopeTile({
  category,
  icon,
  label,
  onChange,
  options,
  pending,
  selectLabel,
  value,
  valueLabel,
}: {
  category?: string;
  icon?: ReactNode;
  label: string;
  onChange: (value: string) => void;
  options: { value: string; label: string }[];
  /**
   * A scope switch is in flight. The tile still reads the old scope until the
   * server's render lands, so it dims to say the click was heard.
   *
   * Deliberately not `disabled`: disabling the trigger moves focus off it, so a
   * keyboard user who just changed scope would be dropped to the top of the
   * document every time. Changing scope again mid-flight is legitimate anyway —
   * the transition supersedes the earlier navigation.
   */
  pending?: boolean;
  selectLabel?: string;
  value?: string;
  valueLabel: string;
}) {
  return (
    <SelectMenu
      ariaLabel={selectLabel}
      className={`scope-tile${pending ? " is-switching" : ""}`}
      onChange={onChange}
      options={options}
      renderValue={() => (
        <>
          {icon ? (
            <span className={`campaign-page-selector-icon mode-${category ?? "other"}`}>
              {icon}
            </span>
          ) : null}
          <span className="campaign-page-selector-copy">
            <small>{label}</small>
            <strong>{valueLabel}</strong>
          </span>
        </>
      )}
      triggerClassName={`campaign-page-selector${icon ? "" : " is-iconless"}`}
      value={value ?? ""}
    />
  );
}
