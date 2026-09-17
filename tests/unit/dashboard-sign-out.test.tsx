// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const replace = vi.fn();
const refresh = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace, refresh }),
}));

const { SidebarAccountMenu } = await import(
  "@/app/dashboard/_components/SidebarAccountMenu"
);

/**
 * Signing out is the one action in the console that is only safe to *report* as
 * done once the server says the session is gone. It used to `await fetch(...)`
 * bare: a rejected request stopped the handler with no navigation and no
 * message, and a non-OK response navigated to /login regardless — showing a
 * signed-out screen over a session that was still live.
 */
describe("sidebar sign out", () => {
  function open() {
    render(
      <SidebarAccountMenu
        adminEmail="ops@example.com"
        adminName="Ops Lead"
        role="admin"
      />,
    );
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: /Account menu/ }));
    });
    return screen.getByRole("menuitem", { name: /Sign out/ });
  }

  beforeEach(() => {
    replace.mockClear();
    refresh.mockClear();
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("navigates to the login page when the server clears the session", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true }));
    fireEvent.click(open());
    await waitFor(() => expect(replace).toHaveBeenCalledWith("/login"));
    expect(refresh).toHaveBeenCalled();
  });

  it("stays put and says so when the request fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    fireEvent.click(open());
    await screen.findByRole("alert");
    expect(replace).not.toHaveBeenCalled();
    expect(screen.getByRole("alert").textContent).toMatch(/could not sign out/i);
  });

  // The dangerous one: a 500 left the cookie in place, and the old code sent the
  // operator to /login anyway.
  it("does not claim to have signed out on a non-OK response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 500 }));
    fireEvent.click(open());
    await screen.findByRole("alert");
    expect(replace).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
  });

  it("does not fire a second request while one is in flight", async () => {
    let settle: (value: { ok: boolean }) => void = () => {};
    const fetchMock = vi
      .fn()
      .mockReturnValue(new Promise<{ ok: boolean }>((resolve) => { settle = resolve; }));
    vi.stubGlobal("fetch", fetchMock);

    const signOut = open() as HTMLButtonElement;
    act(() => {
      fireEvent.click(signOut);
    });
    await waitFor(() => expect(signOut.disabled).toBe(true));

    act(() => {
      fireEvent.click(signOut);
      fireEvent.click(signOut);
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      settle({ ok: true });
    });
    expect(replace).toHaveBeenCalledWith("/login");
  });
});
