'use strict';

const packageMetadata = require('../package.json');
const electronBuilderSchema = require('app-builder-lib/scheme.json');
const qualificationBuild = require('./electron-builder.agent-sandbox-linux');

const electronBuilderDefaults =
  electronBuilderSchema.definitions.DebOptions.properties.depends.default;
const EXPECTED_DEBIAN_RUNTIME_DEPENDENCIES = Object.freeze([
  ...electronBuilderDefaults,
  'bubblewrap',
]);

describe('Linux Debian package configuration', () => {
  test('materializes the pinned Electron runtime during a clean project install', () => {
    expect(packageMetadata.scripts.postinstall).toBe(
      'install-electron && electron-builder install-app-deps'
    );
  });

  test('retains Electron Builder runtime defaults and requires Bubblewrap', () => {
    expect(packageMetadata.build.deb.depends).toEqual(EXPECTED_DEBIAN_RUNTIME_DEPENDENCIES);
    expect(new Set(packageMetadata.build.deb.depends).size).toBe(
      packageMetadata.build.deb.depends.length
    );
  });

  test('uses the product Debian dependencies in the sandbox qualification package', () => {
    expect(qualificationBuild.deb.depends).toEqual(EXPECTED_DEBIAN_RUNTIME_DEPENDENCIES);
  });
});
