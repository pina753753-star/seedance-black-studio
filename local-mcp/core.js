'use strict';
// Core shared by local SDK transport and contract tests; no external configuration.
const { randomUUID } = require('node:crypto');
const { validateVideoGenerationOptions } = require('../api/_lib/video-model-validation');
const { calculateVideoCreditCost } = require('../api/_lib/video-pricing');
const { taskRequiresWatermark } = require('../api/_lib/credit-access');
const MODELS = ['bytedance/seedance-2.0', 'bytedance/seedance-2.0-fast', 'bytedance/seedance-2.5-standard', 'bytedance/seedance-2.5'];
const string = { type: 'string', minLength: 1, maxLength: 2000 };
const id = { type: 'string', minLength: 1, maxLength: 100 };
function schema(properties, required = Object.keys(properties)) {
  return { type: 'object', properties, required, additionalProperties: false };
}
const tools = [
  ['pina_get_balance', 'credits:read', schema({}), true],
  // Estimate stores a proposal for later human approval: not read-only.
  ['pina_estimate_generation', 'generation:read', schema({ prompt: string, model: { type: 'string', enum: MODELS }, duration: { type: 'integer', minimum: 1, maximum: 30 }, resolution: { type: 'string', enum: ['480p', '720p', '1080p'] }, aspect_ratio: { type: 'string', enum: ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9'] } }), false],
  ['pina_start_generation', 'generation:write', schema({ proposal_id: id, request_id: id }), false],
  ['pina_get_generation', 'generation:read', schema({ task_id: id }), false],
  ['pina_get_artifact', 'generation:read', schema({ task_id: id }), true]
].map(([name, scope, inputSchema, readOnly]) => ({
  name, description: name === 'pina_start_generation' ? 'Start one previously human-approved generation; consumes credits. Never retry an uncertain start with a new request.' : name === 'pina_estimate_generation' ? 'Calculate credits and save a proposal. Does not approve or start generation.' : name === 'pina_get_generation' ? 'Poll the owned generation through Pina; may save output, finish watermarking or refund a failed task. Never starts a new generation.' : name,
  inputSchema, securitySchemes: [{ type: 'oauth2', scopes: [scope] }],
  annotations: { readOnlyHint: readOnly, destructiveHint: ['pina_start_generation','pina_get_generation'].includes(name), openWorldHint: ['pina_start_generation','pina_get_generation'].includes(name), idempotentHint: false }
}));
class ContractError extends Error { constructor(code) { super(code); this.code = code; } }
const fail = code => { throw new ContractError(code); };
function validate(input, spec) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('invalid_arguments');
  if (Object.keys(input).some(k => !Object.hasOwn(spec.properties, k))) fail('invalid_arguments');
  for (const key of spec.required) if (!Object.hasOwn(input, key)) fail('invalid_arguments');
  for (const [key, value] of Object.entries(input)) {
    const p = spec.properties[key];
    if (p.type === 'string' && (typeof value !== 'string' || value.trim().length < (p.minLength || 1) || value.length > (p.maxLength || 2000))) fail('invalid_arguments');
    if (p.type === 'integer' && (!Number.isInteger(value) || value < p.minimum || value > p.maximum)) fail('invalid_arguments');
    if (p.enum && !p.enum.includes(value)) fail('invalid_arguments');
  }
}
function createCore({ authenticate, store, backend, integrity, now = Date.now, createId = randomUUID, artifactHosts = [], approvalBaseUrl = null, approvalPath = '/approve', allowStart = true, authorizeStart = () => true, price = calculateVideoCreditCost }) {
  if (typeof authenticate !== 'function' || !store || !backend || typeof integrity?.sign !== 'function' || typeof integrity?.verify !== 'function') throw new Error('Adapters required');
  async function principal(context, scope) {
    // Only the trusted transport may supply context. Never taken from arguments.
    const p = await authenticate(context);
    if (!p || typeof p.userId !== 'string' || !p.userId || !Number.isFinite(p.expiresAt) || p.expiresAt <= now()) fail('unauthenticated');
    if (!p.emailConfirmed || p.accountStatus !== 'active') fail('account_restricted');
    if (!Array.isArray(p.scopes) || !p.scopes.includes(scope)) fail('insufficient_scope');
    return p;
  }
  async function access(p, requireStartAccess = false) {
    // Adapter must read server-owned identity, entitlements, expiry and risk.
    const a = await backend.readAccess(p.userId);
    if (!a || a.userId !== p.userId || typeof a.allowed !== 'boolean' || !Array.isArray(a.models) || typeof a.watermarkRequired !== 'boolean' || !Number.isInteger(a.availableCredits) || a.availableCredits < 0) fail('access_unavailable');
    if (requireStartAccess && !a.allowed) fail('access_unavailable');
    return a;
  }
  async function proposalFor(p, proposalId) {
    const q = await store.getProposal(proposalId);
    if (!q || q.userId !== p.userId) fail('not_found');
    if (q.expiresAt <= now()) fail('proposal_expired');
    try {
      const estimateSchema = tools.find(t => t.name === 'pina_estimate_generation').inputSchema;
      validate(q.input, schema({ ...estimateSchema.properties, mode: { type: 'string', enum: ['text_to_video'] } }));
    } catch (_) { fail('proposal_changed'); }
    if (!integrity.verify(q)) fail('proposal_changed');
    return q;
  }
  async function snapshot(p, taskId) {
    const task = await backend.readSnapshot(p.userId, taskId);
    if (!task || task.userId !== p.userId || task.taskId !== taskId) fail('not_found');
    return task;
  }
  async function dispatch(name, args, context) {
    const definition = tools.find(t => t.name === name);
    if (!definition) fail('unknown_tool');
    validate(args, definition.inputSchema);
    const p = await principal(context, definition.securitySchemes[0].scopes[0]);
    if(name==='pina_start_generation'){
      if(!allowStart)fail('generation_not_enabled');
      if(typeof authorizeStart!=='function'||authorizeStart(p)!==true)fail('generation_not_allowed');
    }
    if (name === 'pina_get_balance') {
      const a = await access(p);
      return { available_credits: a.availableCredits, watermark_required: a.watermarkRequired, models: MODELS.filter(model => a.models.includes(model)) };
    }
    if (name === 'pina_estimate_generation') {
      const options = validateVideoGenerationOptions({ ...args, mode: 'text_to_video' });
      if (!options.ok) fail(options.error);
      const input = { prompt: args.prompt.trim(), model: options.model, mode: options.mode, duration: options.duration, resolution: options.resolution, aspect_ratio: options.aspectRatio };
      const a = await access(p, true);
      if (!a.models.includes(input.model)) fail('feature_unavailable');
      if (input.resolution === '1080p' && a.watermarkRequired) fail('resolution_subscription_required');
      const credits = price(input);
      if (!Number.isInteger(credits) || credits <= 0) fail('price_unavailable');
      const q = { id: createId(), userId: p.userId, input, credits, watermarkRequired: a.watermarkRequired, expiresAt: now() + 600000, approved: false };
      q.fingerprint = integrity.sign(q);
      await store.createProposal(q);
      const approvalUrl = approvalBaseUrl ? new URL(approvalPath+'?proposal_id=' + encodeURIComponent(q.id), approvalBaseUrl).href : undefined;
      return { ...(approvalUrl ? { approval_url: approvalUrl } : {}), proposal_id: q.id, fingerprint: q.fingerprint, input, credits, watermark_required: q.watermarkRequired, expires_at: q.expiresAt, sufficient_balance: a.availableCredits >= credits, approval_required: true };
    }
    if (name === 'pina_start_generation') {
      // Existing claims are returned even after proposal expiration. Never resend.
      const existing = await store.getRequest(p.userId, args.request_id);
      if (existing) {
        if (existing.proposalId !== args.proposal_id) fail('request_conflict');
        return { request_id: args.request_id, state: existing.state, ...(existing.taskId ? { task_id: existing.taskId } : {}) };
      }
      const q = await proposalFor(p, args.proposal_id);
      if (q.approved !== true || q.approval?.userId !== p.userId || q.approval?.fingerprint !== q.fingerprint) fail('approval_required');
      const a = await access(p, true);
      if (!a.models.includes(q.input.model)) fail('feature_unavailable');
      if (q.input.resolution === '1080p' && a.watermarkRequired) fail('resolution_subscription_required');
      if (price(q.input) !== q.credits || a.watermarkRequired !== q.watermarkRequired) fail('requote_required');
      if (a.availableCredits < q.credits) fail('insufficient_credits');
      // Atomic consume-proposal + unique(user,request) claim BEFORE any start.
      // Durable production transaction must also recheck approved/hash/expiry.
      const claim = await store.claim(p.userId, args.request_id, q.id, q.fingerprint, now(), q);
      if (!claim.fresh) return { request_id: args.request_id, state: claim.record.state, ...(claim.record.taskId ? { task_id: claim.record.taskId } : {}) };
      try {
        // Production adapter must preserve existing auth/control/moderation,
        // reservation/atomic deduction/refund. This is NOT an HTTP passthrough.
        const { prompt, model, mode, duration, resolution, aspect_ratio } = q.input;
        const input = { prompt, model, mode, duration, resolution, aspect_ratio };
        const result = await backend.start({ userId: p.userId, input, expectedCredits: q.credits, watermarkRequired: q.watermarkRequired, requestId: args.request_id });
        if (!result || result.userId !== p.userId || typeof result.taskId !== 'string' || !result.taskId) throw new Error('Unconfirmed start');
        await store.complete(p.userId, args.request_id, result.taskId);
        return { request_id: args.request_id, state: 'started', task_id: result.taskId };
      } catch (_) {
        // If provider/adapter outcome or persistence is unknown, never retry.
        // Even if marking fails, the initial 'pending' claim remains blocking.
        await store.markUncertain(p.userId, args.request_id).catch(() => {});
        return { request_id: args.request_id, state: 'uncertain', action: 'reconcile_required' };
      }
    }
    let task = await snapshot(p, args.task_id);
    if (name === 'pina_get_generation' && backend.refreshSnapshot) {
      task = await backend.refreshSnapshot(p.userId, args.task_id);
      if (!task || task.userId !== p.userId || task.taskId !== args.task_id) fail('not_found');
    }
    if (name === 'pina_get_generation') {
      if (!['queued', 'processing', 'completed', 'failed', 'cancelled'].includes(task.status)) fail('invalid_snapshot');
      return { task_id: task.taskId, status: task.status, ...(typeof task.refunded === 'boolean' ? { refunded: task.refunded } : { refund_status: 'unknown' }) };
    }
    if (task.status !== 'completed') fail('artifact_not_ready');
    // Re-read current server-owned policy; never trust a model/client plan.
    const a = await access(p);
    const watermarkRequired = taskRequiresWatermark(task, a);
    const url = watermarkRequired ? task.watermarkedUrl : (task.watermarkedUrl || task.outputUrl);
    if (watermarkRequired && task.watermarkComplete !== true) fail('artifact_not_ready');
    let parsed;
    try { parsed = new URL(url); } catch (_) { fail('artifact_not_ready'); }
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.port || !artifactHosts.includes(parsed.hostname)) fail('artifact_not_ready');
    return { task_id: task.taskId, url: parsed.href, watermarked: url === task.watermarkedUrl };
  }
  return {
    listTools: () => structuredClone(tools),
    async approvalView(proposalId, context) {
      const p = await principal(context, 'generation:write');
      return proposalFor(p, proposalId);
    },
    dispatch,
    // PRIVATE APPLICATION METHOD. Not an MCP tool. Future trusted UI must
    // verify user interaction, CSRF/origin and session before calling it.
    async approveProposal(proposalId, expectedFingerprint, context) {
      const p = await principal(context, 'generation:write');
      const q = await proposalFor(p, proposalId);
      if (q.fingerprint !== expectedFingerprint) fail('proposal_changed');
      await store.approve(q.id, p.userId, expectedFingerprint, now(), q, context?.approvalSessionId);
      return { proposal_id: q.id, approved: true };
    },
    // Local request dispatcher, NOT a complete MCP transport/server handshake.
    async handle(request, context) {
      if (request?.method === 'tools/list') return { tools: structuredClone(tools) };
      if (request?.method !== 'tools/call') return { isError: true, content: [{ type: 'text', text: 'unsupported_method' }] };
      try {
        const data = await dispatch(request.params?.name, request.params?.arguments, context);
        return { structuredContent: data, content: [{ type: 'text', text: JSON.stringify(data) }] };
      } catch (error) {
        const code = error instanceof ContractError ? error.code : 'internal_error';
        return { isError: true, content: [{ type: 'text', text: code }] };
      }
    }
  };
}
module.exports = { createCore, ContractError };
