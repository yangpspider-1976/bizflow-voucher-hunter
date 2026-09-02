import Link from "next/link";

/**
 * The gamification section's own navigation.
 *
 * Five screens that belong together and would each need a sidebar row of their
 * own otherwise — which would make the sidebar mostly about a feature most days
 * need nothing from. A strip inside the section keeps the top level about the
 * shape of the business.
 *
 * Tabs rather than buttons: these switch between screens that already exist
 * instead of doing anything, so they stay quiet until one of them is the page
 * you are on.
 */
const LINKS: { href: string; label: string; partner?: boolean }[] = [
  { href: "/dashboard/gamification", label: "Economy" },
  // The two a pilot partner needs: write a campaign, review the evidence it
  // produces. The economy, the KPIs and the abuse queue are network-wide and
  // stay with operations.
  { href: "/dashboard/gamification/missions", label: "Missions", partner: true },
  { href: "/dashboard/gamification/proofs", label: "Evidence", partner: true },
  { href: "/dashboard/gamification/analytics", label: "Analytics" },
  { href: "/dashboard/gamification/abuse", label: "Abuse" },
];

export function GamificationNav({
  active,
  partnerOnly = false,
}: {
  active: string;
  partnerOnly?: boolean;
}) {
  const links = partnerOnly ? LINKS.filter((link) => link.partner) : LINKS;
  return (
    <nav className="admin-subnav" aria-label="Levels and missions">
      {links.map((link) => (
        <Link
          aria-current={link.href === active ? "page" : undefined}
          href={link.href}
          key={link.href}
        >
          {link.label}
        </Link>
      ))}
    </nav>
  );
}
