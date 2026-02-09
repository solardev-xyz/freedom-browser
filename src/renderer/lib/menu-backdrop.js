// Shared menu backdrop for catching clicks on drag regions
let backdrop = null;
let closeAllMenusCallback = null;

export const initMenuBackdrop = (closeAllMenus) => {
  backdrop = document.getElementById('menu-backdrop');
  closeAllMenusCallback = closeAllMenus;

  backdrop?.addEventListener('mousedown', () => {
    if (closeAllMenusCallback) {
      closeAllMenusCallback();
    }
  });
};

export const showMenuBackdrop = () => {
  backdrop?.classList.remove('hidden');
};

export const hideMenuBackdrop = () => {
  backdrop?.classList.add('hidden');
};
