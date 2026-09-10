import { spawnSync } from "node:child_process";

const [mode, ...requestedFiles] = process.argv.slice(2);

if (mode !== "--write" && mode !== "--check") {
  console.error("Usage: run-prettier.ts --write|--check [file ...]");
  process.exit(1);
}

const files = requestedFiles.length > 0 ? requestedFiles : ["src/**/*.ts", "scripts/**/*.ts"];
const prettierCommand = process.platform === "win32" ? "prettier.cmd" : "prettier";
const result = spawnSync(prettierCommand, [mode, ...files], { stdio: "inherit" });

if (result.error) {
  console.error(`Unable to run Prettier: ${result.error.message}`);
  process.exit(1);
}

process.exit(result.status ?? 1);
