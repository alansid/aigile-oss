import assert from 'node:assert/strict';
import { approvedAigileTools, missingToolApprovals } from '../public/aigile-codex-ui.mjs';

const original = [
  '[mcp_servers.other.tools.aigile_me]',
  'approval_mode = "prompt"',
  '[mcp_servers.aigile.tools.aigile_me] # user policy',
  'approval_mode = "prompt"',
  '[mcp_servers.aigile.tools.aigile_post]',
  'enabled = false',
].join('\r\n');
const update = missingToolApprovals(original);
assert.equal(update.missing.length, approvedAigileTools.length - 1);
assert.ok(update.config.includes(original.replace('enabled = false', 'approval_mode = "approve"\r\nenabled = false')));
for (const name of approvedAigileTools) {
  assert.ok(update.config.includes('[mcp_servers.aigile.tools.' + name + ']'));
}
assert.deepEqual(missingToolApprovals(update.config), { config: update.config, missing: [] });
console.log('Codex approvals: missing entries, explicit policies, CRLF and repeat setup passed');
