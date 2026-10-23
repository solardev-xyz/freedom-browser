'use strict';

const path = require('path');

const VIRTUAL_AGENT_CWD = process.platform === 'win32' ? 'C:\\freedom-agent' : '/freedom-agent';
const VIRTUAL_SKILLS_ROOT = path.join(VIRTUAL_AGENT_CWD, 'skills');

module.exports = {
  VIRTUAL_AGENT_CWD,
  VIRTUAL_SKILLS_ROOT,
};
