// Loyalty Points as the console prints them.
//
// Balances are stored in centavos throughout — 100 centavos is 1 LP — and the
// mobile API's own responses carry the " LP" suffix, so the dashboard spells
// amounts the same way rather than inventing a second format for them.

export function formatLoyaltyPoints(centavos: number) {
  return `${(centavos / 100).toLocaleString("en-PH", { maximumFractionDigits: 2 })} LP`;
}

/**
 * What a customer holds across their partner buckets.
 *
 * Shown alongside the global pot rather than folded into it: these points spend
 * only at the partner that issued them, so a single combined figure would
 * overstate what the customer can actually spend anywhere.
 */
export function partnerBalanceTotal(partners: { balanceCentavos: number }[]) {
  return partners.reduce((total, partner) => total + partner.balanceCentavos, 0);
}
