'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  PACKAGED_USER_DATA_ENV,
  PACKAGED_USER_DATA_PREFIX,
  configurePackagedQualificationUserData,
  validateQualificationUserData,
} = require('./qualification-user-data');

describe('packaged Electron qualification user data', () => {
  const roots = [];

  afterEach(async () => {
    await Promise.all(
      roots.splice(0).map((root) => fs.promises.rm(root, { recursive: true, force: true }))
    );
  });

  async function temporaryRoot(prefix = PACKAGED_USER_DATA_PREFIX) {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), prefix));
    roots.push(root);
    return root;
  }

  test('accepts only a private, fresh direct child of the temporary directory', async () => {
    const root = await temporaryRoot();
    expect(validateQualificationUserData(root, { requireEmpty: true })).toBe(
      await fs.promises.realpath(root)
    );

    await fs.promises.writeFile(path.join(root, 'existing-profile-data'), 'fixture');
    expect(() => validateQualificationUserData(root, { requireEmpty: true })).toThrow(
      'must be fresh and empty'
    );

    const wrongPrefix = await temporaryRoot('freedom-unrelated-');
    expect(() => validateQualificationUserData(wrongPrefix)).toThrow('validated user-data root');
  });

  test('sets the Electron path before startup only for packaged qualification', async () => {
    const root = await temporaryRoot();
    const setPath = jest.fn();
    expect(
      configurePackagedQualificationUserData(
        { isPackaged: true, setPath },
        { [PACKAGED_USER_DATA_ENV]: root }
      )
    ).toBe(await fs.promises.realpath(root));
    expect(setPath).toHaveBeenCalledWith('userData', await fs.promises.realpath(root));

    expect(configurePackagedQualificationUserData({ isPackaged: false, setPath }, {})).toBeNull();
    expect(setPath).toHaveBeenCalledTimes(1);
  });
});
