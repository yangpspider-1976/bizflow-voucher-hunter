"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback } from "react";
import { AdminChangeRequestNotice } from "./AdminChangeRequestNotice";

/**
 * The "saved" confirmation for forms that now live on their own route.
 *
 * A modal could hold its own success state because it stayed mounted after
 * submitting. A page form navigates away, so the outcome travels in the URL
 * (`?done=slot-created`) and is announced by the list page it lands on. The key
 * is dropped from the URL once the snackbar goes, so a refresh or a shared link
 * does not replay it.
 */
const MESSAGES: Record<string, string> = {
  "slot-created": "Slot created successfully.",
  "slot-requested": "Slot request submitted for admin approval.",
  "slot-revised": "Slot revision submitted for admin approval.",
  "pool-created": "Voucher benefit tier created successfully.",
  "pool-requested": "Voucher tier request submitted for admin approval.",
  "pool-revised": "Voucher tier revision submitted for admin approval.",
  "business-created": "Business created successfully.",
  "business-saved": "Business details saved.",
  "member-created": "Team member created. Share their password with them once.",
  "member-saved": "Team member updated.",
  "campaign-image-saved": "Campaign image updated.",
  "campaign-saved": "Campaign updated.",
};

export function FlashNotice() {
  const pathname = usePathname();
  const router = useRouter();
  const searchParams = useSearchParams();
  const key = searchParams.get("done");

  const dismiss = useCallback(() => {
    const params = new URLSearchParams(searchParams.toString());
    params.delete("done");
    const query = params.toString();
    router.replace(query ? `${pathname}?${query}` : pathname);
  }, [pathname, router, searchParams]);

  const message = key ? MESSAGES[key] : undefined;
  if (!message) return null;

  return <AdminChangeRequestNotice message={message} onDismiss={dismiss} />;
}
