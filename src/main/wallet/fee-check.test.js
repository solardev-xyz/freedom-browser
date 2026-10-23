/**
 * The fee check at confirmation (freedom-core design 0005, A): R from the
 * core's `chain.fee_reference`, the threshold, the ages, and the evidence
 * gathered again. Main's tests for A, on a fake clock: the clocks are the
 * check's own parameters.
 */

const {
  FEE_CHECK_MULTIPLE,
  EVIDENCE_MAX_AGE_MS,
  EVIDENCE_DEADLINE_MS,
  FEE_CHECK_ASK_AGAIN,
  FeeChecks,
  readEvidence,
  referenceFee,
  judgeFees,
  feeCheckError,
} = require('./fee-check');

const GWEI = 1_000_000_000n;
const gwei = (n) => (BigInt(n) * GWEI).toString();
// Main's wall clock when the evidence is judged, and a header made then.
const NOW_MS = 1_700_000_000_000;
const NOW_S = String(NOW_MS / 1000);

const header = (baseFee, timestamp = NOW_S) => ({
  source: 'colibri',
  number: '20000000',
  timestamp,
  base_fee: baseFee,
});
const quote = (fields, answered = 2) => ({
  ...fields,
  source: 'direct',
  verified: false,
  answered,
});
const legacyQuote = (gasPrice, answered) =>
  quote({ type: 'legacy', gasPrice, effectiveGasPrice: gasPrice }, answered);
const eip1559Quote = (maxFeePerGas, maxPriorityFeePerGas, answered) =>
  quote(
    {
      type: 'eip1559',
      baseFee: '0',
      maxPriorityFeePerGas,
      maxFeePerGas,
      effectiveGasPrice: maxFeePerGas,
    },
    answered
  );
const reply = ({ base = null, priority = null, combined = null, timestamp } = {}) => ({
  header: base === null ? null : header(base, timestamp),
  lowest_priority: priority,
  quote: combined,
});

/** R judged at `at` (wall ms) and `aged` ms after the request started. */
function reference(evidenceReply, { at = NOW_MS, aged = 1_000 } = {}) {
  return referenceFee(readEvidence(evidenceReply, 0), { wallNow: at, monotonicNow: aged });
}

const send = (fees, gasLimit = '21000') => ({ chainId: 1, gasLimit, ...fees });

