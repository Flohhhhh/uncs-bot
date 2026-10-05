import { createEnv } from "@t3-oss/env-nextjs";
import { z } from "zod";

export const env = createEnv({
  server: {
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    BACKEND_URL: z.url({ protocol: /^https?$/ }).optional(),
  },
  client: {},
  runtimeEnv: { NODE_ENV: process.env.NODE_ENV, BACKEND_URL: process.env.BACKEND_URL },
  emptyStringAsUndefined: true,
});
