import * as tailwindPlugin from "prettier-plugin-tailwindcss";

const config = {
  printWidth: 120,
  plugins: [tailwindPlugin],
  tailwindStylesheet: "./src/app/globals.css",
  tailwindFunctions: ["cn", "cva"],
};

export default config;
