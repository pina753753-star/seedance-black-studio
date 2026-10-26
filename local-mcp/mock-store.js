'use strict';
// TEST/LOCAL ONLY: in-process atomic sections, no persistence across restart.
// Never wire this store into a deployed MCP server.
const { ContractError } = require('./core');
const clone = value => value === undefined ? undefined : structuredClone(value);
function createMockStore() {
  const proposals = new Map(), requests = new Map();
  const key = (user, request) => JSON.stringify([user, request]);
  return {
    async createProposal(q) { if (proposals.has(q.id)) throw new ContractError('proposal_conflict'); proposals.set(q.id, clone(q)); },
    async getProposal(id) { return clone(proposals.get(id)); },
    async approve(id, user, hash, now) {
      const q = proposals.get(id);
      if (!q || q.userId !== user) throw new ContractError('not_found');
      if (q.fingerprint !== hash || q.expiresAt <= now || q.requestId) throw new ContractError('proposal_changed');
      q.approved = true;
      q.approval = { userId: user, fingerprint: hash, approvedAt: now };
    },
    async getRequest(user, id) { return clone(requests.get(key(user, id))); },
    async claim(user, requestId, proposalId, hash, now) {
      const existing = requests.get(key(user, requestId));
      if (existing) {
        if (existing.proposalId !== proposalId) throw new ContractError('request_conflict');
        return { fresh: false, record: clone(existing) };
      }
      const q = proposals.get(proposalId);
      if (!q || q.userId !== user || q.approved !== true || q.approval?.userId !== user || q.approval?.fingerprint !== hash || q.fingerprint !== hash || q.expiresAt <= now) throw new ContractError('approval_required');
      if (q.requestId) throw new ContractError('proposal_consumed');
      q.requestId = requestId;
      const record = { proposalId, state: 'pending' };
      requests.set(key(user, requestId), record);
      return { fresh: true, record: clone(record) };
    },
    async complete(user, id, taskId) { Object.assign(requests.get(key(user, id)), { state: 'started', taskId }); },
    async markUncertain(user, id) { const r = requests.get(key(user, id)); if (r.state === 'pending') r.state = 'uncertain'; }
  };
}
module.exports = { createMockStore };
