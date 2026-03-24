#!/usr/bin/env node
/**
 * EvoHive skill hook example.
 *
 * Receives:
 *   EVOHIVE_ACTION=verify|burn|event
 *   EVOHIVE_PAYLOAD_JSON=<json>
 *
 * Must print JSON to stdout, e.g.:
 *   {"ok":true,"txHash":"0x..."}
 *
 * Use this to bridge EvoHive to your local OnchainOS skill command wrappers.
 */

const action = process.env.EVOHIVE_ACTION;
const payloadRaw = process.env.EVOHIVE_PAYLOAD_JSON || '{}';

let payload;
try {
  payload = JSON.parse(payloadRaw);
} catch {
  console.error('invalid EVOHIVE_PAYLOAD_JSON');
  process.exit(1);
}

// TODO: Replace with real skill command integration.
// Example strategy:
// 1) dispatch by action
// 2) invoke your skill runner / CLI
// 3) map returned fields to EvoHive expected shape

if (action === 'verify') {
  console.error('verify hook not implemented in example');
  process.exit(2);
}

if (action === 'burn') {
  console.error('burn hook not implemented in example');
  process.exit(2);
}

if (action === 'event') {
  console.error('event hook not implemented in example');
  process.exit(2);
}

console.error(`unsupported action: ${action}`);
process.exit(2);
