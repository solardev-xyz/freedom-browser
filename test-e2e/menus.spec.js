// Hamburger and Nodes menus — dismissal.
//
// #306: Escape is how every other dismissible surface in the chrome closes
// (tab and page context menus, the bookmark menu, the trust popover, the
// permission prompt, the find bar). These two did not close on it at all, and
// they raise `#menu-backdrop` over the whole window — so the only way out was
// the mouse. Chrome closes the open menu on Escape, innermost submenu first,
// and gives the keyboard back to the button that opened it.

const { test, expect } = require('./fixtures');

const menuState = (window) =>
  window.evaluate(() => ({
    hamburger: document.getElementById('menu-dropdown')?.classList.contains('open') === true,
    nodes: document.getElementById('bee-menu-dropdown')?.classList.contains('open') === true,
    flyout: document.getElementById('profile-menu')?.hidden === false,
    backdrop: document.getElementById('menu-backdrop')?.classList.contains('hidden') === false,
    focused: document.activeElement?.id || '',
  }));

test('Escape closes the hamburger menu and returns focus to its button', async ({ window }) => {
  await window.locator('#menu-button').click();
  await expect.poll(() => menuState(window)).toMatchObject({ hamburger: true, backdrop: true });

  await window.keyboard.press('Escape');

  await expect
    .poll(() => menuState(window))
    .toMatchObject({ hamburger: false, backdrop: false, focused: 'menu-button' });
});

test('Escape closes the Nodes menu and returns focus to its button', async ({ window }) => {
  await window.locator('#bee-menu-button').click();
  await expect.poll(() => menuState(window)).toMatchObject({ nodes: true, backdrop: true });

  await window.keyboard.press('Escape');

  await expect
    .poll(() => menuState(window))
    .toMatchObject({ nodes: false, backdrop: false, focused: 'bee-menu-button' });
});

test('Escape closes the Profiles flyout first, the hamburger on the second press', async ({
  window,
}) => {
  await window.locator('#menu-button').click();
  await expect.poll(() => menuState(window)).toMatchObject({ hamburger: true });

  // A click on the Profiles row opens the flyout immediately (the hover delay
  // is for the pointer path).
  await window.locator('#profile-menu-btn').click();
  await expect.poll(() => menuState(window)).toMatchObject({ hamburger: true, flyout: true });

  await window.keyboard.press('Escape');
  await expect
    .poll(() => menuState(window))
    .toMatchObject({ flyout: false, hamburger: true, focused: 'profile-menu-btn' });

  await window.keyboard.press('Escape');
  await expect
    .poll(() => menuState(window))
    .toMatchObject({ hamburger: false, backdrop: false, focused: 'menu-button' });
});

test('the backdrop stops swallowing clicks once Escape has closed the menu', async ({ window }) => {
  await window.locator('#menu-button').click();
  await expect.poll(() => menuState(window)).toMatchObject({ hamburger: true, backdrop: true });

  await window.keyboard.press('Escape');
  await expect.poll(() => menuState(window)).toMatchObject({ backdrop: false });

  // With the backdrop up this click would land on it instead of the address
  // bar — the concrete cost of a menu with no keyboard way out.
  await window.locator('[data-test="address-input"]').click();
  await expect(window.locator('[data-test="address-input"]')).toBeFocused();
});
