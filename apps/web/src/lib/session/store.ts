import { endSession, readSession, SessionError, type Staff } from "./client";

export type SessionState = {
  status: "checking" | "authenticated" | "signed-out" | "denied" | "unavailable";
  user: Staff | null;
  message?: string;
  failure?: "session" | "logout";
};
export const initialSession: SessionState = { status: "checking", user: null };

export class SessionStore {
  private state = initialSession;
  private readonly listeners = new Set<() => void>();
  private generation = 0;
  private controller?: AbortController;
  private logoutCsrf?: string;
  private loggingOut = false;

  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  private publish(state: SessionState) {
    this.state = state;
    this.listeners.forEach((listener) => listener());
  }
  cancel = () => {
    this.generation++;
    this.controller?.abort();
    this.controller = undefined;
  };
  pauseChecks = () => {
    if (!this.loggingOut && !this.logoutCsrf) this.cancel();
  };
  check = async () => {
    if (this.loggingOut || this.logoutCsrf) return;
    this.cancel();
    const version = this.generation;
    const controller = new AbortController();
    this.controller = controller;
    const previouslyAuthenticated = this.state.status === "authenticated";
    if (!previouslyAuthenticated) this.publish(initialSession);
    try {
      const user = await readSession(controller.signal);
      if (version !== this.generation) return;
      this.publish({ status: "authenticated", user });
    } catch (error) {
      if (version !== this.generation) return;
      if (error instanceof SessionError && error.status === 401) {
        this.publish({
          status: "signed-out",
          user: null,
          message: previouslyAuthenticated ? "Your session expired. Sign in again." : undefined,
        });
      } else if (error instanceof SessionError && error.status === 403) {
        this.publish({ status: "denied", user: null });
      } else {
        this.publish({
          status: "unavailable",
          user: null,
          failure: "session",
          message: "Staff access could not be verified. Check the backend connection and try again.",
        });
      }
    } finally {
      if (version === this.generation) this.controller = undefined;
    }
  };
  signOut = async () => {
    if (this.loggingOut) return;
    const csrf = this.logoutCsrf ?? this.state.user?.csrf;
    if (!csrf) return;
    this.logoutCsrf = csrf;
    this.loggingOut = true;
    this.cancel();
    const version = this.generation;
    const controller = new AbortController();
    this.controller = controller;
    this.publish(initialSession);
    try {
      await endSession(csrf, controller.signal);
      if (version !== this.generation) return;
      this.logoutCsrf = undefined;
      this.publish({ status: "signed-out", user: null, message: "You signed out." });
    } catch (error) {
      if (version !== this.generation) return;
      if (error instanceof SessionError && error.status === 401) {
        this.logoutCsrf = undefined;
        this.publish({ status: "signed-out", user: null, message: "Your session already ended." });
      } else {
        this.publish({
          status: "unavailable",
          user: null,
          failure: "logout",
          message: "Sign-out could not be confirmed. Retry to end your browser session.",
        });
      }
    } finally {
      this.loggingOut = false;
      if (version === this.generation) this.controller = undefined;
    }
  };
}
