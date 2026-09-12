'use strict';
jest.mock('fs');
jest.mock('child_process', () => ({ execFileSync: jest.fn() }));
const fs = require('fs');
const { execFileSync } = require('child_process');
const { buildLinuxWorkspaceSupervisor } = require('./build-linux-workspace-supervisor');
const { digest } = require('../src/main/agent/workspace-execution/linux-supervisor-runtime');
const linuxTest = process.platform === 'linux' ? test : test.skip;
beforeEach(() => {
  jest.resetAllMocks();
  fs.readFileSync.mockImplementation((name) => {
    if (name.endsWith('linux-supervisor.c')) return Buffer.from('source');
    throw new Error('absent');
  });
});
linuxTest('unsupported Linux package target creates resource directory without compiling', () => {
  buildLinuxWorkspaceSupervisor('arm64');
  expect(fs.mkdirSync).toHaveBeenCalledWith(expect.stringMatching(/out\/linux-workspace-owner\/arm64$/), { recursive: true });
  expect(execFileSync).not.toHaveBeenCalled(); expect(fs.readFileSync).not.toHaveBeenCalled();
});
linuxTest('missing compiler warns in development but fails supported packaging', () => {
  const warning = jest.spyOn(console, 'warn').mockImplementation(() => {});
  expect(() => buildLinuxWorkspaceSupervisor('x64', { development: true })).not.toThrow();
  expect(warning).toHaveBeenCalledTimes(1);
  expect(() => buildLinuxWorkspaceSupervisor('x64')).toThrow('Installed GCC required');
  expect(execFileSync).not.toHaveBeenCalled(); warning.mockRestore();
});
linuxTest('exact prebuilt helper is accepted without compiler', () => {
  const binary = Buffer.alloc(64); Buffer.from([127, 69, 76, 70, 2, 1]).copy(binary);
  binary.writeUInt16LE(3, 16); binary.writeUInt16LE(62, 18);
  fs.readFileSync.mockImplementation((name) => name.endsWith('linux-supervisor.c') ? Buffer.from('source') :
    name.endsWith('manifest.json') ? JSON.stringify({ protocol: 1, architecture: 'x64', minimumKernel: '5.9',
      sourceSha256: digest(Buffer.from('source')), binarySha256: digest(binary) }) : binary);
  buildLinuxWorkspaceSupervisor('x64');
  expect(fs.existsSync).not.toHaveBeenCalled(); expect(execFileSync).not.toHaveBeenCalled();
});
linuxTest('unknown path-like target is refused', () => {
  expect(() => buildLinuxWorkspaceSupervisor('../x64')).toThrow('Unknown target');
  expect(fs.mkdirSync).not.toHaveBeenCalled();
});
