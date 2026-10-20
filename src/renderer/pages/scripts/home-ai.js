// Only the built-in ordinary start page loads this invitation.
const invitation = document.getElementById('ai-invitation');
const dismiss = document.getElementById('ai-invitation-dismiss');
const message = document.getElementById('ai-invitation-status');
function renderAiInvitation(settings) {
  invitation.hidden = settings?.enableAi === true || settings?.aiInvitationDismissed === true;
}
dismiss.addEventListener('click', async () => {
  dismiss.disabled = true;
  try {
    if (!(await freedomAPI.saveSettings({ aiInvitationDismissed: true }))) throw new Error();
    invitation.hidden = true;
  } catch {
    message.textContent = 'Could not dismiss this invitation. Please try again.';
  } finally {
    dismiss.disabled = false;
  }
});
freedomAPI.onSettingsUpdated?.(renderAiInvitation);
freedomAPI
  .getSettings()
  .then(renderAiInvitation)
  .catch(() => {});
