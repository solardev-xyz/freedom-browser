/** @type {import('jest').Config} */
module.exports = {
  testMatch: ['**/*.test.js'],
  testPathIgnorePatterns: ['/node_modules/', '/dist/', '/bee-bin/', '/ipfs-bin/'],
  collectCoverageFrom: ['src/**/*.js', '!src/**/*.test.js', '!src/renderer/vendor/**'],
  coverageThreshold: {
    global: {
      statements: 42,
      branches: 33,
      functions: 43,
      lines: 42,
    },
  },
  transform: {
    '^.+\\.js$': 'babel-jest',
  },
  transformIgnorePatterns: [
    '/node_modules/(?!(@scure|@noble|micro-key-producer)/)',
  ],
};
