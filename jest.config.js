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
          // Jest runs on CommonJS; override the project's Node16 module
          // settings and pull in the Jest globals (the base config restricts
          // `types` to "node").
          module: "CommonJS",
          moduleResolution: "node",
          types: ["node", "jest"],
          strict: true,
          esModuleInterop: true,
          noUnusedLocals: false,
          noUnusedParameters: false,
        },
      },
    ],
  },
};
