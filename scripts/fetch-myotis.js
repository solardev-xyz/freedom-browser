// Integration branch: release downloads cannot satisfy this source/hash pin.
console.error('Myotis integration downloads are disabled. Provision the exact pinned local Node addon, then use npm run myotis:activate -- --target <platform-arch> --file <absolute-local-file>. See docs/myotis-integration.md.');
process.exitCode = 1;
