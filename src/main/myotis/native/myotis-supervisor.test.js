const fs = require('fs');
const path = require('path');

// The supervisors are C, so this guards their receipt contract at the source:
// main (myotis-process.js) only accepts a terminal `reaped` receipt from a
// generation that already reported `owned`, and only then treats the data
// directory as reusable. A supervisor that withholds `owned` because control
// was revoked while it was still starting the child therefore quarantines a
// directory it went on to retire cleanly, with OS exit 0 and a durable
// `v1 retired` record. Ownership exists from the fork/create onwards, so the
// receipt must not be conditional on revocation on either platform.
const SUPERVISORS = [
  { name: 'myotis-supervisor.c', report: 'STDOUT_FILENO' },
  { name: 'myotis-supervisor-win.c', report: 'report' },
];

function source(name) {
  return fs.readFileSync(path.join(__dirname, name), 'utf8');
}

// The write statement that reports one receipt type: from the end of the
// snprintf that formats it up to the end of the following write_all call.
function reportStatement(text, type) {
  const format = text.indexOf(`type\\":\\"${type}\\"`);
  expect(format).toBeGreaterThan(-1);
  const start = text.indexOf(';', format);
  const write = text.indexOf('write_all', start);
  expect(write).toBeGreaterThan(-1);
  return { start, statement: text.slice(start + 1, text.indexOf(';', write) + 1) };
}

describe.each(SUPERVISORS)('$name receipt reporting', ({ name, report }) => {
  test('reports ownership unconditionally once the child exists', () => {
    const { statement } = reportStatement(source(name), 'owned');
    expect(statement).toContain(`write_all(${report}, receipt`);
    // A revocation observed in the start window may still terminate the child,
    // but it must not suppress the receipt that attributes the terminal one.
    // Recording a failed report as a termination reason is the only use here.
    expect(statement.replace(/terminate = 1/g, 'reported-failure')).not.toMatch(/terminate/);
  });

  test('reports the terminal receipt after ownership and durable retirement', () => {
    const text = source(name);
    const owned = reportStatement(text, 'owned');
    const reaped = reportStatement(text, 'reaped');
    expect(reaped.start).toBeGreaterThan(owned.start);
    expect(reaped.statement).toContain(`write_all(${report}, receipt`);
    const retirement = text.search(/record\(owner, "retired", generation\)/);
    expect(retirement).toBeGreaterThan(owned.start);
    expect(retirement).toBeLessThan(reaped.start);
  });
});
