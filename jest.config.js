/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  preset: "ts-jest",
  testEnvironment: "node",
  roots: ["<rootDir>/tests"],
  testMatch: ["**/*.test.ts"],
  moduleNameMapper: {
    "^@scrypted/sdk$": "<rootDir>/tests/mocks/scrypted-sdk.ts",
  },
  clearMocks: true,
  transform: {
    "^.+\\.ts$": [
      "ts-jest",
      {
        tsconfig: {
          strict: true,
          esModuleInterop: true,
          noUnusedLocals: false,
          noUnusedParameters: false,
        },
      },
    ],
  },
};
