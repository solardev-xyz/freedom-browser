const fs = require('fs');
const os = require('os');
const path = require('path');
const { writeAccountRecords } = require('./core-account-records');

describe('writeAccountRecords', () => {
  let dir;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'core-account-records-'));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  const LEDGER = {
    index: 1000001,
    name: 'Ledger',
    address: '0x9858EfFD232B4033E47d90003D41EC34EcaEda94',
    type: 'ledger',
  };

  test('the hardware counter is one past the highest hardware index written', () => {
    expect(writeAccountRecords(dir, [LEDGER]).nextHardwareWalletIndex).toBe(1000002);
  });

  test("the hardware counter never moves back below the file's own", () => {
    fs.writeFileSync(
      path.join(dir, 'vault-meta.json'),
      JSON.stringify({ derivedWallets: [], activeWalletIndex: 0, nextHardwareWalletIndex: 1000009 })
    );
    expect(writeAccountRecords(dir, [LEDGER]).nextHardwareWalletIndex).toBe(1000009);
    const stored = JSON.parse(fs.readFileSync(path.join(dir, 'vault-meta.json'), 'utf8'));
    expect(stored.nextHardwareWalletIndex).toBe(1000009);
  });
});
