'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Only receipts, never source bytes or credentials. A restart may resume
// observation, but is never authorization to repeat an upload.
class SwarmPublicationStore {
  constructor(directory) {
    this.filename = path.join(directory, 'agent-publications.json');
    this.records = new Map();
    try {
      const fd = fs.openSync(this.filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      try {
        const stat = fs.fstatSync(fd);
        if (!stat.isFile() || stat.size > 4 * 1024 * 1024) throw new Error('Invalid publication journal');
        const records = JSON.parse(fs.readFileSync(fd, 'utf8'));
        if (!Array.isArray(records) || records.length > 500) throw new Error('Invalid publication journal');
        for (const record of records) {
          if (!/^swarm_pub_[a-f0-9]{24}$/.test(record.publicationId) || typeof record.ownerId !== 'string') throw new Error('Invalid publication receipt');
          this.records.set(record.publicationId, record);
        }
      } finally { fs.closeSync(fd); }
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }

  list() { return [...this.records.values()].map(record => ({ ...record })); }

  save(record) {
    const next = new Map(this.records);
    next.set(record.publicationId, { ...record });
    if (next.size > 500) {
      for (const [id, item] of next) {
        if (['completed', 'failed'].includes(item.state) && id !== record.publicationId) next.delete(id);
        if (next.size <= 500) break;
      }
    }
    if (next.size > 500) throw new Error('Too many pending publications');
    this.write(next);
  }

  deleteConversation(ownerId) {
    this.write(new Map([...this.records].filter(([, record]) => record.ownerId !== ownerId)));
  }

  write(next) {
    const temporary = `${this.filename}.${crypto.randomBytes(12).toString('hex')}.tmp`;
    fs.mkdirSync(path.dirname(this.filename), { recursive: true, mode: 0o700 });
    const fd = fs.openSync(temporary, 'wx', 0o600);
    try {
      try { fs.writeFileSync(fd, JSON.stringify([...next.values()])); fs.fsyncSync(fd); }
      finally { fs.closeSync(fd); }
      fs.renameSync(temporary, this.filename);
      this.records = next;
    } catch (error) {
      try { fs.unlinkSync(temporary); } catch { /* Keep the original error. */ }
      throw error;
    }
  }
}

module.exports = { SwarmPublicationStore };
