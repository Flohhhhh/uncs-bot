import assert from "node:assert/strict";
import { createRailwayContext, project, type ServiceNode } from "railway/iac";
import definition from "../.railway/railway";

/** Evaluate only the SDK's local resource declarations. Never contact Railway, link a project, plan or apply. */
async function main() {
  const config = await definition(createRailwayContext({ environment: "staging" }), project);
  const resources = config.resources?.flat() as ServiceNode[];
  assert.equal(resources.length, 3);
  assert.deepEqual(resources.map((resource) => resource.name).sort(), ["monorepo-api", "monorepo-bot", "monorepo-web"]);
  for (const resource of resources) {
    assert.equal(resource.type, "service");
    assert.equal(resource.deploy?.healthcheckPath, "/health/ready");
    assert.equal(resource.deploy?.numReplicas, 1);
    assert.equal(resource.deploy?.overlapSeconds, 0);
    assert.equal(resource.source?.rootDirectory, "/");
    assert(resource.build?.buildCommand?.startsWith("npm run build:"));
    assert(resource.build?.watchPatterns?.includes("/package-lock.json"));
    assert(!Object.keys(resource.networking?.customDomains ?? {}).length);
  }
  console.info(
    "Railway SDK declaration: three separate root-build services, one replica, readiness and no domains passed.",
  );
}
void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
