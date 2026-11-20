// 測試用：在子程序跑一句 SQL（Postgres），讓 browser-kit 的 get／sql 在 Postgres 模式也能同步呼叫。
// 只給 scripts/browser-kit.js 用：stdin 收 JSON { dir, op: 'get'|'run', sql, args }，stdout 印結果的 JSON。
// 連線只用 AIGILE_TEST_PG_URL（openTestDb 會檢查只准本機），schema 跟伺服器一樣由資料夾決定。
import path from 'node:path';
import { openTestDb } from './test-db.js';

let input = '';
for await (const chunk of process.stdin) input += chunk;
const { dir, op, sql, args } = JSON.parse(input);
const db = await openTestDb(path.join(dir, 'switch.db'), { legacyProjects: false });
try {
  const out = op === 'get' ? await db.get(sql, ...args) : await db.run(sql, ...args);
  process.stdout.write(JSON.stringify(out ?? null));
} finally { await db.close(); }
