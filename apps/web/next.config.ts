import path from "node:path";
import type { NextConfig } from "next";

import { getBackendUrl } from "./src/lib/backend-url";

const backendUrl = getBackendUrl();

const nextConfig: NextConfig = {
  allowedDevOrigins: ["127.0.0.1"],
  turbopack: { root: path.resolve(import.meta.dirname, "../..") },
  rewrites() {
    if (!backendUrl) return [];
    const origin = backendUrl.replace(/\/$/, "");
    return [
      { source: "/admin/api/:path*", destination: `${origin}/admin/api/:path*` },
      { source: "/apply/:path*", destination: `${origin}/apply/:path*` },
      { source: "/supporters/link/:path*", destination: `${origin}/supporters/link/:path*` },
    ];
  },
};

export default nextConfig;
