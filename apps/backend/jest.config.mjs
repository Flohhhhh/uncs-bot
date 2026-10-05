export default {
  testEnvironment: "node",
  testMatch: ["<rootDir>/tests/**/*.spec.ts"],
  transform: {
    "^.+\\.ts$": ["ts-jest", { tsconfig: "<rootDir>/tsconfig.json" }],
  },
};
