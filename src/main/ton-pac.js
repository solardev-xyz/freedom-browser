'use strict';

const { TON_SUFFIXES } = require('../shared/ton-suffixes');

function buildTonHostCondition(hostVariable = 'lower') {
  const suffixChecks = TON_SUFFIXES.map(
    (suffix) => `dnsDomainIs(${hostVariable}, ${JSON.stringify(suffix)})`
  ).join(' || ');
  return suffixChecks;
}

module.exports = { buildTonHostCondition };
