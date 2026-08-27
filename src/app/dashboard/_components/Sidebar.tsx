"use client";

import type { ReactNode } from "react";
import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  FiAward,
  FiBriefcase,
  FiCheckSquare,
  FiClock,
  FiCreditCard,
  FiFlag,
  FiGift,
  FiGrid,
  FiList,
  FiRepeat,
  FiSettings,
  FiUserPlus,
  FiUsers,
} from "react-icons/fi";
import { useRouteNavigation } from "./DashboardShell";
import { RouteSkeleton } from "./RouteSkeleton";
import { SidebarAccountMenu } from "./SidebarAccountMenu";

type NavItem = {
  label: string;
  href: string;
  icon: ReactNode;
  /**
   * The placeholder shape to draw while this route loads. It has to match what
   * the segment's own `loading.tsx` passes: the two are the same picture
   * arriving by different routes, and a mismatch reads as the skeleton
   * changing its mind mid-load. Left off where the page has no metric row.
   */
  metricCards?: number;
};

const navSections: { title: string; items: NavItem[] }[] = [
  {
    title: "Overview",
    items: [
      {
        label: "Dashboard",
        href: "/dashboard",
        icon: <FiGrid aria-hidden="true" />,
        metricCards: 4,
      },
    ],
  },
  {
    title: "Manage",
    items: [
      {
        label: "Campaigns",
        href: "/dashboard/campaigns",
        icon: <FiFlag aria-hidden="true" />,
      },
      {
        label: "Businesses",
        href: "/dashboard/businesses",
        icon: <FiBriefcase aria-hidden="true" />,
      },
      {
        label: "Slots",
        href: "/dashboard/slots",
        icon: <FiClock aria-hidden="true" />,
      },
    ],
  },
  {
    title: "Customers",
    items: [
      {
        label: "Vouchers",
        href: "/dashboard/vouchers",
        icon: <FiGift aria-hidden="true" />,
      },
      {
        label: "Users",
        href: "/dashboard/users",
        icon: <FiUsers aria-hidden="true" />,
      },
      {
        label: "Loyalty Points",
        href: "/dashboard/rewards",
        icon: <FiRepeat aria-hidden="true" />,
        metricCards: 4,
      },
      {
        label: "Levels & Missions",
        href: "/dashboard/gamification",
        icon: <FiAward aria-hidden="true" />,
      },
      {
        label: "Transactions",
        href: "/dashboard/transactions",
        icon: <FiList aria-hidden="true" />,
        metricCards: 6,
      },
      {
        label: "LP Billing",
        href: "/dashboard/billing",
        icon: <FiCreditCard aria-hidden="true" />,
        metricCards: 4,
      },
    ],
  },
  {
    title: "Operations",
    items: [
      {
        label: "Scan & Redeem",
        href: "/dashboard/staff",
        icon: <FiCheckSquare aria-hidden="true" />,
      },
      // "Team" rather than "Users": that label already belongs to the customers
      // who claim vouchers, and these are the people who sign in here.
      {
        label: "Team",
        href: "/dashboard/team",
        icon: <FiUserPlus aria-hidden="true" />,
      },
      {
        label: "Settings",
        href: "/dashboard/settings",
        icon: <FiSettings aria-hidden="true" />,
      },
    ],
  },
];

const staffLabels = new Set([
  "Dashboard",
  "Slots",
  "Vouchers",
  "Users",
  "Loyalty Points",
  // Scoped to their own business by the page, so a partner sees their own checkout's
  // history and nobody else's.
  "Transactions",
  // A partner's own staff need to see what they owe and what they are owed.
  "LP Billing",
  "Scan & Redeem",
]);

// Sections are filtered item by item, then any section left with nothing is
// dropped so a role never sees a heading with no links under it.
function visibleSections(role: "super_admin" | "admin" | "staff") {
  return navSections
    .map((section) => ({
      title: section.title,
      items: section.items.filter((item) => {
        if (role === "staff") return staffLabels.has(item.label);
        // Settings and Team are super-admin only. An admin who could create
        // accounts could create itself a super-admin, so the boundary holds
        // here as well as in the page and the API behind it.
        if (
          item.href === "/dashboard/settings" ||
          item.href === "/dashboard/team"
        ) {
          return role === "super_admin";
        }
        return true;
      }),
    }))
    .filter((section) => section.items.length > 0);
}

function isNavActive(pathname: string, href: string) {
  if (href.includes("#")) return false;
  if (href === "/dashboard") return pathname === "/dashboard";
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function Sidebar({
  adminEmail,
  adminName,
  role,
  staffBusinessName,
}: {
  adminEmail: string;
  adminName: string;
  role: "super_admin" | "admin" | "staff";
  staffBusinessName?: string;
}) {
  const pathname = usePathname();
  const { navigate, pendingHref } = useRouteNavigation();

  // While a click is in flight the router still reports the old path, so the
  // row the cursor just left would keep the highlight and the page would look
  // like it had ignored the click. The destination wears it from the moment it
  // is asked for.
  const activePath = pendingHref ?? pathname;

  function onNavClick(
    event: React.MouseEvent<HTMLAnchorElement>,
    href: string,
    metricCards: number,
  ) {
    // A modified click means open elsewhere — that is the browser's to handle,
    // and swapping this tab to a skeleton for it would be wrong twice over.
    if (
      event.defaultPrevented ||
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey
    ) {
      return;
    }
    // Already here: nothing is going to load, so nothing should blank out.
    if (isNavActive(pathname, href)) return;
    event.preventDefault();
    navigate(href, <RouteSkeleton metricCards={metricCards} />);
  }

  return (
    <aside className="sidebar">
      {/* The mark is the way home, as it is on every other console: clicking a
          product logo is a habit people arrive with. */}
      <Link
        className="sidebar-brand"
        href="/dashboard"
        onClick={(event) => onNavClick(event, "/dashboard", 4)}
      >
        <Image
          alt=""
          className="logo-tile small"
          height={36}
          priority
          src="/images/voucher-hunt-app-logo.png"
          width={36}
        />
        <strong>Voucher Hunt</strong>
      </Link>
      <nav className="sidebar-nav">
        {visibleSections(role).map((section) => (
          <div className="sidebar-nav-section" key={section.title}>
            <h2 className="sidebar-nav-section-title">{section.title}</h2>
            {section.items.map((item) => (
              <Link
                aria-current={isNavActive(activePath, item.href) ? "page" : undefined}
                className={`nav-item ${isNavActive(activePath, item.href) ? "active" : ""}`}
                href={item.href}
                key={item.label}
                onClick={(event) =>
                  onNavClick(event, item.href, item.metricCards ?? 0)
                }
              >
                <span className="nav-item-icon">{item.icon}</span>
                <span className="nav-item-label">{item.label}</span>
              </Link>
            ))}
          </div>
        ))}
      </nav>
      {/* The business a staff account is scoped to belongs to the account, not
          to the product name it used to sit under. */}
      <SidebarAccountMenu
        adminEmail={adminEmail}
        adminName={adminName}
        businessName={role === "staff" ? (staffBusinessName ?? "Unassigned business") : undefined}
        role={role}
      />
    </aside>
  );
}
