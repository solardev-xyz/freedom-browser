/**
 * The start page's Freedom Agent setup step (#881), shared by home-ai.js and
 * Settings → AI.
 */
const {
  AI_INVITATION_STEPS,
  aiInvitationStep,
  dismissedAiInvitationStep,
} = require('./ai-invitation-step.js');

const state = (value) => async () => value;
const failing = async () => {
  throw new Error('unavailable');
};

describe('aiInvitationStep', () => {
  test('AI off introduces Agent, or says it is off when a model is connected', async () => {
    const off = { enableAi: false };
    expect(await aiInvitationStep(off, state({ ok: true, configured: false }))).toBe('enable');
    expect(await aiInvitationStep(off, state({ ok: true, configured: true }))).toBe('resume');
    // An unreadable state falls back to the introduction.
    expect(await aiInvitationStep(off, state({ ok: false }))).toBe('enable');
    expect(await aiInvitationStep(off, failing)).toBe('enable');
    expect(await aiInvitationStep(null, failing)).toBe('enable');
  });

  test('AI on asks for a model until one is connected', async () => {
    const on = { enableAi: true };
    expect(await aiInvitationStep(on, state({ ok: true, configured: false }))).toBe('connect');
    expect(await aiInvitationStep(on, state({ ok: true, configured: true }))).toBe(null);
    expect(await aiInvitationStep(on, state({ ok: false }))).toBe(null);
    expect(await aiInvitationStep(on, failing)).toBe(null);
  });
});

describe('dismissedAiInvitationStep', () => {
  test('names a dismissed step and nothing else', () => {
    for (const step of AI_INVITATION_STEPS) {
      expect(dismissedAiInvitationStep({ aiInvitationDismissed: step })).toBe(step);
    }
    for (const value of [false, true, undefined, 'other', 1]) {
      expect(dismissedAiInvitationStep({ aiInvitationDismissed: value })).toBe(null);
    }
    expect(dismissedAiInvitationStep(null)).toBe(null);
  });
});
