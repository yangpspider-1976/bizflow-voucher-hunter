import type { FormSkeletonCard } from "./FormSkeleton";

/**
 * The card shape each form route's placeholder draws.
 *
 * Two things reach for these: the route's own `loading.tsx`, for arrivals the
 * client cannot see (a refresh, a deep link, Back), and the button that opens
 * the form, which paints the placeholder from the click rather than waiting on
 * the server. They have to draw the same picture — a mismatch reads as the
 * skeleton changing its mind mid-load — so the shapes live here once instead of
 * being written out at both ends.
 */
export const formSkeletons = {
  /** Identity (name, category) then venue details (contact, address, map). */
  newBusiness: [{ fields: 2 }, { leadFields: 1, media: true }],
  /** As above, minus the category: it is fixed at creation. */
  editBusiness: [{ fields: 1 }, { leadFields: 1, media: true }],
  /** Business, campaign details, schedule and hunt rules, content, reservation. */
  newCampaign: [
    { fields: 1 },
    { fields: 3 },
    { fields: 6 },
    { media: true, fields: 2 },
    { fields: 1 },
  ],
  /**
   * Schedule and status, hunt rules, content, then the artwork: its current
   * image above the file picker that replaces it. Business and category are
   * fixed and have no cards.
   */
  editCampaign: [{ fields: 3 }, { fields: 3 }, { fields: 4 }, { media: true, fields: 1 }],
  newSlot: [{ fields: 5 }],
  /** Benefit, expiry, availability - the three cards `PoolForm` renders. */
  newPool: [{ fields: 6 }, { fields: 3 }, { fields: 2 }],
  /**
   * Identity, role and access, password. The role card starts at one control:
   * the business picker only appears once the role is set to staff.
   */
  newTeamMember: [{ fields: 2 }, { fields: 1 }, { fields: 1 }],
  /** As the new-member form, plus the account status an existing member has. */
  editTeamMember: [{ fields: 2 }, { fields: 2 }, { fields: 1 }],
} satisfies Record<string, FormSkeletonCard[]>;

export type FormSkeletonName = keyof typeof formSkeletons;
