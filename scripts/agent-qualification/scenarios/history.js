'use strict';

function parsed(entry) {
  const text = entry.result?.content?.map((item) => item.text).join('\n') || '';
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

module.exports = {
  id: 'history',
  title: 'Reviewed checkpoint selection and production restore behavior',
  survivorPattern: null,
  async run(ctx) {
    const {
      fs,
      path,
      check,
      decisions,
      startRun,
      endRun,
      callTool,
      controller,
      historyStore,
    } = ctx;

    const run = await startRun('Qualify reviewed workspace checkpoints');
    decisions.push(true);
    await callTool(run, 'bash', { command: 'printf enabled' });
    const workspace = controller.getWorkspace(run.conversationId);
    const workspaceRoot = controller.leases.get(workspace.workspaceId).workspaceRoot;
    await Promise.all([
      fs.promises.writeFile(path.join(workspaceRoot, 'selected.txt'), 'one\n'),
      fs.promises.writeFile(path.join(workspaceRoot, 'unselected.txt'), 'never checkpointed\n'),
      fs.promises.writeFile(path.join(workspaceRoot, 'private.txt'), 'synthetic private fixture\n'),
      fs.promises.writeFile(path.join(workspaceRoot, '.env'), 'SYNTHETIC_SECRET=private\n'),
    ]);

    await endRun(run);
    const beforeCheckpoint = await controller.workspaceHistory(run.conversationId, {
      action: 'list',
    });
    check(
      'H1',
      'turn start and normal completion create no automatic checkpoint',
      beforeCheckpoint.versions.length === 0,
      { versions: beforeCheckpoint.versions.length }
    );

    const continuation = await startRun('Review selected project revisions');
    const historyTool = continuation.tools.find((tool) => tool.name === 'workspace_history');
    check(
      'H2',
      'the workspace-history skill is discoverable and the real workspace_history tool is exposed',
      continuation.systemPrompt.includes('workspace-history') &&
        historyTool?.parameters?.properties?.action?.enum?.includes('checkpoint'),
      { toolActions: historyTool?.parameters?.properties?.action?.enum }
    );
    const excluded = await callTool(continuation, 'workspace_history', {
      action: 'exclude',
      path: 'private.txt',
      reason: 'Synthetic private fixture',
    });
    const mandatory = await callTool(continuation, 'workspace_history', {
      action: 'include',
      path: '.env',
      reason: 'Attempted mandatory exclusion bypass',
    });
    check(
      'H3',
      'contextual exclusions persist and mandatory exclusions cannot be bypassed',
      parsed(excluded)?.exclusions?.some((entry) => entry.path === 'private.txt') &&
        mandatory.error?.code === 'WORKSPACE_HISTORY_UNAVAILABLE',
      { exclusions: parsed(excluded)?.exclusions, mandatoryError: mandatory.error }
    );

    const reviewOne = await callTool(continuation, 'workspace_history', {
      action: 'review',
      path: 'selected.txt',
    });
    const reviewOneResult = parsed(reviewOne);
    const first = await callTool(continuation, 'workspace_history', {
      action: 'checkpoint',
      reviewIds: [reviewOneResult.reviewId],
      label: 'Selected version one',
    });
    const firstResult = parsed(first);
    const firstFiles = await controller.workspaceHistory(run.conversationId, {
      action: 'files',
      versionId: firstResult.id,
    });
    check(
      'H4',
      'the real tool checkpoints only the explicitly reviewed exact revision',
      firstResult.reviewedPaths?.join(',') === 'selected.txt' &&
        firstFiles.files.map((file) => file.path).join(',') === 'selected.txt',
      { reviewedPaths: firstResult.reviewedPaths, savedFiles: firstFiles.files }
    );

    const replay = await callTool(continuation, 'workspace_history', {
      action: 'checkpoint',
      reviewIds: [reviewOneResult.reviewId],
      label: 'Replay must fail',
    });
    const staleReview = await callTool(continuation, 'workspace_history', {
      action: 'review',
      path: 'selected.txt',
    });
    await fs.promises.writeFile(path.join(workspaceRoot, 'selected.txt'), 'changed after review\n');
    const stale = await callTool(continuation, 'workspace_history', {
      action: 'checkpoint',
      reviewIds: [parsed(staleReview).reviewId],
      label: 'Changed token must fail',
    });
    const expiredReview = await callTool(continuation, 'workspace_history', {
      action: 'review',
      path: 'selected.txt',
    });
    controller.historyReviews.get(parsed(expiredReview).reviewId).expires = Date.now() - 1;
    const expired = await callTool(continuation, 'workspace_history', {
      action: 'checkpoint',
      reviewIds: [parsed(expiredReview).reviewId],
      label: 'Expired token must fail',
    });
    check(
      'H5',
      'replayed, changed, and expired review tokens are rejected',
      [replay, stale, expired].every(
        (entry) => entry.error?.code === 'WORKSPACE_HISTORY_UNAVAILABLE'
      ),
      { replay: replay.error, stale: stale.error, expired: expired.error }
    );

    const versionTwoReview = await callTool(continuation, 'workspace_history', {
      action: 'review',
      path: 'selected.txt',
    });
    const second = await callTool(continuation, 'workspace_history', {
      action: 'checkpoint',
      reviewIds: [parsed(versionTwoReview).reviewId],
      label: 'Selected version two',
    });
    const secondResult = parsed(second);
    const plan = await controller.workspaceHistory(run.conversationId, {
      action: 'prepare_restore',
      versionId: firstResult.id,
    });
    const restored = await controller.workspaceHistory(run.conversationId, {
      action: 'restore',
      token: plan.token,
    });
    const backup = await controller.workspaceHistory(run.conversationId, {
      action: 'file',
      versionId: restored.backupId,
      path: 'selected.txt',
    });
    check(
      'H6',
      'restore applies the reviewed target, preserves a reviewed backup, and leaves unrelated/excluded files alone',
      secondResult.id !== firstResult.id &&
        fs.readFileSync(path.join(workspaceRoot, 'selected.txt'), 'utf8') === 'one\n' &&
        backup.text === 'changed after review\n' &&
        fs.readFileSync(path.join(workspaceRoot, 'unselected.txt'), 'utf8') ===
          'never checkpointed\n' &&
        fs.readFileSync(path.join(workspaceRoot, 'private.txt'), 'utf8') ===
          'synthetic private fixture\n' &&
        fs.readFileSync(path.join(workspaceRoot, '.env'), 'utf8') ===
          'SYNTHETIC_SECRET=private\n',
      { restoredId: restored.id, backupId: restored.backupId }
    );
    const replayRestore = await controller
      .workspaceHistory(run.conversationId, { action: 'restore', token: plan.token })
      .then(() => null, (error) => error.message);
    check(
      'H7',
      'a restore token is single-use and cannot be replayed',
      /expired/.test(replayRestore || ''),
      { replayRestore }
    );

    await endRun(continuation);
    const durable = historyStore.getSession(run.conversationId);
    check(
      'H8',
      'checkpoint receipts are durable but do not claim that a checkpoint certifies testing',
      JSON.stringify(durable).includes('Project history: checkpoint') &&
        !JSON.stringify(durable).includes('certified'),
      { activityKinds: durable?.transcript?.map((entry) => entry.type) }
    );
  },
};
