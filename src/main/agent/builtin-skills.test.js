'use strict';

const path = require('path');
const {
  VIRTUAL_SKILLS_ROOT,
  createBuiltInSkillReadOperations,
  createBuiltInSkillReadTool,
  getBuiltInSkillResource,
  getBuiltInSkills,
  skillVirtualPath,
} = require('./builtin-skills');

describe('Freedom built-in Agent skills', () => {
  test('publishes reviewed Pi skill metadata at virtual-only locations', () => {
    expect(getBuiltInSkills()).toEqual([
      expect.objectContaining({
        name: 'swarm-postage',
        filePath: skillVirtualPath('swarm-postage', 'SKILL.md'),
        baseDir: skillVirtualPath('swarm-postage', ''),
        disableModelInvocation: false,
      }),
    ]);
    expect(getBuiltInSkills()[0].filePath).toContain(VIRTUAL_SKILLS_ROOT);
    expect(getBuiltInSkills()[0].filePath).not.toContain(__dirname);
  });

  test('reads only exact allowlisted bundled skill files', async () => {
    const operations = createBuiltInSkillReadOperations();
    const skillPath = skillVirtualPath('swarm-postage', 'SKILL.md');

    await expect(operations.access(skillPath)).resolves.toBeUndefined();
    const content = await operations.readFile(skillPath);
    expect(content).toBeInstanceOf(Buffer);
    expect(content.toString('utf8')).toContain('# Swarm postage batches');
    expect(content.toString('utf8')).toContain('node_operation_status');
  });

  test.each([
    ['/etc/passwd'],
    [path.resolve(VIRTUAL_SKILLS_ROOT, '..', '..', 'etc', 'passwd')],
    [skillVirtualPath('swarm-postage', '../other/SKILL.md')],
    [skillVirtualPath('unknown', 'SKILL.md')],
    [skillVirtualPath('swarm-postage', 'references/private.md')],
  ])('denies non-allowlisted path %s', (filePath) => {
    let error;
    try {
      getBuiltInSkillResource(filePath);
    } catch (caught) {
      error = caught;
    }
    expect(error).toMatchObject({
      code: 'FREEDOM_SKILL_PATH_DENIED',
      message: 'Freedom Agent can read only bundled skill files',
    });
  });

  test('constructs Pi read with only virtual skill operations', () => {
    const readTool = { name: 'read' };
    const sdk = { createReadTool: jest.fn(() => readTool) };

    expect(createBuiltInSkillReadTool(sdk)).toEqual({
      name: 'read',
      label: 'Load Agent skill',
      description: expect.stringContaining('Host files and unlisted paths are unavailable'),
    });
    expect(sdk.createReadTool).toHaveBeenCalledWith(
      expect.stringMatching(/freedom-agent$/),
      expect.objectContaining({
        autoResizeImages: false,
        operations: expect.objectContaining({
          access: expect.any(Function),
          readFile: expect.any(Function),
          detectImageMimeType: expect.any(Function),
        }),
      })
    );
  });
});
