// Settings → Privacy and security → Cookies (#474). "Block third-party
// cookies" saves on change, as every Settings row does, but main applies it
// through a Chromium switch read once at launch (src/main/third-party-
// cookies.js). So the row offers "Restart now" while the stored choice and
// this launch disagree, and hides it again when they agree.
//
// Classic page script, loaded after settings.js. The helpers are also
// exported for Jest (settings-cookies.test.js); in the page `module` is
// undefined and only the IIFE at the bottom runs.

/**
 * @param {object|null} settings the stored settings
 * @param {boolean|null} blockedAtLaunch what this launch applied; null when
 *   main can't say, which never offers a restart it can't justify
 */
function thirdPartyCookiesView(settings, blockedAtLaunch) {
  const blocked = settings?.blockThirdPartyCookies !== false;
  return {
    checked: blocked,
    restartVisible: typeof blockedAtLaunch === 'boolean' && blockedAtLaunch !== blocked,
  };
}

function renderThirdPartyCookies(els, view) {
  els.toggle.checked = view.checked;
  els.restart.hidden = !view.restartVisible;
}

if (typeof module === 'object' && module.exports) {
  module.exports = { thirdPartyCookiesView, renderThirdPartyCookies };
} else {
  (() => {
    const els = {
      toggle: document.getElementById('block-third-party-cookies'),
      restart: document.getElementById('third-party-cookies-restart'),
    };
    if (!els.toggle || !els.restart) return;

    let stored = null;
    let blockedAtLaunch = null;
    const paint = () => {
      if (stored) renderThirdPartyCookies(els, thirdPartyCookiesView(stored, blockedAtLaunch));
    };

    els.toggle.addEventListener('change', async () => {
      try {
        await freedomAPI.saveSettings({ blockThirdPartyCookies: els.toggle.checked });
        // Read back what main kept; an unchanged save broadcasts nothing.
        stored = await freedomAPI.getSettings();
      } catch (err) {
        console.error('[settings] could not save the third-party cookie setting:', err);
      }
      paint();
    });
    els.restart.addEventListener('click', () => freedomAPI.relaunchApp());

    freedomAPI.onSettingsUpdated?.((settings) => {
      if (!settings) return;
      stored = settings;
      paint();
    });

    freedomAPI
      .getThirdPartyCookiesLaunchState?.()
      .then((state) => {
        blockedAtLaunch =
          typeof state?.blockedAtLaunch === 'boolean' ? state.blockedAtLaunch : null;
        paint();
      })
      .catch(() => {});
    freedomAPI
      .getSettings()
      .then((settings) => {
        // A broadcast that landed while this was in flight is newer.
        if (!stored) stored = settings;
        paint();
      })
      .catch((err) =>
        console.error('[settings] could not read the third-party cookie setting:', err)
      );
  })();
}
