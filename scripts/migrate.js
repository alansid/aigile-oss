// Cloudflare D1：一個指令套完還沒套的資料庫升級（npm run cf:db:migrate；npm run deploy 也會先跑）
//   全新的 D1：用 src/schema.sql 建表，migrations/ 現有的升級全部標成已套
//   舊的 D1：照編號套還沒套的（每個升級＋記錄送成同一批，D1 一批是一個交易），最後再跑一次 schema.sql 補新表與索引
// 加 --local 是對本機模擬的 D1（npm run cf:dev 用的那份）
// 測試只 import 純函式（d1Steps），絕不連正式庫：直接執行這支才會呼叫 wrangler
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { listMigrations, planMigrations, versionOf, TRACK_SQL } from '../src/migrations.js';

// 整行註解拿掉；行尾的「-- 註解」也要拿掉，不然接成一行後，後面的 SQL 全變成註解
export const cleanSql = text => text.split(/\r?\n/).filter(l => !l.trim().startsWith('--')).map(l => l.replace(/\s+--.*$/, '')).join(' ').replace(/\s+/g, ' ').trim();
const q = s => `'${String(s).replace(/'/g, "''")}'`;

// 純函式：要送給 D1 的 SQL（每一步一批）
export function d1Steps({ fresh, applied, files, schema, now = new Date().toISOString() }) {
  const plan = planMigrations({ fresh, applied, files });
  if (plan.unknown.length) throw new Error(`D1 已經套過這版程式沒有的升級：${plan.unknown.join('、')}。請先更新程式碼。`);
  const steps = [{ label: '確認升級紀錄表', sql: TRACK_SQL }];
  if (plan.fresh) {
    steps.push({ label: '建立資料表（全新的 D1）', sql: cleanSql(schema) });
    if (plan.mark.length) steps.push({ label: `標記 ${plan.mark.length} 個升級為已套`, sql: plan.mark.map(n => `INSERT OR IGNORE INTO schema_migrations (name, applied_at) VALUES (${q(n)}, ${q(now)})`).join('; ') });
  } else {
    for (const f of plan.apply) steps.push({ label: `套用 migrations/${f.name}`, sql: `${cleanSql(f.sql).replace(/;\s*$/, '')}; INSERT INTO schema_migrations (name, applied_at) VALUES (${q(f.name)}, ${q(now)})` });
    steps.push({ label: '補新的表與索引', sql: cleanSql(schema) });
  }
  return { steps, plan, version: versionOf(plan.fresh ? plan.mark : [...applied, ...plan.apply.map(f => f.name)]) };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1])) {
  const where = process.argv.includes('--local') ? '--local' : '--remote';
  const win = process.platform === 'win32';
  const wrangler = (sql, json = false) => {
    const arg = win ? `"${sql.replace(/"/g, '\\"')}"` : sql; // Windows 透過 shell 執行 npx，SQL 整段加引號
    const r = spawnSync('npx', ['--yes', 'wrangler@4', 'd1', 'execute', 'DB', where, '--command', arg, ...(json ? ['--json'] : [])], { encoding: 'utf8', shell: win, stdio: json ? ['inherit', 'pipe', 'inherit'] : 'inherit' });
    if (r.status !== 0) { console.error(`\n資料庫升級停止：上面的指令失敗（${where}）。已經成功的步驟有記錄，修好後重跑 npm run cf:db:migrate 會從失敗的那一步繼續。`); process.exit(r.status ?? 1); }
    return json ? JSON.parse(r.stdout).flatMap(x => x.results || []) : null;
  };
  const tables = wrangler("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('participants', 'schema_migrations')", true).map(r => r.name);
  const fresh = !tables.includes('participants');
  const applied = tables.includes('schema_migrations') ? wrangler('SELECT name FROM schema_migrations', true).map(r => r.name) : [];
  const schema = fs.readFileSync(new URL('../src/schema.sql', import.meta.url), 'utf8');
  const files = listMigrations(fileURLToPath(new URL('../migrations/', import.meta.url)));
  const { steps, plan, version } = d1Steps({ fresh, applied, files, schema });
  console.log(fresh ? '全新的 D1：建立資料表' : plan.apply.length ? `要套 ${plan.apply.length} 個升級：${plan.apply.map(f => f.name).join('、')}` : '沒有要套的升級');
  for (const s of steps) { console.log(`→ ${s.label}`); wrangler(s.sql); }
  console.log(`完成：資料庫版本 ${version}`);
}