describe('R, the reference fee', () => {
  test('verified: 2·B plus the lowest priority fee of B’s quotes, from a fresh header', () => {
    expect(
      reference(reply({ base: gwei(10), priority: gwei(1), combined: legacyQuote(gwei(30)) }))
    ).toEqual({ fee: 21n * GWEI, basis: 'header', oneEndpoint: false });
  });

  test("all of B's quotes legacy on an EIP-1559 chain: R is 2·B", () => {
    expect(
      reference(reply({ base: gwei(10), priority: null, combined: legacyQuote(gwei(30)) }))
    ).toEqual({ fee: 20n * GWEI, basis: 'header', oneEndpoint: false });
  });

  test("a legacy chain: no base fee, so the combined quote's gas price", () => {
    const evidence = { header: header(null), lowest_priority: null, quote: legacyQuote(gwei(7)) };
    expect(reference(evidence)).toEqual({ fee: 7n * GWEI, basis: 'quote', oneEndpoint: false });
    // An EIP-1559 combined quote gives its maxFeePerGas.
    expect(reference(reply({ combined: eip1559Quote(gwei(19), gwei(1)) }))).toEqual({
      fee: 19n * GWEI,
      basis: 'quote',
      oneEndpoint: false,
    });
  });

  test('a header 61 s old or 61 s ahead is stale; 60 s either way is fresh', () => {
    const at = (offset) =>
      reference(reply({ base: gwei(10), priority: gwei(1), combined: legacyQuote(gwei(30)) }), {
        at: NOW_MS + offset,
      });
    expect(at(60_000).basis).toBe('header');
    expect(at(-60_000).basis).toBe('header');
    // Stale: the combined quote, while it is at most 60 s old.
    expect(at(61_000)).toEqual({ fee: 30n * GWEI, basis: 'quote', oneEndpoint: false });
    expect(at(-61_000)).toEqual({ fee: 30n * GWEI, basis: 'quote', oneEndpoint: false });
    // Without B's quote: no reference.
    const alone = (offset) =>
      reference(reply({ base: gwei(10), priority: gwei(1) }), { at: NOW_MS + offset });
    expect(alone(61_000)).toBeNull();
    expect(alone(-61_000)).toBeNull();
  });

  test('an unavailable header falls back to the combined quote, or to none', () => {
    expect(reference(reply({ combined: legacyQuote(gwei(5)) })).basis).toBe('quote');
    expect(reference(reply())).toBeNull();
    // A part main can't read counts as one that failed.
    for (const odd of [
      { ...header(gwei(10)), source: 'myotis' },
      { ...header(gwei(10)), base_fee: '0x7' },
      { ...header(gwei(10)), timestamp: '-1' },
      { ...header(gwei(10)), number: 7 },
      'header',
    ]) {
      expect(reference({ header: odd, lowest_priority: null, quote: null })).toBeNull();
    }
  });

  test("a quote's derived baseFee is never taken for a header's", () => {
    // Colibri down: a Myotis fee quote's baseFee (gas price − priority) is
    // no verified base fee. R is B's combined quote, or none.
    const myotisQuote = {
      type: 'eip1559',
      baseFee: gwei(5),
      maxPriorityFeePerGas: gwei(1),
      maxFeePerGas: gwei(11),
      effectiveGasPrice: gwei(6),
      source: 'myotis',
      verified: true,
    };
    // B's combined quote is the only evidence that counts.
    expect(reference(reply({ combined: eip1559Quote(gwei(13), gwei(1)) }))).toEqual({
      fee: 13n * GWEI,
      basis: 'quote',
      oneEndpoint: false,
    });
    // A quote from another source (as a fee quote's) is no evidence at all.
    expect(reference({ header: null, lowest_priority: null, quote: myotisQuote })).toBeNull();
    expect(judgeFees(send(myotisQuote), reference(reply())).comparable).toBe(false);
  });

  test("the combined quote's age counts from its request's start", () => {
    const evidence = reply({ combined: legacyQuote(gwei(5)) });
    expect(reference(evidence, { aged: 60_000 }).basis).toBe('quote');
    // 61 s after the request started there is no combined-quote reference,
    // however recently the reply arrived (a header that failed, or came
    // back stale, at 60 s).
    expect(reference(evidence, { aged: 61_000 })).toBeNull();
    expect(
      reference(reply({ base: gwei(10), combined: legacyQuote(gwei(5)), timestamp: '1' }), {
        aged: 61_000,
      })
    ).toBeNull();
  });

  test('R of 0 is no reference', () => {
    expect(reference(reply({ base: '0', priority: null }))).toBeNull();
    expect(reference(reply({ combined: legacyQuote('0') }))).toBeNull();
    // A base fee of 0 with a priority fee is a reference.
    expect(reference(reply({ base: '0', priority: '1' })).fee).toBe(1n);
  });

  test("one endpoint's quote is marked as such", () => {
    expect(reference(reply({ combined: legacyQuote(gwei(5), 1) }))).toEqual({
      fee: 5n * GWEI,
      basis: 'quote',
      oneEndpoint: true,
    });
    // A verified header's reference isn't one endpoint's quote.
    expect(
      reference(reply({ base: gwei(5), priority: gwei(1), combined: legacyQuote(gwei(5), 1) }))
        .oneEndpoint
    ).toBe(false);
  });
});

