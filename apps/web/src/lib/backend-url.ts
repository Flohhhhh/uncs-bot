import { env } from "../env";

export function getBackendUrl() {
  return env.BACKEND_URL ?? (env.NODE_ENV === "development" ? "http://127.0.0.1:4320" : undefined);
}
