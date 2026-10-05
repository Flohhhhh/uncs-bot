import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTypescript from "eslint-config-next/typescript";
import prettier from "eslint-config-prettier/flat";

export default defineConfig([
  ...nextVitals,
  ...nextTypescript,
  prettier,
  {
    settings: { next: { rootDir: import.meta.dirname } },
  },
  globalIgnores([".next/**", "out/**", "coverage/**", "node_modules/**", "next-env.d.ts"]),
]);
