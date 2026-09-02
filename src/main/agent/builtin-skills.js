'use strict';

const fs = require('fs');
const path = require('path');
const { VIRTUAL_AGENT_CWD, VIRTUAL_SKILLS_ROOT } = require('./pi-virtual-paths');

const MAX_BUILTIN_SKILL_BYTES = 64 * 1024;
const BUNDLED_SKILLS_ROOT = path.join(__dirname, 'skills');

const BUILTIN_SKILL_DEFINITIONS = Object.freeze([
  Object.freeze({
    name: 'swarm-postage',
    description:
      'Plan, price, purchase, monitor, and verify Swarm postage stamp batches through Freedom’s Ant node tools.',
    files: Object.freeze(['SKILL.md']),
  }),
  Object.freeze({
    name: 'swarm-publishing',
    description:
      'Publish attached files, live folders, static sites, and bounded text to Swarm through Freedom.',
    files: Object.freeze(['SKILL.md']),
  }),
]);

function skillVirtualPath(skillName, relativeFile) {
  return path.join(VIRTUAL_SKILLS_ROOT, skillName, relativeFile);
}

function assertBundledRegularFile(filePath) {
  const stats = fs.lstatSync(filePath);
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw new Error(`Bundled Freedom skill resource is not a regular file: ${filePath}`);
  }
  if (stats.size > MAX_BUILTIN_SKILL_BYTES) {
    throw new Error(`Bundled Freedom skill resource exceeds the size limit: ${filePath}`);
  }
}

function createBuiltInSkillBundle() {
  const resources = new Map();
  const skills = [];

  for (const definition of BUILTIN_SKILL_DEFINITIONS) {
    const baseDir = skillVirtualPath(definition.name, '');
    const skillFilePath = skillVirtualPath(definition.name, 'SKILL.md');
    for (const relativeFile of definition.files) {
      const physicalPath = path.join(BUNDLED_SKILLS_ROOT, definition.name, relativeFile);
      assertBundledRegularFile(physicalPath);
      const content = fs.readFileSync(physicalPath);
      if (content.byteLength > MAX_BUILTIN_SKILL_BYTES) {
        throw new Error(`Bundled Freedom skill resource exceeds the size limit: ${physicalPath}`);
      }
      resources.set(skillVirtualPath(definition.name, relativeFile), Buffer.from(content));
    }
    skills.push(
      Object.freeze({
        name: definition.name,
        description: definition.description,
        filePath: skillFilePath,
        baseDir,
        sourceInfo: Object.freeze({
          path: skillFilePath,
          source: 'freedom-builtin',
          scope: 'project',
          origin: 'package',
          baseDir,
        }),
        disableModelInvocation: false,
      })
    );
  }

  return Object.freeze({
    skills: Object.freeze(skills),
    resources,
  });
}

const BUILTIN_SKILL_BUNDLE = createBuiltInSkillBundle();

function normalizeRequestedPath(filePath) {
  if (typeof filePath !== 'string' || !filePath) return '';
  return path.resolve(filePath);
}

function getBuiltInSkillResource(filePath) {
  const normalized = normalizeRequestedPath(filePath);
  const content = BUILTIN_SKILL_BUNDLE.resources.get(normalized);
  if (!content) {
    const error = new Error('Freedom Agent can read only bundled skill files');
    error.code = 'FREEDOM_SKILL_PATH_DENIED';
    throw error;
  }
  return Buffer.from(content);
}

function isBuiltInSkillResourcePath(filePath) {
  return BUILTIN_SKILL_BUNDLE.resources.has(normalizeRequestedPath(filePath));
}

function createBuiltInSkillReadOperations() {
  return Object.freeze({
    access: async (filePath) => {
      getBuiltInSkillResource(filePath);
    },
    readFile: async (filePath) => getBuiltInSkillResource(filePath),
    detectImageMimeType: async () => null,
  });
}

function createBuiltInSkillReadTool(sdk) {
  if (!sdk || typeof sdk.createReadTool !== 'function') {
    throw new TypeError('Freedom built-in skills require Pi createReadTool');
  }
  const readTool = sdk.createReadTool(VIRTUAL_AGENT_CWD, {
    autoResizeImages: false,
    operations: createBuiltInSkillReadOperations(),
  });
  return Object.freeze({
    ...readTool,
    label: 'Load Agent skill',
    description:
      'Read one reviewed built-in Freedom Agent skill using an exact virtual path from the available skills catalog. Host files and unlisted paths are unavailable.',
  });
}

function getBuiltInSkills() {
  return BUILTIN_SKILL_BUNDLE.skills;
}

module.exports = {
  BUILTIN_SKILL_DEFINITIONS,
  MAX_BUILTIN_SKILL_BYTES,
  VIRTUAL_SKILLS_ROOT,
  createBuiltInSkillReadOperations,
  createBuiltInSkillReadTool,
  getBuiltInSkillResource,
  getBuiltInSkills,
  isBuiltInSkillResourcePath,
  skillVirtualPath,
};
