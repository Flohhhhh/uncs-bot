import type { NextConfig } from "next";

import { env } from "./src/env";

const backendUrl = env.BACKEND_URL ?? (env.NODE_ENV === "development" ? "http://127.0.0.1:4320" : undefined);

const nextConfig: NextConfig = {
  turbopack: { root: import.meta.dirname },
  rewrites() {
    if (!backendUrl) return [];
    const origin = backendUrl.replace(/\/$/, "");
    return [
      { source: "/admin/api/:path*", destination: `${origin}/admin/api/:path*` },
      { source: "/admin/auth/:path*", destination: `${origin}/admin/auth/:path*` },
    ];
  },
};

export default nextConfig;
