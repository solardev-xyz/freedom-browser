/** @type {import('jest').Config} */
module.exports = {
  testMatch: ['**/*.test.js'],
  testPathIgnorePatterns: ['/node_modules/', '/dist/', '/bee-bin/', '/ipfs-bin/'],
  collectCoverageFrom: ['src/**/*.js', '!src/**/*.test.js', '!src/renderer/vendor/**'],
  coverageThreshold: {
    global: {
      statements: 66,
      branches: 53,
      functions: 71,
      lines: 67,
    },
  },
  transform: {
    '^.+\\.js$': 'babel-jest',
  },
  transformIgnorePatterns: ['/node_modules/'],
};
