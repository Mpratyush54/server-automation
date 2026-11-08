// SDK integration tests import sibling SDK source. Resolve its dependencies from
// this package when only platform/api/node_modules is installed in a fix worktree.
const path = require('path');
const rootDir = path.resolve(__dirname, '..');
module.exports = {
  ...require('../jest.config.js'),
  rootDir,
  modulePaths: [path.join(rootDir, 'node_modules')],
  transform: {
    '^.+\\.tsx?$': ['ts-jest', {
      tsconfig: { baseUrl: rootDir, paths: { '@/*': ['src/*'], '*': ['node_modules/*'] } },
    }],
  },
};
