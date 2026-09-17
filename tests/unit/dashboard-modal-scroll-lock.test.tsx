// @vitest-environment jsdom
import { useState } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const { AdminModal } = await import("@/app/dashboard/_components/AdminModal");

/**
 * The modal owns two things for as long as it is open: the background scroll
 * lock, and Escape.
 *
 * Both hang off one effect, and every caller passes `onClose` inline — a new
 * function on each render of the parent. The effect is therefore scoped to the
 * modal's own lifetime and reaches the callback through a ref. These cover the
 * two ways that can go wrong: a lock that lapses because the effect re-ran, and
 * an Escape handler left pointing at the first render's closure.
 */
describe("AdminModal", () => {
  afterEach(cleanup);

  /**
   * A modal whose parent re-renders on every keystroke, as RedemptionImport
   * does — and whose `onClose` closes over the current text, so a handler stuck
   * on an earlier render reports the wrong value rather than merely being a
   * different function object.
   */
  function Host({ onClose }: { onClose: (text: string) => void }) {
    const [text, setText] = useState("");
    return (
      <AdminModal onClose={() => onClose(text)} title="Import redemptions">
        <input
          aria-label="codes"
          onChange={(event) => setText(event.target.value)}
          value={text}
        />
      </AdminModal>
    );
  }

  function type(value: string) {
    act(() => {
      fireEvent.change(screen.getByLabelText("codes"), { target: { value } });
    });
  }

  it("holds the scroll lock across parent re-renders", () => {
    render(<Host onClose={() => {}} />);
    expect(document.body.style.overflow).toBe("hidden");
    for (const value of ["A", "AB", "ABC"]) {
      type(value);
      expect(document.body.style.overflow).toBe("hidden");
    }
  });

  it("restores the page's own overflow when it closes", () => {
    document.body.style.overflow = "clip";
    const view = render(<Host onClose={() => {}} />);
    expect(document.body.style.overflow).toBe("hidden");
    view.unmount();
    expect(document.body.style.overflow).toBe("clip");
    document.body.style.overflow = "";
  });

  // The one a mount-scoped effect can genuinely get wrong: bind `onClose`
  // directly with an empty dependency list and Escape keeps calling the first
  // render's closure forever.
  it("Escape runs the latest onClose, not the one from first render", () => {
    const onClose = vi.fn();
    render(<Host onClose={onClose} />);
    type("ABC");
    act(() => {
      fireEvent.keyDown(window, { key: "Escape" });
    });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledWith("ABC");
  });

  it("stops listening for Escape once unmounted", () => {
    const onClose = vi.fn();
    const view = render(<Host onClose={onClose} />);
    view.unmount();
    act(() => {
      fireEvent.keyDown(window, { key: "Escape" });
    });
    expect(onClose).not.toHaveBeenCalled();
  });
});
