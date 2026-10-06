import { defineRailway, github, project, service } from "railway/iac";

/** New-stack services only. Apply to a separate staging project; legacy resources/domains are not declared here. */
export default defineRailway(() => {
  const application = (name: "web" | "api" | "bot", env: Record<string, string> = {}) =>
    service(`monorepo-${name}`, {
      source: github("Flohhhhh/uncs-bot", { branch: "monorepo", rootDirectory: "/" }),
      build: {
        builder: "RAILPACK",
        buildCommand: `npm run build:${name}`,
        watchPatterns: [`/apps/${name}/**`, "/packages/**", "/package.json", "/package-lock.json", "/tsconfig.json"],
      },
      start: `npm start --workspace @uncs/${name}`,
      healthcheck: "/health/ready",
      healthcheckTimeout: 120,
      replicas: 1,
      deploy: { restartPolicyType: "ON_FAILURE", restartPolicyMaxRetries: 3, overlapSeconds: 0, drainingSeconds: 30 },
      env: { NODE_ENV: "production", NEST_ENV: "production", ...env },
    });
  const api = application("api", { API_WORKERS_ENABLED: "false", API_MUTATIONS_ENABLED: "false" });
  const bot = application("bot", { BOT_GATEWAY_ENABLED: "false", NEST_ENV: "development" });
  const web = application("web");
  // Repository connection, credentials, service origins, database and hostnames are supplied separately.
  return project("uncs-bot-monorepo", { resources: [api, bot, web] });
});
