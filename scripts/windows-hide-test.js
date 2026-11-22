import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const read = name => fs.readFileSync(fileURLToPath(new URL(`../public/${name}`, import.meta.url)), 'utf8');
const watcher = read('watcher.mjs');
const codex = read('aigile-codex.mjs');
const start = read('aigile-start.mjs');
const ui = read('aigile-codex-ui.mjs');

assert.match(watcher, /spawn\('taskkill',[^\n]+windowsHide:\s*true/);
assert.match(watcher, /spawn\(WAKE_CMD,\s*\{[^}]*windowsHide:\s*true/s);
assert.doesNotMatch(codex, /node:child_process/, 'the doorbell has no process-launch fallback');
assert.match(start, /spawn\(process\.execPath,[\s\S]*?watcher\.mjs[\s\S]*?windowsHide:\s*true/);
assert.match(ui, /app-server[\s\S]*?windowsHide:\s*true/);

const interactiveFallback = start.match(/if \(!r\) \{([\s\S]*?)\n    \}/)?.[1] ?? '';
assert.match(interactiveFallback, /stdio:\s*'inherit'/);
assert.doesNotMatch(interactiveFallback, /windowsHide:\s*true/);

console.log('windows-hide: background child processes stay hidden; interactive fallback remains visible');
