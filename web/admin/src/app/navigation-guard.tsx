import { useEffect, useRef } from "react";
import { useBlocker } from "react-router-dom";
import { useAdmin } from "./context";
import { Modal } from "../components/ui";

export function NavigationGuard({
  unsaved,
  logoutRequested,
  cancelLogout,
  confirmLogout,
}: {
  unsaved: boolean;
  logoutRequested: boolean;
  cancelLogout: () => void;
  confirmLogout: () => void;
}) {
  const { busy, dialogOpen } = useAdmin();
  // Capture why navigation was blocked before opening our own confirmation.
  const reason = useRef<"draft" | "review" | null>(null);
  const blocker = useBlocker(({ currentLocation, nextLocation }) => {
    if (currentLocation.pathname === nextLocation.pathname && currentLocation.search === nextLocation.search)
      return false;
    if (reason.current === "draft") return true;
    reason.current = busy || dialogOpen ? "review" : unsaved ? "draft" : null;
    return reason.current !== null;
  });
  useEffect(() => {
    if (blocker.state === "unblocked") reason.current = null;
    // Back/Forward must not abandon an active review, batch or pending request.
    if (blocker.state === "blocked" && reason.current === "review") blocker.reset();
  }, [blocker]);
  useEffect(() => {
    if (!busy && !unsaved) return;
    const guard = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", guard);
    return () => window.removeEventListener("beforeunload", guard);
  }, [busy, unsaved]);

  const leaving = blocker.state === "blocked" && reason.current === "draft";
  if (!leaving && !logoutRequested) return null;
  const stay = () => {
    if (blocker.state === "blocked") blocker.reset();
    cancelLogout();
  };
  const discard = () => {
    if (logoutRequested) confirmLogout();
    else if (blocker.state === "blocked") blocker.proceed();
  };
  return (
    <Modal
      title="Discard unsaved changes?"
      description="Your settings and rotation drafts have not been saved."
      onClose={stay}
    >
      <div className="dialog-actions">
        <button type="button" className="button secondary" onClick={stay} autoFocus>
          Keep editing
        </button>
        <button type="button" className="button danger" onClick={discard}>
          {logoutRequested ? "Discard and sign out" : "Discard changes"}
        </button>
      </div>
    </Modal>
  );
}
