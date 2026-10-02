import { Link, parsePath, useLocation, type LinkProps } from "react-router-dom";

/** `?server=…` from a search string, or "" when no server is named. Page parameters such as `view` stay behind. */
export function serverSearch(search: string) {
  const server = new URLSearchParams(search).get("server");
  return server ? `?${new URLSearchParams({ server })}` : "";
}

/** Keep the selected server when navigating between dashboard game pages. The target's own parameters are kept. */
export function ServerLink({ to, ...props }: LinkProps) {
  const location = useLocation();
  if (typeof to !== "string") return <Link {...props} to={to} />;
  const path = parsePath(to);
  const params = new URLSearchParams(path.search);
  const server = new URLSearchParams(location.search).get("server");
  if (server) params.set("server", server);
  const search = params.toString();
  return <Link {...props} to={{ ...path, search: search ? `?${search}` : "" }} />;
}
