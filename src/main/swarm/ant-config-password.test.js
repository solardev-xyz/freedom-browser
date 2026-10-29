/**
 * K-3: config.yaml's `password:` decoded as Ant's serde_yaml 0.9 reads it,
 * so a password moved into the keychain is the one Ant would have used.
 * Expected values follow the YAML spec's scalar rules (and agree with the
 * `yaml` package's YAML 1.1 parse of the same lines).
 */
const { readConfigPassword, yamlPasswordScalar } = require('./ant-config-password');

const BS = '\\';
const read = (line) => readConfigPassword(`api-addr: 127.0.0.1:1633\n${line}\ndata-dir: /x\n`);

describe('readConfigPassword', () => {
  test.each([
    ['password: 0a1b2c', '0a1b2c'],
    ['password: plain value with spaces', 'plain value with spaces'],
    ['password:   padded   ', 'padded'],
    ['password: value # comment', 'value'],
    ['password: value\t# tab comment', 'value'],
    ['password: hash#inside', 'hash#inside'],
    ['password: -dash-start', '-dash-start'],
    ['password: 12345', '12345'],
    ['password: true', 'true'],
    ['password: "double"', 'double'],
    ['password: "quoted" # trailing comment', 'quoted'],
    ['password: "a#b"', 'a#b'],
    ["password: 'single'", 'single'],
    ["password: 'it''s'", "it's"],
    ["password: 'single # not a comment'", 'single # not a comment'],
    [`password: 'no ${BS}n escapes'`, `no ${BS}n escapes`],
    [
      `password: "${BS}" ${BS}${BS} ${BS}t ${BS}n ${BS}x41 ${BS}u00e9 ${BS}U0001F600 ${BS}/ ${BS}e ${BS}N ${BS}_"`,
      '" \\ \t \n A é \u{1F600} / \u001b \u0085  ',
    ],
    ['password : spaced-key', 'spaced-key'],
  ])('%s decodes to the scalar Ant reads', (line, value) => {
    expect(read(line)).toEqual({ kind: 'value', value });
  });

  test.each(['password:', 'password: ~', 'password: null', 'password: NULL', 'password: # only a comment'])(
    '%s is no password',
    (line) => {
      expect(read(line)).toEqual({ kind: 'none' });
    }
  );

  test('a config without the key has no password', () => {
    expect(readConfigPassword('api-addr: 127.0.0.1:1633\n')).toEqual({ kind: 'none' });
  });

  test.each([
    'password: !!str tagged',
    'password: &anchor value',
    'password: *alias',
    'password: |',
    'password: >',
    'password: [a, b]',
    'password: {a: b}',
    'password: a: b',
    'password: "unterminated',
    "password: 'unterminated",
    'password: "abc"#no-space',
    'password: "abc" trailing',
    `password: "bad ${BS}q escape"`,
    `password: "surrogate ${BS}ud800"`,
    'password: ""',
    '"password": quoted-key',
    'password: a b',
  ])('%s is kept as a raw line', (line) => {
    expect(read(line)).toEqual({ kind: 'raw', line });
  });

  test('a value continued on the next line is kept raw', () => {
    expect(readConfigPassword('password: first\n  second\n')).toEqual({
      kind: 'raw',
      line: 'password: first',
    });
  });

  test('two password keys are kept raw', () => {
    expect(readConfigPassword('password: one\npassword: two\n')).toEqual({
      kind: 'raw',
      line: 'password: one',
    });
  });
});

describe('yamlPasswordScalar', () => {
  test.each([
    ['a'.repeat(64), 'a'.repeat(64)],
    ['keep-me', 'keep-me'],
    ['with space', '"with space"'],
    ['null', '"null"'],
    ['#hash', '"#hash"'],
    ['-dash', '"-dash"'],
    ['quote"in', '"quote\\"in"'],
    ['line sep', '"line\\Lsep"'],
  ])('%j is written as %s and read back unchanged', (value, scalar) => {
    expect(yamlPasswordScalar(value)).toBe(scalar);
    expect(readConfigPassword(`password: ${scalar}\n`)).toEqual({ kind: 'value', value });
  });
});
