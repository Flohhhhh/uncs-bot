import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { ROOT } from "./utils/scripts.constants";

const [mode, ...requestedFiles] = process.argv.slice(2);

if (mode !== "--write" && mode !== "--check") {
  console.error("Usage: run-prettier.ts --write|--check [file ...]");
  process.exit(1);
}

const webRoot = path.join(ROOT, "apps", "web");
const isWebFile = (file: string) => path.resolve(process.cwd(), file).startsWith(`${webRoot}${path.sep}`);
const backendFiles = requestedFiles.length
  ? requestedFiles.filter((file) => !isWebFile(file))
  : [
      "src/**/*.ts",
      "test/**/*.ts",
      "scripts/**/*.ts",
      ".railway/**/*.ts",
      "apps/{api,bot}/src/**/*.ts",
      "apps/{api,bot}/tests/**/*.ts",
      "apps/{api,bot}/*.{mjs,json,md}",
      "packages/*/src/**/*.ts",
      "packages/*/*.{json,md}",
      "web/admin/**/*.{ts,tsx,mts,css,html,json}",
    ];
const webFiles = requestedFiles.length
  ? requestedFiles.filter(isWebFile).map((file) => path.relative(webRoot, path.resolve(process.cwd(), file)))
  : ["src/**/*.{ts,tsx,css}", "tests/**/*.{ts,tsx}", "*.{ts,mjs,json,md}", "!package-lock.json", "!next-env.d.ts"];
const prettierCli = require.resolve("prettier/bin/prettier.cjs");

function run(cli: string, files: string[], cwd: string, extra: string[] = []) {
  if (!files.length) return;
  const result = spawnSync(process.execPath, [cli, mode, "--no-error-on-unmatched-pattern", ...extra, ...files], {
    cwd,
    stdio: "inherit",
  });
  if (result.error) {
    console.error(`Unable to run Prettier: ${result.error.message}`);
    process.exit(1);
  }
  if (result.status !== 0) process.exit(result.status ?? 1);
}

run(prettierCli, backendFiles, process.cwd());
const webCli = require.resolve("prettier/bin/prettier.cjs", { paths: [webRoot] });
// Backend-only installs can check basic web formatting without loading its Tailwind plugin.
run(
  existsSync(webCli) ? webCli : prettierCli,
  webFiles,
  webRoot,
  existsSync(webCli) ? [] : ["--config", path.join(ROOT, ".prettierrc")],
);