describe('judging a send', () => {
  // R = 2·10 + 1 = 21 gwei, from a verified header.
  const R = reference(
    reply({ base: gwei(10), priority: gwei(1), combined: legacyQuote(gwei(30)) })
  );

  test('every fee, whatever set it, is judged against the same R', () => {
    const judged = (fees) => judgeFees(send(fees), R);
    const cases = [
      // A Myotis, a Colibri, a quorum and a Direct (B) quote.
      [{ maxFeePerGas: gwei(25), maxPriorityFeePerGas: gwei(2) }, '1.2', false],
      [{ gasPrice: gwei(20) }, '1', false],
      [{ maxFeePerGas: gwei(31), maxPriorityFeePerGas: gwei(1) }, '1.5', false],
      [{ maxFeePerGas: gwei(21), maxPriorityFeePerGas: gwei(1) }, '1', false],
      // A dApp's EIP-1559 and legacy fields, far above.
      [{ maxFeePerGas: gwei(420), maxPriorityFeePerGas: gwei(400) }, '20', true],
      [{ gasPrice: gwei(64) }, '3', true],
      // A replacement's raised fees.
      [{ maxFeePerGas: '23100000000', maxPriorityFeePerGas: '1100000000' }, '1.1', false],
    ];
    for (const [fees, ratio, above] of cases) {
      expect(judged(fees)).toMatchObject({ comparable: true, ratio, above, autoApprove: !above });
    }
    // The fee per gas is the max fee when both EIP-1559 fields are set, the
    // gas price otherwise.
    expect(judged({ maxFeePerGas: gwei(420), gasPrice: gwei(1) }).ratio).toBe('0');
  });

  test('the threshold: at 3·R the send passes; one wei above, it is asked again', () => {
    const at = (fee) => judgeFees(send({ gasPrice: fee.toString() }), R);
    expect(FEE_CHECK_MULTIPLE).toBe(3n);
    expect(at(3n * R.fee)).toMatchObject({ above: false, autoApprove: true, ratio: '3' });
    expect(at(3n * R.fee + 1n)).toMatchObject({ above: true, autoApprove: false, ratio: '3' });
  });

  test('the most a send can cost: its gas limit times its max fee, or gas price', () => {
    expect(judgeFees(send({ gasPrice: gwei(20) }, '50000'), R).maxCost).toBe(
      (50_000n * 20n * GWEI).toString()
    );
    expect(
      judgeFees(send({ maxFeePerGas: gwei(30), maxPriorityFeePerGas: gwei(2) }), R).maxCost
    ).toBe((21_000n * 30n * GWEI).toString());
  });

  test('no reference: the most shown, "couldn\'t compare", never auto-approved', () => {
    for (const none of [null, reference(reply({ base: '0' }))]) {
      expect(judgeFees(send({ gasPrice: gwei(20) }), none)).toEqual({
        maxCost: (21_000n * 20n * GWEI).toString(),
        comparable: false,
        ratio: null,
        above: false,
        oneEndpoint: false,
        basis: null,
        autoApprove: false,
      });
    }
  });

  test("one endpoint's reference: the ratio shown, above asked again, below not auto-approved", () => {
    const one = reference(reply({ combined: legacyQuote(gwei(10), 1) }));
    expect(judgeFees(send({ gasPrice: gwei(10) }), one)).toMatchObject({
      comparable: true,
      ratio: '1',
      above: false,
      oneEndpoint: true,
      autoApprove: false,
    });
    expect(judgeFees(send({ gasPrice: gwei(40) }), one)).toMatchObject({
      ratio: '4',
      above: true,
      autoApprove: false,
    });
  });

  test('the mixed boundary case without a verified header is shown, not flagged', () => {
    // An honest EIP-1559 100/1 (M = 199) and a legacy 1000 combine, without a
    // verified header, to legacy at 100: R = 100.
    const mixed = reference(reply({ combined: legacyQuote('100') }));
    expect(judgeFees(send({ gasPrice: '100' }), mixed)).toMatchObject({
      ratio: '1',
      above: false,
      autoApprove: true,
    });
    expect(
      judgeFees(send({ maxFeePerGas: '199', maxPriorityFeePerGas: '1' }), mixed)
    ).toMatchObject({ ratio: '2', above: false, autoApprove: true });
  });

  test('ratios are named to one decimal, whole from 10', () => {
    const ratio = (fee) =>
      judgeFees(send({ gasPrice: fee }), { fee: 100n, oneEndpoint: false }).ratio;
    expect([ratio('100'), ratio('149'), ratio('2000'), ratio('1049'), ratio('5')]).toEqual([
      '1',
      '1.5',
      '20',
      '10',
      '0.1',
    ]);
  });

  test("a send without a gas limit or fee can't be compared", () => {
    expect(judgeFees({ chainId: 1, gasLimit: '21000' }, R)).toMatchObject({
      maxCost: null,
      comparable: false,
      autoApprove: false,
    });
    expect(judgeFees({ chainId: 1, gasPrice: gwei(1) }, R)).toMatchObject({
      maxCost: null,
      comparable: true,
    });
  });
});

