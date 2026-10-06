import path from "node:path";
import { spawnSync } from "node:child_process";
import ts from "typescript";
import { ROOT } from "./utils/scripts.constants";

const configPath = path.join(ROOT, "tsconfig.json");
const configFile = ts.readConfigFile(configPath, ts.sys.readFile);

if (configFile.error) {
  reportDiagnostics([configFile.error]);
  process.exit(1);
}

const parsedConfig = ts.parseJsonConfigFileContent(configFile.config, ts.sys, ROOT);
const requestedFiles = process.argv.slice(2);
const workspaceRoots = ["apps/api", "apps/bot", "packages/contracts", "packages/api-client"].map((root) =>
  path.join(ROOT, root),
);
const workspaceFiles = requestedFiles.filter((file) =>
  workspaceRoots.some((root) => path.resolve(file).startsWith(`${root}${path.sep}`)),
);
if (!requestedFiles.length || workspaceFiles.length) {
  const build = spawnSync("npm", ["run", "build:packages"], { cwd: ROOT, stdio: "inherit" });
  if (build.status !== 0) process.exit(build.status ?? 1);
}
for (const root of workspaceRoots) {
  if (requestedFiles.length && !workspaceFiles.some((file) => path.resolve(file).startsWith(`${root}${path.sep}`)))
    continue;
  const result = spawnSync("npm", ["run", "typecheck"], { cwd: root, stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
const remainingFiles = requestedFiles.filter((file) => !workspaceFiles.includes(file));
if (requestedFiles.length && !remainingFiles.length) process.exit(0);
const webRoot = path.join(ROOT, "apps", "web");
const isWebFile = (file: string) => path.resolve(process.cwd(), file).startsWith(`${webRoot}${path.sep}`);
const webFiles = remainingFiles.filter(isWebFile);
const backendFiles = remainingFiles.filter((file) => !isWebFile(file));

if (webFiles.length || !requestedFiles.length) {
  const result = spawnSync("npm", ["run", "typecheck"], { cwd: webRoot, stdio: "inherit" });
  if (result.error) {
    console.error("Unable to check web files. Run npm ci inside apps/web first.", result.error.message);
    process.exit(1);
  }
  if (result.status !== 0) process.exit(result.status ?? 1);
  if (requestedFiles.length && !backendFiles.length) process.exit(0);
}

const rootNames = requestedFiles.length
  ? backendFiles.map((file) => path.resolve(process.cwd(), file))
  : parsedConfig.fileNames;

const program = ts.createProgram({
  rootNames,
  options: { ...parsedConfig.options, noEmit: true, incremental: false },
});

const diagnostics = [
  ...parsedConfig.errors,
  ...program.getConfigFileParsingDiagnostics(),
  ...program.getSyntacticDiagnostics(),
  ...program.getOptionsDiagnostics(),
  ...program.getSemanticDiagnostics(),
];

if (diagnostics.length > 0) {
  reportDiagnostics(diagnostics);
  process.exit(1);
}

console.info(requestedFiles.length ? `Typecheck passed for ${requestedFiles.join(", ")}.` : "Typecheck passed.");

function reportDiagnostics(diagnostics: readonly ts.Diagnostic[]) {
  const host: ts.FormatDiagnosticsHost = {
    getCanonicalFileName: (fileName) => fileName,
    getCurrentDirectory: () => ROOT,
    getNewLine: () => ts.sys.newLine,
  };

  console.error(ts.formatDiagnosticsWithColorAndContext(diagnostics, host));
}
