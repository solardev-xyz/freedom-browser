const { thirdPartyCookiesView, renderThirdPartyCookies } = require('./settings-cookies');

describe('Settings → Cookies (#474)', () => {
  test('the toggle shows the stored choice, blocked unless it is false', () => {
    expect(thirdPartyCookiesView({ blockThirdPartyCookies: true }, true).checked).toBe(true);
    expect(thirdPartyCookiesView({ blockThirdPartyCookies: false }, false).checked).toBe(false);
    expect(thirdPartyCookiesView({}, true).checked).toBe(true);
  });

  test('Restart now shows only while the stored choice and this launch differ', () => {
    const view = (blocked, atLaunch) =>
      thirdPartyCookiesView({ blockThirdPartyCookies: blocked }, atLaunch).restartVisible;
    expect(view(true, true)).toBe(false);
    expect(view(false, false)).toBe(false);
    expect(view(false, true)).toBe(true);
    expect(view(true, false)).toBe(true);
    // Unknown launch state: no restart offered on a guess.
    expect(view(false, null)).toBe(false);
  });

  test('render sets the toggle and the restart button', () => {
    const els = { toggle: { checked: true }, restart: { hidden: true } };
    renderThirdPartyCookies(els, { checked: false, restartVisible: true });
    expect(els).toEqual({ toggle: { checked: false }, restart: { hidden: false } });
  });
});
