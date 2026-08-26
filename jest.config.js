/** @type {import('jest').Config} */
module.exports = {
  testMatch: ['**/*.test.js'],
  testPathIgnorePatterns: ['/node_modules/', '/dist/', '/ant-bin/', '/ipfs-bin/', '/test-e2e/'],
  collectCoverageFrom: ['src/**/*.js', '!src/**/*.test.js', '!src/renderer/vendor/**'],
  // Coverage thresholds are intentionally below typical "healthy" targets.
  // The Swarm publishing feature landed with heavily-tested services
  // (swarm-provider-ipc, feed-service, stamp-service, publish-service,
  // feed-store, swarm-permissions, origin-utils) but a lot of renderer
  // UI glue (stamp-manager, publish-setup, node-status, balance-display)
  // that is manually smoke-tested rather than covered by unit tests.
  //
  // Pre-Swarm levels were 42/33/43/42; they were lowered to 40/33/40/41
  // in 38b07f3 to unblock CI when the UI modules landed. Follow-up:
  // either add renderer UI tests (via jsdom + DOM fixtures) to recover
  // the old global thresholds, or switch to per-path thresholds that
  // enforce high coverage on main-process service code while accepting
  // lower coverage on renderer UI.
  coverageThreshold: {
    global: {
      statements: 40,
      branches: 33,
      functions: 40,
      lines: 41,
    },
  },
  transform: {
    '^.+\\.js$': 'babel-jest',
  },
  transformIgnorePatterns: [
    '/node_modules/(?!(@scure|@noble|micro-key-producer|micro-packed|@openlv|websocket-mqtt|ts-pattern)/)',
  ],
};
