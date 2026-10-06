'use strict';

// Separate Node-only key-admission campaign; never changes the wire recipe or default run.
const path = require('node:path');
const { need } = require('./fixtures/railgun-relay-wire/inputs');
const campaign = require('./fixtures/railgun-relay-keys/campaign');
async function main(argv) {
  const [command, ...rest] = argv;
  const fields = { check: ['build', 'build-sha256'], run: ['build', 'build-sha256', 'output'] }[
    command
  ];
  need(
    fields && rest.length === fields.length * 2,
    'Usage: check --build DIR --build-sha256 SHA | run --build DIR --build-sha256 SHA --output DIR'
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
  if (command === 'check') {
    campaign.verifyKeyBuild(path.resolve(options.build), options['build-sha256']);
    return { verified: true, generatedCryptoExecuted: false };
  }
  return campaign.run(path.resolve(options.build), options['build-sha256'], options.output);
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
