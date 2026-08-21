jest.mock('./ens-resolver', () => ({ resolveEnsContent: jest.fn() }));
jest.mock('./tezos-domains-resolver', () => ({ resolveTezosDomain: jest.fn() }));

const { resolveEnsContent } = require('./ens-resolver');
const { resolveTezosDomain } = require('./tezos-domains-resolver');
const {
  joinPublishedPath,
  nameSystemLabelForHost,
  resolveContentName,
} = require('./content-name-resolver');

describe('content name resolver', () => {
  test('dispatches .tez names without broadening ENS wallet classification', () => {
    resolveContentName('docs.example.tez');
    resolveContentName('vitalik.eth');

    expect(resolveTezosDomain).toHaveBeenCalledWith('docs.example.tez');
    expect(resolveEnsContent).toHaveBeenCalledWith('vitalik.eth');
    expect(nameSystemLabelForHost('docs.example.tez')).toBe('Tezos Domains');
  });

  test('preserves a published base path when appending a requested path', () => {
    expect(joinPublishedPath('/site', '/docs/index.html')).toBe('/site/docs/index.html');
    expect(joinPublishedPath('/site/', '/')).toBe('/site/');
    expect(joinPublishedPath('', '/docs')).toBe('/docs');
  });
});
