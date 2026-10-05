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
const webRoot = path.join(ROOT, "apps", "web");
const isWebFile = (file: string) => path.resolve(process.cwd(), file).startsWith(`${webRoot}${path.sep}`);
const webFiles = requestedFiles.filter(isWebFile);
const backendFiles = requestedFiles.filter((file) => !isWebFile(file));

if (webFiles.length) {
  const result = spawnSync("npm", ["run", "typecheck"], { cwd: webRoot, stdio: "inherit" });
  if (result.error) {
    console.error("Unable to check web files. Run npm ci inside apps/web first.", result.error.message);
    process.exit(1);
  }
  if (result.status !== 0) process.exit(result.status ?? 1);
  if (!backendFiles.length) process.exit(0);
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
