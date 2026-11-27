const { expect } = require('./fixtures');

// The wide, three-column Agent-first layout only exists above the 1100px
// compact breakpoint; below it full view hides the sessions and preview
// columns. CI's macOS desktop is 1024px wide and macOS will not size a window
// past its screen, so the default 1200px window lands at 1024px and full view
// opens compact. Zoom the chrome out instead until its CSS viewport is wide:
// layout and every geometry assertion stay in CSS pixels, and the result is
// the same on every host.
const WIDE_AGENT_VIEWPORT = 1280;

async function useWideAgentViewport(app, page) {
  await app.evaluate(({ BrowserWindow }, width) => {
    const win = BrowserWindow.getAllWindows().find((candidate) => !candidate.isDestroyed());
    win.webContents.setZoomFactor(Math.min(1, win.getContentBounds().width / width));
  }, WIDE_AGENT_VIEWPORT);
  await expect.poll(() => page.evaluate(() => window.innerWidth)).toBeGreaterThan(1100);
}

module.exports = { WIDE_AGENT_VIEWPORT, useWideAgentViewport };
