// Only the built-in ordinary start page loads this script. What's new is a
// highlights section. Freedom Agent is currently the only highlight.
const section = document.getElementById('whats-new');
const intro = document.getElementById('home-intro');
const invitation = document.getElementById('ai-invitation');
const dismiss = document.getElementById('ai-invitation-dismiss');
const message = document.getElementById('ai-invitation-status');
const state = document.getElementById('ai-invitation-state');
const open = document.getElementById('ai-invitation-open');
let aiEnabled = false;
let opening = false;
function renderAiInvitation(settings) {
  aiEnabled = settings?.enableAi === true;
  invitation.hidden = settings?.aiInvitationDismissed === true;
  state.textContent = aiEnabled ? 'On' : 'Off';
  state.dataset.enabled = String(aiEnabled);
  open.title = aiEnabled ? 'Open Freedom Agent' : 'Enable AI in Settings';
  section.hidden = invitation.hidden;
}
open.addEventListener('click', async event => {
  if (!aiEnabled || event.button > 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  event.preventDefault();
  if (opening) return;
  opening = true;
  message.textContent = '';
  try {
    const result = await freedomAPI.openAgent();
    if (!result?.ok) {
      if (result?.error?.code === 'AGENT_DISABLED') {
        location.href = 'freedom://settings/ai';
        return;
      }
      throw new Error();
    }
  } catch {
    message.textContent = 'Could not open Agent. Please try again.';
  } finally {
    opening = false;
  }
});
dismiss.addEventListener('click', async () => {
  dismiss.disabled = true;
  try {
    if (!(await freedomAPI.saveSettings({ aiInvitationDismissed: true }))) throw new Error();
    invitation.hidden = true;
    section.hidden = true;
    // The only highlight disappeared; return keyboard focus to the introduction.
    intro.focus();
  } catch {
    message.textContent = 'Could not hide this highlight. Please try again.';
  } finally {
    dismiss.disabled = false;
  }
});
freedomAPI.onSettingsUpdated?.(renderAiInvitation);
freedomAPI
  .getSettings()
  .then(renderAiInvitation)
  .catch(() => {
    // Keep the highlight hidden when its saved state cannot be loaded.
  });
