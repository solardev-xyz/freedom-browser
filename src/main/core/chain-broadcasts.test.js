const { BroadcastRecords } = require('./chain-broadcasts');

const RAW = '0xF86B80aa';

describe("main's broadcast record", () => {
  test('a send of its bytes on its chain marks it, in any hex case; another chain or bytes do not', () => {
    const records = new BroadcastRecords();
    const record = records.begin(100, RAW);
    const twin = records.begin(100, RAW.toLowerCase());
    const other = records.begin(1, RAW);
    records.sending(100, '0xf86b80bb', 'direct');
    expect(record.sent).toBe(false);
    records.sending(100, RAW.toLowerCase(), 'myotis');
    // Every open record of those bytes: whichever broadcast it was for.
    expect(record).toMatchObject({ sent: true, source: 'myotis' });
    expect(twin.sent).toBe(true);
    expect(other.sent).toBe(false);
    records.end(record);
    expect(records.open.has(record)).toBe(false);
  });

  test('an exchange marks only when it sends the bytes: its body read only then', () => {
    const records = new BroadcastRecords();
    const parse = jest.spyOn(JSON, 'parse');
    records.exchanging(
      1,
      '{"jsonrpc":"2.0","id":1,"method":"eth_sendRawTransaction","params":["0xaa"]}'
    );
    // Nothing open: nothing read.
    expect(parse).not.toHaveBeenCalled();
    const record = records.begin(1, '0xaa');
    records.exchanging(
      1,
      '{"jsonrpc":"2.0","id":1,"method":"eth_call","params":[{"data":"0xaa"}]}'
    );
    expect(parse).not.toHaveBeenCalled();
    records.exchanging(
      1,
      '{"method":"eth_call","note":"eth_sendRawTransaction","params":["0xaa"]}'
    );
    records.exchanging(1, 'not json "eth_sendRawTransaction"');
    records.exchanging(1, '{"method":"eth_sendRawTransaction","params":"0xaa"}');
    expect(record.sent).toBe(false);
    records.exchanging(
      1,
      '{"jsonrpc":"2.0","id":1,"method":"eth_sendRawTransaction","params":["0xAA"]}'
    );
    expect(record).toMatchObject({ sent: true, source: 'direct' });
    parse.mockRestore();
  });

  test('bytes that are not text are never marked', () => {
    const records = new BroadcastRecords();
    const record = records.begin(1, 42);
    records.sending(1, 42, 'myotis');
    records.sending(1, null, 'myotis');
    expect(record.sent).toBe(false);
  });
});
