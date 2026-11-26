import { copyFileSync, mkdirSync } from 'node:fs';

const output = new URL('../runtime/', import.meta.url);
mkdirSync(output, { recursive: true });
const files = [
  "aigile-start.mjs",
  "aigile-setup.mjs",
  "watcher.mjs",
  "aigile-wait.mjs",
  "aigile-codex.mjs",
  "aigile-codex-ui.mjs",
  "aigile-antigravity.mjs",
  "aigile-hook.mjs",
  "aigile-opencode.mjs",
  "aigile-mcp.mjs",
  "poll.mjs"
];
for (const name of files) {
  copyFileSync(new URL('../../../public/' + name, import.meta.url), new URL(name, output));
}