describe('the evidence, kept and gathered again', () => {
  let wall;
  let mono;
  let fetch;
  let checks;

  beforeEach(() => {
    wall = NOW_MS;
    mono = 0;
    fetch = jest.fn(async () => reply({ base: gwei(10), priority: gwei(1) }));
    checks = new FeeChecks({
      fetch,
      wallClock: () => wall,
      monotonic: () => mono,
      log: { warn: jest.fn(), info: jest.fn() },
    });
  });

  const later = (ms) => {
    wall += ms;
    mono += ms;
  };

  test('one request per chain while it is at most 60 s old, within a bounded deadline', async () => {
    await checks.check(send({ gasPrice: gwei(20) }));
    later(EVIDENCE_MAX_AGE_MS);
    // Reused for a later approval, and for another transaction.
    await checks.atApproval(send({ gasPrice: gwei(20) }));
    await checks.check(send({ gasPrice: gwei(5) }));
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith(1, { deadlineMs: EVIDENCE_DEADLINE_MS });
    // Another chain has its own.
    await checks.check({ ...send({ gasPrice: gwei(20) }), chainId: 100 });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  test("evidence 61 s old is gathered again; reused evidence keeps its request's age", async () => {
    // The header fails; B's quote is fast. The reply is used 61 s after its
    // request started: no combined-quote reference, though the reply came
    // late. The check never judges by evidence older than 60 s: it asks
    // again.
    let answer;
    fetch.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          answer = resolve;
        })
    );
    const pending = checks.check(send({ gasPrice: gwei(20) }));
    later(60_000);
    answer(reply({ combined: legacyQuote(gwei(10)) }));
    later(1_000);
    await expect(pending).resolves.toMatchObject({ comparable: false, autoApprove: false });
    // A later approval, or another transaction, gathers again.
    fetch.mockResolvedValueOnce(reply({ combined: legacyQuote(gwei(10)) }));
    await expect(checks.atApproval(send({ gasPrice: gwei(20) }))).resolves.toMatchObject({
      comparable: true,
      ratio: '2',
      basis: 'quote',
    });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  test('a base-fee spike before signing: gathered again, asked again only when newly above', async () => {
    const tx = send({ maxFeePerGas: gwei(50), maxPriorityFeePerGas: gwei(2) });
    // Shown against R = 21 gwei: 2.4×, below.
    await expect(checks.check(tx)).resolves.toMatchObject({ ratio: '2.4', above: false });
    later(61_000);
    // The base fee rose: R rises with it, and the send is still below.
    fetch.mockResolvedValueOnce(
      reply({ base: gwei(40), priority: gwei(1), timestamp: String(wall / 1000) })
    );
    await expect(checks.atApproval(tx)).resolves.toMatchObject({
      ratio: '0.6',
      above: false,
      askAgain: false,
    });
    expect(fetch).toHaveBeenCalledTimes(2);
    later(61_000);
    // It fell: the same send is now above. The user is asked again.
    fetch.mockResolvedValue(
      reply({ base: gwei(2), priority: gwei(1), timestamp: String(wall / 1000) })
    );
    await expect(checks.atApproval(tx)).resolves.toMatchObject({
      ratio: '10',
      above: true,
      askAgain: true,
    });
    // Once confirmed again, the same verdict doesn't ask a third time.
    await expect(checks.atApproval(tx, { acknowledged: true })).resolves.toMatchObject({
      above: true,
      askAgain: false,
    });
  });

  test('a failed request is not kept: the next check asks again', async () => {
    fetch.mockRejectedValueOnce(new Error('Unknown method'));
    await expect(checks.check(send({ gasPrice: gwei(20) }))).resolves.toMatchObject({
      comparable: false,
      autoApprove: false,
    });
    await expect(checks.check(send({ gasPrice: gwei(20) }))).resolves.toMatchObject({
      comparable: true,
    });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  test('a wrong clock makes every header stale: R falls back to the combined quote', async () => {
    wall = NOW_MS + 3_600_000;
    fetch.mockResolvedValue(
      reply({ base: gwei(10), priority: gwei(1), combined: legacyQuote(gwei(30)) })
    );
    await expect(checks.check(send({ gasPrice: gwei(30) }))).resolves.toMatchObject({
      basis: 'quote',
      ratio: '1',
    });
  });

  test('no chain ID: nothing asked, nothing compared', async () => {
    await expect(checks.check({ gasLimit: '21000', gasPrice: '1' })).resolves.toMatchObject({
      comparable: false,
    });
    expect(fetch).not.toHaveBeenCalled();
  });
});

test("a refusal names the ratio and carries main's verdict", () => {
  const verdict = { ratio: '20', above: true };
  const error = feeCheckError(FEE_CHECK_ASK_AGAIN, verdict);
  expect(error).toMatchObject({ code: FEE_CHECK_ASK_AGAIN, feeCheck: verdict });
  expect(error.message).toBe(
    "The network fee is 20× today's network fee. Confirm it again to send."
  );
});
