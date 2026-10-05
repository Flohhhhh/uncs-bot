import type { NextConfig } from "next";

import { getBackendUrl } from "./src/lib/backend-url";

const backendUrl = getBackendUrl();

const nextConfig: NextConfig = {
  turbopack: { root: import.meta.dirname },
  rewrites() {
    if (!backendUrl) return [];
    const origin = backendUrl.replace(/\/$/, "");
    return [{ source: "/admin/api/:path*", destination: `${origin}/admin/api/:path*` }];
  },
};

export default nextConfig;
