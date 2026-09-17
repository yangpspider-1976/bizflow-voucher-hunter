"use client";

import { useEffect, useRef, type ReactNode } from "react";

/**
 * Shared dashboard modal chrome: backdrop + centered dialog with a header.
 * Closes on Escape, backdrop click, or the × button; locks background scroll.
 * Callers provide the body/footer (typically a <form className="modal-form">).
 */
export function AdminModal({
  title,
  subtitle,
  onClose,
  children,
}: {
  title: string;
  subtitle?: string;
  onClose: () => void;
  children: ReactNode;
}) {
  // Held in a ref so the effect below is scoped to the modal's lifetime rather
  // than to the identity of a prop.
  //
  // Callers pass `onClose` inline (`onClose={() => setOpen(false)}`), so it is a
  // new function on every render of the parent — and with it in the dependency
  // list the effect tore down and re-ran on every keystroke inside the modal,
  // detaching and re-attaching the keydown listener and re-reading the scroll
  // lock each time. The lock itself survived that (cleanup and re-setup run in
  // the same commit, with no paint between them to expose the gap), so this is
  // not a fix for a visible bug; it is the effect saying what it means. Mount
  // and unmount are when the lock should be taken and released, and reading the
  // callback through the ref keeps Escape pointed at the latest one without
  // tying the listener's lifetime to the parent's render count.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onCloseRef.current();
    };
    window.addEventListener("keydown", onKey);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = previousOverflow;
    };
  }, []);

  return (
    <div
      className="modal-overlay"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="modal-dialog" role="dialog" aria-modal="true" aria-label={title}>
        <div className="modal-header">
          <div>
            <strong>{title}</strong>
            {subtitle ? <p className="muted">{subtitle}</p> : null}
          </div>
          <button className="modal-close" onClick={onClose} type="button" aria-label="Close">
            ×
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
