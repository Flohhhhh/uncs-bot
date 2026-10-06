module.exports = {
  rootDir: ".",
  testMatch: ["<rootDir>/tests/**/*.spec.ts"],
  testEnvironment: "node",
  transform: { "^.+\\.ts$": ["ts-jest", { tsconfig: "tsconfig.test.json" }] },
};
