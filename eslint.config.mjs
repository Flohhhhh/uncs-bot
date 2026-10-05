import js from "@eslint/js";
import eslintConfigPrettier from "eslint-config-prettier";
import prettierPlugin from "eslint-plugin-prettier";
import tseslint from "typescript-eslint";
import { existsSync } from "node:fs";
import process from "node:process";
import { URL } from "node:url";

const webInstalled = existsSync(new URL("./apps/web/node_modules/eslint-config-next/package.json", import.meta.url));
const checkingWebFiles = process.argv.some((argument) => argument.replaceAll("\\", "/").includes("apps/web"));
if (checkingWebFiles && !webInstalled) {
  throw new Error("Install the standalone web dependencies with npm --prefix apps/web ci before linting web files.");
}
const webConfigs = webInstalled ? (await import("./apps/web/eslint.config.mjs")).default : [];
const webPrefix = (pattern) => (pattern.startsWith("!") ? `!apps/web/${pattern.slice(1)}` : `apps/web/${pattern}`);
const scopedWebConfigs = webConfigs.map((config) => ({
  ...config,
  ...(config.ignores ? { ignores: config.ignores.map(webPrefix) } : {}),
  ...(!config.files && config.ignores && Object.keys(config).every((key) => ["ignores", "name"].includes(key))
    ? {}
    : {
        files: config.files
          ? config.files.map((pattern) => (Array.isArray(pattern) ? pattern.map(webPrefix) : webPrefix(pattern)))
          : ["apps/web/**/*.{js,jsx,mjs,cjs,ts,tsx,mts,cts}"],
      }),
}));

/**
 * A shared ESLint configuration for the repository.
 *
 * @type {import("eslint").Linter.Config}
 * */
const backendConfigs = [
  js.configs.recommended,
  eslintConfigPrettier,
  ...tseslint.configs.recommended,
  {
    ignores: ["dist/**"],
  },
  {
    plugins: {
      prettier: prettierPlugin,
    },
    rules: {
      "@typescript-eslint/interface-name-prefix": "off",
      "@typescript-eslint/explicit-function-return-type": "off",
      "@typescript-eslint/explicit-module-boundary-types": "off",
      "@typescript-eslint/no-empty-object-type": "off",
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": [
        "warn",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
        },
      ],
      "@typescript-eslint/ban-ts-comment": "off",

      "prettier/prettier": "warn",

      "no-console": ["warn", { allow: ["warn", "error", "info", "table", "trace"] }],
    },
  },
];

export default [
  {
    ignores: [
      "apps/backend/dist/**",
      "apps/backend/node_modules/**",
      "apps/backend/coverage/**",
      "apps/web/node_modules/**",
      "apps/web/.next/**",
      ...(!webInstalled ? ["apps/web/**"] : []),
    ],
  },
  ...backendConfigs.map((config) =>
    Object.keys(config).every((key) => ["ignores", "name"].includes(key))
      ? config
      : { ...config, ignores: [...(config.ignores ?? []), "apps/web/**"] },
  ),
  ...scopedWebConfigs,
];
