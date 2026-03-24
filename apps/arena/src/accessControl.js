import { config } from './config.js';

function normalizeRole(role) {
  return String(role || '').trim().toLowerCase();
}

function namespaceOfAgent(agentId) {
  const raw = String(agentId || '').trim();
  const idx = raw.indexOf('/');
  if (idx <= 0) return 'default';
  return raw.slice(0, idx);
}

export function resolvePrincipal(req) {
  const token = String(req.headers['x-evohive-token'] || '').trim();
  const roleRaw = config.rbac.enabled ? config.rbac.tokenRoles[token] : 'admin';
  const role = normalizeRole(roleRaw || 'reader');
  return {
    tokenPresent: Boolean(token),
    role,
    allowedActions: new Set((config.rbac.rolePolicies[role] || []).map((x) => String(x).trim()))
  };
}

export function assertActionAllowed(principal, action) {
  if (!config.rbac.enabled) return;
  if (principal.allowedActions.has('*')) return;
  if (!principal.allowedActions.has(action)) {
    throw new Error(`RBAC_DENY:${principal.role}:${action}`);
  }
}

export function assertSameNamespace(...agentIds) {
  if (!agentIds.length) return;
  const normalized = agentIds.map(namespaceOfAgent);
  const first = normalized[0];
  if (normalized.some((x) => x !== first)) {
    throw new Error('NAMESPACE_MISMATCH');
  }
}

export function withDefaultNamespace(agentId, ns = 'default') {
  const raw = String(agentId || '').trim();
  if (!raw) return raw;
  if (raw.includes('/')) return raw;
  return `${ns}/${raw}`;
}
