import { Link, useLocation, type LinkProps } from "react-router-dom";

/** Keep the selected server when navigating between dashboard game pages. */
export function ServerLink({ to, ...props }: LinkProps) {
  const location = useLocation();
  return <Link {...props} to={typeof to === "string" ? { pathname: to, search: location.search } : to} />;
}
