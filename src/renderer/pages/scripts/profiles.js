const managerList = document.getElementById('profile-manager-list');
const statsEl = document.getElementById('stats');
const deleteModal = document.getElementById('delete-modal');
const profileToast = document.getElementById('profile-toast');

// Header count line, like history's "N entries" and downloads'
// "N downloads" (#256). Counts the cards actually on screen.
const setStats = (text) => {
  if (statsEl) statsEl.textContent = text;
};

const esc = (s) =>
  String(s == null ? '' : s).replace(
    /[&<>"]/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]
  );

const logError = (message, err) => {
  console.error('[profiles] ' + message, err || '');
};

// Surface action failures (delete/open/register/edit) as a brief toast so
// they aren't silent — e.g. an optimistic-delete failure that restores the
// card now also says why. Auto-dismisses; passing no message hides it.
let toastTimer = null;
const STATUS_TIMEOUT_MS = 6000;
const showStatus = (message, kind = 'error') => {
  if (!profileToast) return;
  profileToast.textContent = message || '';
  profileToast.className = 'profile-toast' + (kind ? ' ' + kind : '');
  profileToast.hidden = !message;
  clearTimeout(toastTimer);
  if (message) {
    toastTimer = setTimeout(() => {
      profileToast.hidden = true;
    }, STATUS_TIMEOUT_MS);
  }
};

// Hover tooltip for clipped names comes from the shared
// scripts/hover-tooltip.js loaded above (window.bindHoverTooltip /
// window.hideHoverTooltip).
const { bindHoverTooltip, hideHoverTooltip } = window;

// --- Avatar ------------------------------------------------------------
// Every profile uses the same generic icon on a single flat colour; cards
// are told apart by their name, not their avatar.
const AVATAR = { bg: '#2b303a', fg: '#c3ccd9' };
const AVATAR_ICON = '<path d="M20 21a8 8 0 0 0-16 0"/><circle cx="12" cy="7" r="4"/>';

const avatarSvg = () => `
    <svg class="avatar-svg" viewBox="0 0 100 100" preserveAspectRatio="xMidYMid slice" xmlns="http://www.w3.org/2000/svg">
      <rect width="100" height="100" fill="${AVATAR.bg}"/>
      <g transform="translate(30 30) scale(1.6667)" fill="none" stroke="${AVATAR.fg}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">${AVATAR_ICON}</g>
    </svg>`;

// --- Card icons --------------------------------------------------------
const PENCIL_ICON =
  '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z"/></svg>';
const TRASH_ICON =
  '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>';

const renderProfiles = (profiles) => {
  if (!managerList) return;

  const createTile = `
    <button type="button" class="create-tile" data-create-profile>
      <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>
      Create a profile
    </button>`;

  if (!profiles?.length) {
    setStats('0 profiles');
    managerList.innerHTML =
      '<div class="profile-manager-empty">No profiles found</div>' + createTile;
    return;
  }

  // Hide any profile whose optimistic delete is still in flight: an
  // unrelated onProfileUpdated refresh can fire before the deletion
  // lands in the registry, and we don't want it to briefly re-render
  // the card the user just removed. The delete path clears the id on
  // completion (or failure, followed by a refresh that restores it).
  const shown = profiles.filter((profile) => !pendingDeleteIds.has(profile.id));
  setStats(`${shown.length} profile${shown.length === 1 ? '' : 's'}`);

  // Deleting must never leave zero profiles (#124) — the catalog refuses the
  // last one too; this just avoids offering a control that can only fail.
  // Count the full catalog, not `shown`, so an in-flight delete can't hide
  // the trash on the card that will actually remain.
  const registeredCount = profiles.filter((profile) => profile.isUnregistered !== true).length;

  const cards = shown
    .map((profile) => {
      const isUnregistered = profile.isUnregistered === true;
      const isActive = profile.isActive === true;
      const canDelete = !isActive && !isUnregistered && registeredCount > 1;
      const displayName = profile.displayName || profile.id;

      const badge = isActive
        ? '<span class="avatar-badge">Current</span>'
        : isUnregistered
          ? '<span class="avatar-badge">Unregistered</span>'
          : '';

      // The avatar is the primary action: open a registered profile, or
      // register an unregistered one. The active profile is inert.
      const avatarTag = isActive || isUnregistered ? 'div' : 'button';
      const avatarAttrs = isActive
        ? 'class="profile-card-avatar is-active"'
        : isUnregistered
          ? 'class="profile-card-avatar is-unregistered" role="button" tabindex="0" data-import-profile title="Register this profile"'
          : 'type="button" class="profile-card-avatar" data-open-profile title="Open ' +
            esc(displayName) +
            '"';

      // Only registered, non-active profiles can be deleted (the default one
      // included, as long as another profile remains), so omit the trash button entirely for the rest rather than show a
      // dead, disabled control.
      const controls = isUnregistered
        ? '<button type="button" class="link-btn" data-import-profile>Register</button>'
        : `
          <button type="button" class="icon-btn" data-edit-profile aria-label="Profile settings for ${esc(displayName)}">${PENCIL_ICON}</button>
          ${
            canDelete
              ? `<button type="button" class="icon-btn danger" data-delete-profile aria-label="Delete ${esc(displayName)}">${TRASH_ICON}</button>`
              : ''
          }`;

      return `
        <div class="profile-card${isActive ? ' is-active' : ''}" data-profile-id="${esc(profile.id)}" data-profile-display-name="${esc(displayName)}">
          <${avatarTag} ${avatarAttrs}>
            ${avatarSvg()}
            ${badge}
          </${avatarTag}>
          <div class="profile-card-foot">
            <div class="profile-card-namewrap">
              <span class="profile-card-name">${esc(displayName)}</span>
            </div>
            <div class="profile-card-controls">${controls}</div>
          </div>
        </div>`;
    })
    .join('');

  managerList.innerHTML = cards + createTile;

  // A name clipped to "…" gets a hover tooltip so the full name is
  // recoverable; names that fit are left alone (no redundant tip).
  hideHoverTooltip();
  managerList.querySelectorAll('.profile-card-name').forEach((el) => {
    bindHoverTooltip(el, (node) => (node.scrollWidth > node.clientWidth ? node.textContent : ''));
  });
};

const refreshProfiles = async () => {
  if (!managerList) return;
  try {
    const result = await freedomAPI.listProfiles?.();
    if (!result?.success) {
      throw new Error(result?.error?.message || 'Profiles unavailable');
    }
    renderProfiles(result.profiles || []);
  } catch (err) {
    setStats('Profile list unavailable');
    managerList.innerHTML = '<div class="profile-manager-empty">Profile list unavailable</div>';
    logError('Failed to load profiles', err);
  }
};

// --- Edit (open profile + its settings) -------------------------------
// Renaming now lives on the profile's own Settings page. The pencil opens
// that profile and lands it on freedom://settings/profile. The active
// profile is this window's own process, so open its settings here rather
// than asking another process to do it.
const SETTINGS_PROFILE_URL = 'freedom://settings/profile';
const editProfile = async (card) => {
  const profileId = card?.dataset.profileId;
  if (!profileId) return;
  if (card.classList.contains('is-active')) {
    freedomAPI.openInNewTab?.(SETTINGS_PROFILE_URL);
    return;
  }
  try {
    const result = await freedomAPI.openProfileSettings?.(profileId);
    if (!result?.success) {
      throw new Error(result?.error?.message || 'Profile could not be opened');
    }
  } catch (err) {
    logError('Failed to open profile settings', err);
    showStatus(err.message || 'Profile settings could not be opened');
  }
};

// --- Delete confirmation modal ----------------------------------------
// A simple yes/no confirmation (no typed-name challenge).
let pendingDelete = null;
// Ids whose optimistic delete is in flight; renderProfiles filters these
// out so a concurrent refresh can't resurrect a card mid-delete.
const pendingDeleteIds = new Set();
const deleteConfirmBtn = deleteModal.querySelector('[data-delete-confirm]');
const deleteCancelBtn = deleteModal.querySelector('.secondary-btn[data-delete-cancel]');
const deleteConfirmLabel = deleteConfirmBtn?.textContent || 'Delete';

// Keep the destructive button inert briefly after opening so the dialog
// can't be confirmed by reflex; it arms after a short, deliberate pause.
const DELETE_ARM_DELAY_MS = 1500;
let deleteArmTimer = null;

const openDeleteModal = (profileId, displayName) => {
  pendingDelete = { profileId, displayName };
  deleteModal
    .querySelectorAll('[data-delete-name]')
    .forEach((el) => (el.textContent = displayName));
  deleteModal
    .querySelectorAll('[data-delete-avatar]')
    .forEach((el) => (el.innerHTML = avatarSvg()));
  if (deleteConfirmBtn) {
    deleteConfirmBtn.textContent = deleteConfirmLabel;
    deleteConfirmBtn.disabled = true;
  }
  clearTimeout(deleteArmTimer);
  deleteArmTimer = setTimeout(() => {
    if (deleteConfirmBtn) deleteConfirmBtn.disabled = false;
  }, DELETE_ARM_DELAY_MS);
  deleteModal.hidden = false;
  // Focus Cancel (not the destructive action) so a stray Enter can't delete.
  deleteCancelBtn?.focus();
};

const closeDeleteModal = () => {
  pendingDelete = null;
  clearTimeout(deleteArmTimer);
  deleteModal.hidden = true;
};

const confirmDelete = async () => {
  if (!pendingDelete) return;
  const { profileId } = pendingDelete;

  // The modal captured the display name when it opened; a rename in
  // another window since then would make that confirmation stale and the
  // server rejects it. Re-read the current name from the catalog by id so
  // we confirm against what the profile is actually called *now*. If it's
  // already gone (deleted elsewhere), there's nothing to do but refresh.
  let confirmDisplayName = pendingDelete.displayName;
  try {
    const listed = await freedomAPI.listProfiles?.();
    if (listed?.success) {
      const current = listed.profiles?.find((p) => p.id === profileId);
      if (!current) {
        closeDeleteModal();
        await refreshProfiles();
        return;
      }
      confirmDisplayName = current.displayName || confirmDisplayName;
    }
  } catch (err) {
    // Fall back to the captured name; the server still guards the match.
    logError('Failed to re-read profile name before delete', err);
  }

  // Optimistic: drop the card and return to the manager immediately, then
  // delete in the background. On failure we re-fetch to restore the card.
  // Mark the id as deleting so a concurrent onProfileUpdated refresh can't
  // re-render the card before the deletion lands in the registry.
  closeDeleteModal();
  pendingDeleteIds.add(profileId);
  managerList?.querySelector(`[data-profile-id="${CSS.escape(profileId)}"]`)?.remove();
  try {
    const result = await freedomAPI.deleteProfile?.(profileId, confirmDisplayName);
    if (!result?.success) {
      throw new Error(result?.error?.message || 'Profile could not be deleted');
    }
    // Deletion landed in the registry; the id can leave the guard set
    // (subsequent refreshes already won't list it).
    pendingDeleteIds.delete(profileId);
  } catch (err) {
    logError('Failed to delete profile', err);
    showStatus(err.message || 'Profile could not be deleted');
    pendingDeleteIds.delete(profileId);
    await refreshProfiles();
  }
};

deleteModal
  .querySelectorAll('[data-delete-cancel]')
  .forEach((el) => el.addEventListener('click', closeDeleteModal));
deleteConfirmBtn?.addEventListener('click', confirmDelete);
// Listen on the document, not the modal: clicking the modal body moves
// focus off the buttons, so a modal-scoped keydown would stop firing.
document.addEventListener('keydown', (event) => {
  if (deleteModal.hidden) return;
  if (event.key === 'Escape') {
    event.preventDefault();
    closeDeleteModal();
  } else if (event.key === 'Enter') {
    // Enter is a no-op: deleting is destructive, so it must be a deliberate click.
    event.preventDefault();
  }
});

// --- Profile actions ---------------------------------------------------
const openProfile = async (card, trigger) => {
  const profileId = card?.dataset.profileId;
  if (!profileId) return;
  if (trigger) trigger.disabled = true;
  try {
    const result = await freedomAPI.openProfile?.(profileId);
    if (!result?.success) {
      throw new Error(result?.error?.message || 'Profile could not be opened');
    }
  } catch (err) {
    logError('Failed to open profile', err);
    showStatus(err.message || 'Profile could not be opened');
  } finally {
    if (trigger) trigger.disabled = false;
  }
};

const registerProfile = async (card) => {
  const profileId = card?.dataset.profileId;
  if (!profileId) return;
  try {
    const result = await freedomAPI.importProfile?.(profileId);
    if (!result?.success) {
      throw new Error(result?.error?.message || 'Profile could not be registered');
    }
    await refreshProfiles();
  } catch (err) {
    logError('Failed to register profile', err);
    showStatus(err.message || 'Profile could not be registered');
  }
};

managerList?.addEventListener('click', (event) => {
  const target = event.target;

  if (target?.closest?.('[data-create-profile]')) {
    // Opens the shared chrome create-modal over this page's owning window.
    freedomAPI.requestCreateProfileModal?.();
    return;
  }

  const editBtn = target?.closest?.('[data-edit-profile]');
  if (editBtn) {
    editProfile(editBtn.closest('[data-profile-id]'));
    return;
  }

  const deleteBtn = target?.closest?.('[data-delete-profile]');
  if (deleteBtn) {
    const card = deleteBtn.closest('[data-profile-id]');
    if (card) openDeleteModal(card.dataset.profileId, card.dataset.profileDisplayName);
    return;
  }

  const importEl = target?.closest?.('[data-import-profile]');
  if (importEl) {
    registerProfile(importEl.closest('[data-profile-id]'));
    return;
  }

  const openEl = target?.closest?.('[data-open-profile]');
  if (openEl) {
    openProfile(openEl.closest('[data-profile-id]'), openEl);
  }
});

// Keyboard activation for the unregistered avatar (a focusable div).
managerList?.addEventListener('keydown', (event) => {
  if (event.key !== 'Enter' && event.key !== ' ') return;
  const importEl = event.target?.closest?.('[data-import-profile]');
  if (importEl && importEl.matches('.profile-card-avatar')) {
    event.preventDefault();
    registerProfile(importEl.closest('[data-profile-id]'));
  }
});

// Live-refresh when a profile is created (via the modal), renamed, or
// deleted elsewhere. Skip only while a delete is being confirmed, so we
// don't pull the card out from under the modal.
freedomAPI.onProfileUpdated?.(() => {
  if (!deleteModal.hidden) return;
  refreshProfiles();
});

refreshProfiles();
