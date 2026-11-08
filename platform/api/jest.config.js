/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/tests'],
  testMatch: ['**/*.test.ts'],
  // Sandbox host paths (/etc/platform, backups) for every test file.
  setupFiles: ['<rootDir>/tests/setup-host-paths.ts'],
  transformIgnorePatterns: ['node_modules/(?!@kubernetes/client-node)/'],
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/src/$1',
  },
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/server.ts',
    '!src/config/database.ts',
    '!src/config/mongoose.ts',
    '!src/config/kubernetes.ts',
  ],
  coverageDirectory: 'coverage',
  coverageReporters: ['text', 'lcov'],
};
