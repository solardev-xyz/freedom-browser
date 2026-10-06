// Explicit Node-only offline fixture CLI. No Electron app-entry behavior.
const path = require('node:path');
const { need, verifyBuild } = require('./fixtures/railgun-relay-wire/inputs');
async function main(argv) {
  const [command, ...rest] = argv;
  const fields = {
    prepare: ['roots', 'output'],
    check: ['build', 'build-sha256'],
    run: ['build', 'build-sha256', 'output'],
  }[command];
  need(
    fields && rest.length === fields.length * 2,
    'Usage: prepare --roots FILE --output DIR | check --build DIR --build-sha256 SHA | run --build DIR --build-sha256 SHA --output DIR'
  );
  const options = {};
  for (let index = 0; index < rest.length; index += 2) {
    const key = rest[index].slice(2);
    need(
      rest[index].startsWith('--') &&
        fields.includes(key) &&
        !Object.hasOwn(options, key) &&
        rest[index + 1],
      'Invalid or duplicate CLI option'
    );
    options[key] = rest[index + 1];
  }
  if (command === 'prepare')
    return require('./fixtures/railgun-relay-wire/prepare').prepare(options.roots, options.output);
  if (command === 'check') {
    verifyBuild(path.resolve(options.build), options['build-sha256']);
    return { verified: true, generatedCryptoExecuted: false };
  }
  return require('./fixtures/railgun-relay-wire/campaign').run(
    path.resolve(options.build),
    options['build-sha256'],
    options.output
  );
}
if (require.main === module)
  main(process.argv.slice(2)).then(
    (result) => console.log(JSON.stringify(result)),
    (error) => {
      console.error(error.message);
      process.exitCode = 1;
    }
  );
module.exports = { main };
