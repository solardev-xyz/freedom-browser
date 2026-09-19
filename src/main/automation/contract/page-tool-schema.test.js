'use strict';
const { supportedPageToolSchema, matchesPageToolArguments } = require('./page-tool-schema');

test('validates required properties, exact types, enums and additional properties without coercion', () => {
  const schema = {
    type: 'object',
    properties: {
      count: { type: 'integer', minimum: 1, maximum: 5 },
      kind: { enum: ['small', 'large'] },
      tags: { type: 'array', items: { type: 'string', minLength: 1 }, uniqueItems: true },
    },
    required: ['count', 'kind'],
    additionalProperties: false,
  };
  expect(matchesPageToolArguments(schema, { count: 2, kind: 'small', tags: ['one'] })).toBe(true);
  for (const value of [
    { count: '2', kind: 'small' },
    { count: 0, kind: 'small' },
    { count: 1, kind: 'medium' },
    { count: 1 },
    { count: 1, kind: 'large', surprise: true },
    { count: 1, kind: 'small', tags: ['a', 'a'] },
  ])
    expect(matchesPageToolArguments(schema, value)).toBe(false);
});

test('supports bounded unions and compares enum objects independently of property order', () => {
  expect(matchesPageToolArguments({ oneOf: [{ type: 'string' }, { type: 'null' }] }, null)).toBe(
    true
  );
  expect(matchesPageToolArguments({ oneOf: [{ type: 'number' }, { type: 'integer' }] }, 1)).toBe(
    false
  );
  expect(matchesPageToolArguments({ enum: [{ a: 1, b: 2 }] }, { b: 2, a: 1 })).toBe(true);
  expect(matchesPageToolArguments({ allOf: [{ minimum: 2 }, { maximum: 4 }] }, 5)).toBe(false);
  expect(matchesPageToolArguments({ not: { const: 3 } }, 3)).toBe(false);
});

test('unsupported constraints, regexes and remote references never silently pass', () => {
  for (const schema of [
    { $ref: 'https://attacker.test/schema' },
    { pattern: '(a+)+$' },
    { properties: { nested: { patternProperties: {} } } },
    { unknownConstraint: true },
    { items: [] },
    { anyOf: [] },
    { minimum: '0' },
  ]) {
    expect(supportedPageToolSchema(schema)).toBe(false);
    expect(matchesPageToolArguments(schema, {})).toBe(false);
  }
});

test('bounds nested schemas, arguments and validation work', () => {
  let deep = {};
  for (let i = 0; i < 40; i++) deep = { child: deep };
  expect(supportedPageToolSchema({ default: deep })).toBe(false);
  expect(matchesPageToolArguments({}, deep)).toBe(false);
  expect(matchesPageToolArguments({ type: 'string', maxLength: 1 }, '😀')).toBe(true);
});

test('supports fixed-width codes while refusing regex backtracking and unsupported syntax', () => {
  const schema = { type: 'string', pattern: '^[A-Z]{3}$' };
  expect(matchesPageToolArguments(schema, 'LHR')).toBe(true);
  expect(matchesPageToolArguments(schema, 'lhr')).toBe(false);
  expect(matchesPageToolArguments(schema, 'XLHR')).toBe(false);
  expect(matchesPageToolArguments({ pattern: '^\\d{4}-\\d{2}-\\d{2}$' }, '2026-09-18')).toBe(true);
  for (const pattern of [
    '^(a+)+$',
    '^a{1,64}a{1,64}$',
    '^(a)\\1$',
    '^a*$',
    '^a|b$',
    '^[z-a]$',
    '^a{999}$',
  ])
    expect(supportedPageToolSchema({ pattern })).toBe(false);
});
