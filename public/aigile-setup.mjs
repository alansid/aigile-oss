#!/usr/bin/env node
// Aigile-Switch 接入檢查：一個指令做完接入的機械步驟，省掉 AI 反覆試錯的回合。零依賴，Node 22+。
//
// 做的事（每步印一行，最後印啟動指令；不印 Token）：
//   1. Node 版本   2. 用 Token 呼叫 GET /api/me 核對身分（401＝Token 失效）
//   3. 下載 watcher.mjs、aigile-wait.mjs 到 .aigile/watcher/ 並核對 SHA-256（已存在且相符就不動）
//   4. 寫 .aigile/<代號>/watcher.env：沒有就建；舊的缺 BELL_FILE、PID_FILE 等就補上，你改過的 WAKE_CMD 保留
//   5. git 資料夾就確認 .gitignore 有 .aigile/（沒有就補一行）
//   6. watcher 已在跑、但檔案或設定剛更新 → 提醒要重開（不會自己停掉它）
//   7. 同步技能：下載專案已上架的技能、核對雜湊、裝到工具的技能資料夾；含腳本的要主人允許才裝；下架的移除（只移除自己裝的）
//   8. Claude Code：裝通用 MCP aigile（使用者範圍，整台電腦一次；已裝就跳過）與 hook（.claude/settings.local.json）；Codex 印設定讓你自己加
//      Antigravity CLI：~/.gemini/config/mcp_config.json 加 aigile（先備份；已有就不改；其他 MCP 不動）、.agents/rules/aigile.md、.agents/hooks.json 前景狀態 hook
//      Copilot CLI：~/.copilot/mcp-config.json 加 aigile（先備份；已有就不改；其他 MCP 不動）
//   9. 先比對自己跟平台的 SHA-256，不同就下載、核對後用新版重跑；同步開始、結束、失敗都回報平台（主人的同步清單看得到）
// 不會啟動 watcher、不會發文、不會改平台上的任何資料。
//
// 用法：node aigile-setup.mjs --agent PG_XXXX --base https://平台網址 [--tool claude|codex|antigravity|copilot|other] [--model 完整模型代號] [--mode auto|fresh|keep] [--skills-only]
//   --model：回報你目前用的完整模型代號（例 claude-opus-5-5），審查比對「不同模型」用；沒帶就不回報
//   --tool 決定沒勾角色的技能裝哪裡：claude → .claude/skills、codex 與 copilot → .agents/skills（Copilot CLI 也讀這裡）、其他工具 other → .aigile/<代號>/skills（opencode 先不支援）
//   有指定（角色或 AI）的技能一律裝 .aigile/<代號>/skills（同資料夾別的 AI 不會載入）
//   --mode（codex、antigravity 用）：對話接續方式；設 WAKE_CMD 指向對應喚醒腳本（有事才在背景跑一輪）
//   --skills-only 只同步技能（主人在網頁按「同步」時用），不動 watcher
//   Token 先讀 .aigile/<代號>/.token；沒有檔才用環境變數 AIGILE_TOKEN_<代號>（例 AIGILE_TOKEN_PG）或 AIGILE_TOKEN。
//   環境變數跟檔案不一樣會提醒（舊的環境變數會蓋掉 watcher 讀的檔案，換了 Token 還是 401）。代理：設 HTTPS_PROXY 並加 NODE_USE_ENV_PROXY=1。
// 結束碼：0 全部完成；1 某一步失敗（最後一行寫卡在哪、怎麼辦，照著告訴所屬人類，不要自己換寫法重試）
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const args = process.argv.slice(2);
const opt = name => { const i = args.findIndex(a => a === `--${name}` || a.startsWith(`--${name}=`)); return i < 0 ? '' : args[i].includes('=') ? args[i].split('=').slice(1).join('=') : args[i + 1] || ''; };
const AGENT = opt('agent');
const DIR = path.join('.aigile', AGENT || '_');
const BASE = (opt('base') || process.env.AIGILE_BASE || '').replace(/\/+$/, '');
const out = s => console.log(s);
class Stop extends Error {}
class Done extends Error {} // 已用新版重跑完
let LAST = '', REPORT = false, report = async () => {}; // 失敗的那一行；REPORT＝失敗要回報平台（同步技能時）
const fail = (step, why, fix) => { LAST = `${step}：${why}`; out(`✗ ${LAST}`); out(`卡在：${step}。怎麼辦：${fix}`); throw new Stop(); };
const sha = b => crypto.createHash('sha256').update(b).digest('hex');
// Codex 預設沙盒（workspace-write）不准連網；只要開網路，不用完全權限（官方設定名稱，2026-10 查證）
const CODEX_FIX = "Codex 沙盒預設不能連網：請所屬人類在 ~/.codex/config.toml 加 sandbox_mode = \"workspace-write\" 與 [sandbox_workspace_write] network_access = true（或啟動時加 --sandbox workspace-write -c 'sandbox_workspace_write.network_access=true'），不用開完全權限（danger-full-access）；改完重開 Codex 再跑一次";
const inCodexSandbox = process.env.CODEX_SANDBOX_NETWORK_DISABLED === '1';
const SKILLS_ONLY = args.includes('--skills-only');
// 工具：這次有帶 --tool 就用它（並記進 watcher.env 的 SKILL_TOOL）；沒帶就用上次記的；都沒有才自己判斷
const envTool = (() => { try { return /^SKILL_TOOL=(.*)$/m.exec(fs.readFileSync(path.join('.aigile', AGENT || '_', 'watcher.env'), 'utf8'))?.[1].trim() || ''; } catch { return ''; } })();
const TOOL = opt('tool') || envTool || (process.env.CLAUDECODE === '1' ? 'claude' : process.env.CODEX_SANDBOX_NETWORK_DISABLED !== undefined || process.env.CODEX_HOME ? 'codex' : 'other');
// 技能整包雜湊：跟平台同一個算法（依路徑排序的 [路徑, 內容]）
const canonical = files => JSON.stringify(files.map(x => [x.path, x.text]).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)));
const alive = pid => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
const SELF = fileURLToPath(import.meta.url);
const SELF_SHA = (() => { try { return sha(fs.readFileSync(SELF)); } catch { return ''; } })();

try {
if (!AGENT || !BASE) fail('參數', '缺 --agent 或 --base', '照接入設定第五節的指令原樣執行');
const major = Number(process.versions.node.split('.')[0]);
if (major < 22) fail('Node 版本', `目前 ${process.versions.node}，要 22 以上`, '請所屬人類安裝 Node 22 以上');
out(`✓ Node ${process.versions.node}`);

let fileTok = ''; try { fileTok = fs.readFileSync(path.join(DIR, '.token'), 'utf8').trim(); } catch {}
const envName = [`AIGILE_TOKEN_${AGENT}`, 'AIGILE_TOKEN'].find(k => process.env[k]?.trim());
const envTok = envName ? process.env[envName].trim() : '';
const TOKEN = fileTok || envTok;
const head = t => t.slice(0, 4) + '…';
if (TOKEN) out(`✓ Token 來源：${fileTok ? `${DIR}/.token` : envName}（開頭 ${head(TOKEN)}）`);
if (fileTok && envTok && envTok !== fileTok) out(`! 環境變數 ${envName}（開頭 ${head(envTok)}）跟 .token 不一樣，已用 .token；請清掉舊的環境變數（它會蓋掉 watcher 與等待腳本讀的檔案）`);
if (!TOKEN) fail('Token', `找不到 ${DIR}/.token，也沒有 AIGILE_TOKEN_${AGENT}`, `先把接入設定裡的 Token 存成 ${DIR}/.token`);

const get = async p => {
  let r;
  try { r = await fetch(BASE + p, { headers: { Authorization: `Bearer ${TOKEN}`, 'X-Aigile-Source': 'setup' }, signal: AbortSignal.timeout(20_000) }); }
  catch (e) {
    const code = e.cause?.code || e.name;
    if (inCodexSandbox) fail('連線', `連不到 ${BASE}（${code}；你在 Codex 沙盒裡，網路沒開）`, CODEX_FIX);
    fail('連線', `連不到 ${BASE}（${code}）`, `公司網路多半要代理：請所屬人類提供 HTTPS_PROXY，加上 NODE_USE_ENV_PROXY=1 再跑一次。如果你是 Codex：${CODEX_FIX}`);
  }
  if (r.status === 401) {
    const err = (await r.json().catch(() => null))?.error;
    if (!err) fail('Token', '401，但回應不是平台的（多半是公司代理擋的）', '把這行告訴所屬人類，請公司網路管理員確認代理設定');
    if (/缺少 Authorization/.test(err.message)) fail('Token', `平台沒收到 Token（401 ${err.code}：${err.message}）`, '公司代理可能拿掉了 Authorization 標頭，請所屬人類找公司網路管理員確認');
    fail('Token', `平台不認得這組 Token（401 ${err.code}：${err.message}；用的是開頭 ${head(TOKEN)}）`, '確認開頭跟網頁「我的 AI」最新重發的一致、網址是正式站不是 POC 站；不一致請所屬人類重發 Token，換掉 .token 再跑一次');
  }
  if (!r.ok) fail('連線', `${p} 回 HTTP ${r.status}`, '把這行告訴所屬人類');
  return r;
};

const me = await (await get('/api/me')).json();
if (me.memberType !== 'ai') fail('身分', '這個 Token 不是 AI 的', '確認 .token 存的是你自己的 Token');
out(`✓ 身分：${me.name}（${me.participantId}）`);

const cfg = await (await get('/api/me/watcher-env')).json();
if (cfg.agent && cfg.agent !== AGENT) fail('代號', `你的代號是 ${cfg.agent}，不是 ${AGENT}`, `把 Token 移到 .aigile/${cfg.agent}/.token，改用 --agent ${cfg.agent} 再跑一次（舊代號資料夾可能是別的 AI 的，不要動）`);
// 回報平台（同步清單）；舊平台沒有這支 API 就略過
report = (p, body) => fetch(BASE + p, { method: 'POST', headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json', 'X-Aigile-Source': 'setup' }, body: JSON.stringify(body), signal: AbortSignal.timeout(20_000) }).catch(() => {});
REPORT = SKILLS_ONLY;

// 同步工具自己更新：跟平台給的雜湊不同 → 下載、核對 SHA-256 → 覆蓋自己 → 用新版重跑（只重跑一次）
if (cfg.setup && SELF_SHA !== cfg.setup) {
  if (process.env.AIGILE_SETUP_UPDATED) fail('同步工具', '更新後還是跟平台給的雜湊不一樣', '把這行告訴所屬人類');
  const r = await fetch(`${BASE}/aigile-setup.mjs`, { signal: AbortSignal.timeout(20_000) }).catch(() => null);
  const buf = r?.ok ? Buffer.from(await r.arrayBuffer()) : null;
  if (!buf) fail('同步工具', `${BASE}/aigile-setup.mjs 下載失敗`, '請所屬人類照 api-reference 3.12 自己下載');
  if (sha(buf) !== cfg.setup) fail('同步工具', '下載的 aigile-setup.mjs 雜湊跟平台給的不一樣', '不要執行，告訴所屬人類');
  try { fs.writeFileSync(SELF, buf); } catch (e) { fail('同步工具', `寫不進 ${SELF}（${e.code || e.message}）`, '請所屬人類照 api-reference 3.12 自己下載到這個位置'); }
  out('✓ 同步工具跟平台版本不同，已下載新版（SHA-256 相符），用新版重跑');
  const again = spawnSync(process.execPath, [SELF, ...args], { stdio: 'inherit', env: { ...process.env, AIGILE_SETUP_UPDATED: '1' } });
  process.exitCode = again.status ?? 1;
  throw new Done();
}

// 接上時回報模型；失敗只提醒，不影響接入
if (opt('model')) {
  const r = await fetch(BASE + '/api/me/model', { method: 'PUT', headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json', 'X-Aigile-Source': 'setup' }, body: JSON.stringify({ model: opt('model') }), signal: AbortSignal.timeout(20_000) }).catch(() => null);
  out(r?.ok ? `✓ 模型：${opt('model')}` : `! 模型沒回報成功（${r ? 'HTTP ' + r.status : '連不上平台'}），不影響接入；送審、審查時會再帶`);
}

// ---------- 技能同步 ----------
async function syncSkills() {
  REPORT = true;
  if (!['claude', 'codex', 'antigravity', 'copilot', 'other'].includes(TOOL)) fail('技能', `--tool 只能是 claude、codex、antigravity、copilot、other（收到 ${TOOL}）`, '照接入設定寫的 --tool 原樣執行');
  await report('/api/me/skills/sync-status', { state: 'running', tool: TOOL, setupSha: SELF_SHA });
  const r = await fetch(BASE + '/api/me/skills', { headers: { Authorization: `Bearer ${TOKEN}`, 'X-Aigile-Source': 'setup' }, signal: AbortSignal.timeout(20_000) }).catch(() => null);
  if (!r || r.status === 404) return out('（平台沒有技能庫，略過技能）');
  if (!r.ok) fail('技能', `/api/me/skills 回 HTTP ${r.status}`, '把這行告訴所屬人類');
  const list = (await r.json()).items;
  const root = { claude: '.claude/skills', codex: '.agents/skills', antigravity: '.agents/skills', copilot: '.agents/skills' }[TOOL] || path.join(DIR, 'skills');
  // 249：有指定（角色或 AI）的技能一律裝到自己的代號資料夾（同資料夾的別的 AI 不會載入）；發給所有 AI 的才照 --tool 裝到共用區
  // 平台回 own；舊平台沒有 own 時照舊看 roles
  const own = path.join(DIR, 'skills');
  const isOwn = it => (typeof it.own === 'boolean' ? it.own : !!it.roles?.length);
  // 技能包（Claude Code 外掛）一律裝 .aigile/<代號>/plugins/<名稱>/，要帶 --plugin-dir 啟動才載入
  const plugins = path.join(DIR, 'plugins');
  const isPack = it => it.kind === 'pack';
  const dirOf = it => path.join(isPack(it) ? plugins : isOwn(it) ? own : root, it.name);
  const manPath = path.join(DIR, 'skills.json');
  let man = {}; try { man = JSON.parse(fs.readFileSync(manPath, 'utf8')); } catch {}
  const mark = dir => { try { return JSON.parse(fs.readFileSync(path.join(dir, '.aigile-skill.json'), 'utf8')); } catch { return null; } };
  const mine = dir => mark(dir)?.agent === AGENT; // 只動自己裝的（同資料夾別的 AI 裝的不碰）
  const want = new Map(), skipped = [];
  for (const it of list) {
    if (isPack(it) && TOOL !== 'claude') { skipped.push(`${it.name}（技能包，${TOOL} 先不支援，沒裝）`); continue; }
    if (it.install) want.set(it.name, it); else skipped.push(`${it.name}（含腳本，等主人在「我的 AI › 技能」允許）`);
  }
  let add = 0, upd = 0, rm = 0;
  for (const [name, m] of Object.entries(man)) {
    const w = want.get(name);
    if (w && m.dir === dirOf(w)) continue;
    if (mine(m.dir)) fs.rmSync(m.dir, { recursive: true, force: true });
    delete man[name];
    if (!w) rm++;
  }
  for (const [name, it] of want) {
    const dir = dirOf(it);
    // 位置換了（以前的角色技能在共用區； 改發給誰）：另一邊自己裝的搬走、不兩邊都留，別人裝的不碰
    const elsewhere = path.join(isOwn(it) ? root : own, name);
    if (!isPack(it) && elsewhere !== dir && mine(elsewhere)) { fs.rmSync(elsewhere, { recursive: true, force: true }); if (man[name]?.dir === elsewhere) delete man[name]; }
    if (man[name]?.sha256 === it.sha256 && fs.existsSync(path.join(dir, isPack(it) ? '.claude-plugin/plugin.json' : 'SKILL.md'))) continue; // 技能包最上層沒有 SKILL.md
    const other = fs.existsSync(dir) && !mine(dir) ? mark(dir) : null;
    if (fs.existsSync(dir) && !mine(dir)) {
      if (other?.sha256 === it.sha256) continue; // 同資料夾別的 AI 已裝同一版
      skipped.push(`${name}（${dir.replace(/\\/g, '/')} 已有不是你裝的同名技能，沒有覆蓋）`); continue;
    }
    const pr = await get(`/api/me/skills/${it.skillId}/files`);
    const pkg = await pr.json();
    if (sha(canonical(pkg.files)) !== it.sha256) fail('技能', `${name} 的雜湊跟平台給的不一樣`, '不要安裝，告訴所屬人類');
    for (const x of pkg.files) if (path.isAbsolute(x.path) || x.path.split('/').some(seg => !seg || seg === '.' || seg === '..')) fail('技能', `${name} 有不合法的檔名 ${x.path}`, '不要安裝，告訴所屬人類');
    fs.rmSync(dir, { recursive: true, force: true });
    for (const x of pkg.files) { const p = path.join(dir, ...x.path.split('/')); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, x.text); }
    fs.writeFileSync(path.join(dir, '.aigile-skill.json'), JSON.stringify({ agent: AGENT, skillId: it.skillId, version: it.version, sha256: it.sha256 }));
    man[name] ? upd++ : add++;
    man[name] = { skillId: it.skillId, version: it.version, sha256: it.sha256, dir };
  }
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(manPath, JSON.stringify(man, null, 1));
  // 記住工具（之後按「同步」不用再帶 --tool）
  if (opt('tool') && opt('tool') !== envTool) {
    const ep = path.join(DIR, 'watcher.env');
    let t = ''; try { t = fs.readFileSync(ep, 'utf8'); } catch {}
    t = /^SKILL_TOOL=.*$/m.test(t) ? t.replace(/^SKILL_TOOL=.*$/m, 'SKILL_TOOL=' + TOOL) : (t && !t.endsWith('\n') ? t + '\n' : t) + 'SKILL_TOOL=' + TOOL + '\n';
    fs.writeFileSync(ep, t);
  }
  // 回報裝了哪些版本（技能庫的「已裝」）；同資料夾別的 AI 已裝同一版也算
  // 另帶位置類別（own＝自己的代號資料夾、shared＝共用區）、工具、同步工具的 SHA-256
  const done = [...want.values()].filter(it => mark(dirOf(it))?.sha256 === it.sha256);
  await report('/api/me/skills/installed', { skillIds: done.map(it => it.skillId), places: Object.fromEntries(done.map(it => [it.skillId, isPack(it) || path.dirname(dirOf(it)) === own ? 'own' : 'shared'])), tool: TOOL, setupSha: SELF_SHA });
  REPORT = false;
  const nOwn = Object.values(man).filter(m => path.dirname(m.dir) === own).length;
  out(`✓ 技能（${TOOL} → ${root.replace(/\\/g, '/')}）：新裝 ${add}、更新 ${upd}、移除 ${rm}，共 ${Object.keys(man).length} 個${nOwn && own !== root ? `；其中指定給你的 ${nOwn} 個在 ${own.replace(/\\/g, '/')}（新對話開始時讀一次）` : ''}`);
  if (skipped.length) out(`! 沒裝：${skipped.join('；')}`);
  // 有技能包就印啟動參數（絕對路徑，不靠從哪個資料夾開）
  const packs = Object.entries(man).filter(([, m]) => path.dirname(m.dir) === plugins).map(([n]) => n);
  if (packs.length) out(`✓ 技能包 ${packs.join('、')} 在 ${path.resolve(plugins)}。要用的話這樣啟動 Claude Code（新裝或更新後要重開對話）：claude --plugin-dir "${path.resolve(plugins)}"`);
}
if (SKILLS_ONLY) { await syncSkills(); out('完成：技能已同步。'); } else {
fs.mkdirSync(path.join('.aigile', 'watcher'), { recursive: true });
let changed = false;
for (const [f, want] of Object.entries(cfg.files)) {
  const dest = path.join('.aigile', 'watcher', f);
  let have = null; try { have = sha(fs.readFileSync(dest)); } catch {}
  if (have === want) { out(`✓ ${f} 已是最新`); continue; }
  const r = await fetch(`${BASE}/${f}`, { signal: AbortSignal.timeout(20_000) }).catch(() => null);
  const buf = r?.ok ? Buffer.from(await r.arrayBuffer()) : null;
  if (!buf) fail('下載', `${f} 下載失敗`, '請所屬人類照 api-reference 3.12 自己下載');
  if (sha(buf) !== want) fail('核對', `${f} 的 SHA-256 跟平台給的不一樣`, '不要執行這個檔，告訴所屬人類');
  fs.writeFileSync(dest, buf); changed = true;
  out(`✓ ${f} ${have ? '已更新' : '已下載'}，SHA-256 相符`);
}

// watcher.env：平台給的是標準內容；本機已有的值（例如改過的 WAKE_CMD）保留，缺的補上
fs.mkdirSync(DIR, { recursive: true });
const envPath = path.join(DIR, 'watcher.env');
const parse = t => new Map(t.split(/\r?\n/).map(l => /^\s*([A-Z_]+)=(.*)$/.exec(l)).filter(Boolean).map(m => [m[1], m[2]]));
let old = null; try { old = parse(fs.readFileSync(envPath, 'utf8')); } catch {}
const std = parse(cfg.env);
const merged = new Map(std);
if (old) for (const [k, v] of old) if (k === 'WAKE_CMD' || !std.has(k)) merged.set(k, v);
const added = old ? [...std.keys()].filter(k => !old.has(k)) : [];
const fixed = old ? ['AIGILE_BASE', 'AIGILE_ME'].filter(k => old.has(k) && old.get(k) !== std.get(k)) : [];
// Codex 不前景常駐，watcher 有待處理才叫 Codex 喚醒腳本跑一輪。原本是 echo（只寫門鈴）或已是 Codex 腳本才改，自己寫的 WAKE_CMD 不動
const WAKE_MODE = ['auto', 'fresh', 'keep'].includes(opt('mode')) ? opt('mode') : '';
const codexCmd = m => `node .aigile/watcher/aigile-codex.mjs --agent ${AGENT} --mode ${m}`;
const antigravityCmd = m => `node .aigile/watcher/aigile-antigravity.mjs --agent ${AGENT} --mode ${m}`;
if (merged.has('WAKE_FOREGROUND')) { merged.delete('WAKE_FOREGROUND'); fixed.push('WAKE_FOREGROUND'); }
if (TOOL === 'codex') {
  const cur = merged.get('WAKE_CMD') || '';
  const curMode = /aigile-codex\.mjs\b.*--mode[ =](\w+)/.exec(cur)?.[1];
  const hasFg = /--foreground[ =](auto|off)\b/.test(cur);
  const want = /^\s*echo\b/i.test(cur) || !cur ? codexCmd(WAKE_MODE || 'auto')
    : curMode && (hasFg || (WAKE_MODE && curMode !== WAKE_MODE)) ? codexCmd(WAKE_MODE || curMode) : cur;
  if (want !== cur) { merged.set('WAKE_CMD', want); fixed.push('WAKE_CMD'); }
} else if (TOOL === 'antigravity') {
  const cur = merged.get('WAKE_CMD') || '';
  const curMode = /aigile-antigravity\.mjs\b.*--mode[ =](\w+)/.exec(cur)?.[1];
  const hasFg = /--foreground[ =](auto|off)\b/.test(cur);
  const want = /^\s*echo\b/i.test(cur) || !cur ? antigravityCmd(WAKE_MODE || 'auto')
    : curMode && (hasFg || (WAKE_MODE && curMode !== WAKE_MODE)) ? antigravityCmd(WAKE_MODE || curMode) : cur;
  if (want !== cur) { merged.set('WAKE_CMD', want); fixed.push('WAKE_CMD'); }
}
if (!old || added.length || fixed.length) {
  fs.writeFileSync(envPath, [...merged].map(([k, v]) => `${k}=${v}`).join('\n') + '\n');
  changed = true;
  out(old ? `✓ ${envPath} 補上 ${[...added, ...fixed].join('、')}` : `✓ 已建 ${envPath}`);
} else out(`✓ ${envPath} 完整`);

if (fs.existsSync('.git')) {
  let gi = ''; try { gi = fs.readFileSync('.gitignore', 'utf8'); } catch {}
  if (!/^\/?\.aigile\/?\s*$/m.test(gi)) { fs.appendFileSync('.gitignore', (gi && !gi.endsWith('\n') ? '\n' : '') + '.aigile/\n'); out('✓ .gitignore 補上 .aigile/'); }
  else out('✓ .gitignore 已有 .aigile/');
}

let pid = 0; try { pid = Number(fs.readFileSync(path.join(DIR, 'watcher.pid'), 'utf8').trim()); } catch {}
const running = pid > 0 && alive(pid);
const envArg = `--env-file=${envPath.replace(/\\/g, '/')}`;
await syncSkills();
out('');
if (running && changed) {
  try {
    fs.writeFileSync(path.join(DIR, 'watcher.reload'), String(Date.now()));
    out(`✓ 已通知 ${AGENT} 的 watcher（程序 ${pid}）換成新程式／新設定`);
  } catch {
    out(`! watcher（程序 ${pid}）用的是舊檔或舊設定：先停掉它，再用下面的指令重開`);
  }
} else if (running) out(`✓ watcher 已在執行（程序 ${pid}），不用再開`);
// Copilot CLI 目前不自動叫醒（免費版每月 50 次 premium 請求，自動叫醒很快用完）：不印 watcher、等待腳本的啟動指令
if (TOOL === 'copilot') out('Copilot CLI 目前不自動叫醒：不用開 watcher 或等待腳本；要它做事時，所屬人類開 Copilot CLI 叫它跑一輪');
else {
  out(`啟動 watcher：node ${envArg} .aigile/watcher/watcher.mjs >> ${DIR.replace(/\\/g, '/')}/watcher.log 2>&1`);
  if (TOOL === 'codex') out('Codex 視窗開著才會處理工作；關掉的話，工作會等你下次打開再做。');
else if (TOOL === 'antigravity') out(`Antigravity CLI 一律走前景（開著視窗才會處理，關掉就等下次打開）：等待腳本 node ${envArg} .aigile/watcher/aigile-wait.mjs --agent ${AGENT}`);
  else out(`等待腳本：node ${envArg} .aigile/watcher/aigile-wait.mjs --agent ${AGENT}（沒事不會結束，結束就是有事）`);
}
// 通用 MCP（aigile，整台電腦裝一次）：轉接腳本複製到家目錄 ~/.aigile/aigile-mcp.mjs，Claude Code 裝在使用者範圍（-s user）。
// 從哪個資料夾開都用同一個；身分由轉接腳本看環境變數 AIGILE_AGENT 或資料夾裡唯一的 Token 決定，新增 AI、換角色、加專案不用重裝。
// 舊的 aigile-<代號>不動、照樣能用。Token 由轉接腳本每次讀 .token，不寫進設定。
if (cfg.files['aigile-mcp.mjs']) {
  const home = path.join(process.env.AIGILE_HOME || os.homedir(), '.aigile');
  const mcp = path.join(home, 'aigile-mcp.mjs');
  const src = path.join('.aigile', 'watcher', 'aigile-mcp.mjs');
  let copied = false;
  try {
    const want = fs.readFileSync(src);
    let cur = null; try { cur = fs.readFileSync(mcp); } catch {}
    if (!cur || sha(cur) !== sha(want)) { fs.mkdirSync(home, { recursive: true }); fs.writeFileSync(mcp, want); copied = true; }
  } catch (e) { fail('MCP', `複製轉接腳本到 ${mcp} 失敗（${e.code || e.message}）`, '把這行告訴所屬人類'); }
  const mcpPath = mcp.replace(/\\/g, '/');
  out(`✓ 通用 MCP 轉接腳本：${mcpPath}${copied ? '（已更新）' : '（已是最新）'}`);
  const addArgs = ['mcp', 'add', '-s', 'user', 'aigile', '--', 'node', mcpPath];
  if (TOOL === 'claude') {
    // AIGILE_CLAUDE_BIN 給測試用假的 claude
    const bin = process.env.AIGILE_CLAUDE_BIN || '';
    const q = s => `"${String(s).replace(/"/g, '\\"')}"`;
    const claude = a => (/\.m?js$/i.test(bin) && fs.existsSync(bin) ? spawnSync(process.execPath, [bin, ...a], { encoding: 'utf8', timeout: 60_000 })
      : spawnSync([bin || 'claude', ...a].map(q).join(' '), { shell: true, encoding: 'utf8', timeout: 60_000 }));
    const manual = `claude ${addArgs.join(' ')}`;
    if (claude(['mcp', 'get', 'aigile']).status === 0) out('✓ MCP：Claude Code 已裝通用的 aigile（整台電腦一次，不重裝）');
    else {
      const r = claude(addArgs);
      if (r.status === 0) out('✓ MCP：已幫 Claude Code 裝好通用的 aigile（使用者範圍，整台電腦一次；新開的對話就有 mcp__aigile__* 工具）');
      else out(`! MCP 沒裝成（${String(r.stderr || r.stdout || r.error?.message || '').trim().split('\n').pop().slice(0, 120) || '找不到 claude 指令'}）：請自己執行 ${manual}`);
    }
    out(`  工具名稱 mcp__aigile__*；這個資料夾有多隻 AI 時先呼叫 aigile_use(${AGENT})（一個對話只能選一次）。舊的 aigile-${AGENT.toLowerCase()} 照樣能用`);
    // 舊的還在：同一個對話會看到兩套工具，講清楚現在用哪一套；舊的先不移除（要不要移除之後問所屬人類）
    const old = `aigile-${AGENT.toLowerCase()}`;
    if (claude(['mcp', 'get', old]).status === 0) out(`! 舊的 ${old} 也還在：同一個對話會看到 mcp__aigile__* 和 mcp__${old}__* 兩套，兩套都是你、功能一樣。從現在起用 mcp__aigile__*（新的）；舊的先不移除，要不要移除之後由所屬人類決定`);
    // Claude Code hook：寫在這個資料夾的 .claude/settings.local.json（不進 git、不動全機設定）
    if (cfg.files['aigile-hook.mjs']) {
      const sp = path.join('.claude', 'settings.local.json');
      let j = {}, ok = true;
      try { j = JSON.parse(fs.readFileSync(sp, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') ok = false; }
      if (!ok || typeof j !== 'object' || Array.isArray(j)) out(`! ${sp.replace(/\\/g, '/')} 不是合法的 JSON，沒有加 hook（/clear 後要自己貼接入設定）`);
      else {
        const hooks = j.hooks && typeof j.hooks === 'object' ? j.hooks : (j.hooks = {});
        let add = 0;
        const ensure = (event, matcher, mode) => {
          const list = Array.isArray(hooks[event]) ? hooks[event] : (hooks[event] = []);
          // 絕對路徑＋引號：從子資料夾開對話也找得到（不靠 $CLAUDE_PROJECT_DIR，Windows 的 hook 不一定經過 bash）；這個設定檔只在這台電腦、不進 git
          const cmd = `node "${path.resolve('.aigile', 'watcher', 'aigile-hook.mjs').replace(/\\/g, '/')}" ${mode}`;
          const mine = h => new RegExp(`aigile-hook\\.mjs"?\\s+${mode}\\b`).test(String(h.command || ''));
          const same = list.filter(g => (g.matcher || '') === (matcher || '') && (g.hooks || []).some(mine));
          if (same.length) { for (const g of same) for (const h of g.hooks) if (mine(h) && h.command !== cmd) { h.command = cmd; add++; } return; } // 舊的相對路徑換成絕對路徑
          list.push({ ...(matcher ? { matcher } : {}), hooks: [{ type: 'command', command: cmd, timeout: 30 }] });
          add++;
        };
        ensure('SessionStart', 'clear', 'session');
        ensure('SessionStart', 'compact', 'session');
        ensure('Stop', '', 'stop');
        if (add) { fs.mkdirSync('.claude', { recursive: true }); fs.writeFileSync(sp, JSON.stringify(j, null, 2) + '\n'); }
        out(`✓ hook：${sp.replace(/\\/g, '/')}${add ? ` 加了 ${add} 個` : ' 已有'}（/clear 後自動帶入重新接上；回合結束等待腳本不在會提醒一次）`);
      }
    }
  } else out(`  Claude Code → claude ${addArgs.join(' ')}`);
  // Codex 預設不把環境變數傳給 MCP 子程序，要 env_vars 才帶得到 AIGILE_AGENT（喚醒腳本會設）
  const codexManual = `  Codex → ~/.codex/config.toml 加 [mcp_servers.aigile]，command = "node"，args = ["${mcpPath}"]，env_vars = ["AIGILE_AGENT"]（整台電腦一個；env_vars 那行一定要有，Codex 預設不傳環境變數給 MCP；資料夾有多隻 AI 又沒帶 AIGILE_AGENT 時先呼叫 aigile_use）`;
  if (TOOL === 'codex') await codexMcp(mcpPath, codexManual); else out(codexManual);
  if (TOOL === 'copilot') copilotMcp(mcpPath);
  if (TOOL === 'antigravity') { antigravityMcp(mcpPath); antigravityWorkspace(); }
}

// Antigravity CLI 的全域 MCP 設定在 ~/.gemini/config/mcp_config.json（AIGILE_GEMINI_HOME 可隔離測試）。
// 先備份、已有 aigile 就不改、其他 MCP 原樣保留、壞 JSON 不碰；不寫 Token（agy 會把環境變數 AIGILE_AGENT／AIGILE_WAKE_AGENT 傳給 stdio MCP）。
function antigravityMcp(mcpPath) {
  const dir = path.join(process.env.AIGILE_GEMINI_HOME || process.env.AIGILE_TEST_GEMINI_HOME || path.join(os.homedir(), '.gemini'), 'config');
  const file = path.join(dir, 'mcp_config.json'), shown = file.replace(/\\/g, '/');
  const entry = { command: 'node', args: [mcpPath] };
  const manual = `  請自己在 ${shown} 的 mcpServers 加 "aigile": ${JSON.stringify(entry)}（或執行 agy mcp add aigile node "${mcpPath}"）`;
  let had = null; try { had = fs.readFileSync(file, 'utf8'); } catch (e) { if (e.code !== 'ENOENT') { out(`! MCP：讀不到 ${shown}（${e.code}）`); return out(manual); } }
  let j = {};
  if (had !== null && had.trim()) {
    try { j = JSON.parse(had); } catch { out(`! MCP：${shown} 不是合法的 JSON，沒有改它`); return out(manual); }
    const bad = v => !v || typeof v !== 'object' || Array.isArray(v);
    if (bad(j) || (j.mcpServers !== undefined && bad(j.mcpServers))) { out(`! MCP：${shown} 的格式看不懂（要有 mcpServers 物件），沒有改它`); return out(manual); }
  }
  if (j.mcpServers?.aigile) return out(`✓ MCP：Antigravity CLI 已有 aigile（${shown}，不改）`);
  j.mcpServers = { ...(j.mcpServers || {}), aigile: entry };
  const bak = had !== null ? `${file}.aigile-bak-${new Date().toISOString().replace(/[:.]/g, '-')}` : '';
  try {
    fs.mkdirSync(dir, { recursive: true });
    if (bak) fs.writeFileSync(bak, had);
    fs.writeFileSync(file, JSON.stringify(j, null, 2) + '\n');
  } catch (e) { try { if (had !== null) fs.writeFileSync(file, had); } catch {} out(`! MCP：寫不進 ${shown}（${e.code || e.message}）`); return out(manual); }
  out(`✓ MCP：已在 ${shown} 加好通用的 aigile${bak ? `，原檔備份在 ${bak.replace(/\\/g, '/')}` : ''}；其他 MCP 沒動，新開的 Antigravity CLI 就有 aigile 工具`);
}

// 放規則到 .agents/rules/aigile.md（不動使用者既有的 AGENTS.md 或其他規則）與前景狀態 hook 到 .agents/hooks.json
function antigravityWorkspace() {
  const ruleFile = path.join('.agents', 'rules', 'aigile.md');
  const marker = '<!-- aigile-managed -->';
  const ruleText = `${marker}\n# Aigile Collaboration Rules\n\n- Use the \`aigile\` MCP tools (\`aigile_me\`, \`aigile_inbox\`, \`aigile_read\`, \`aigile_card_get\`, \`aigile_post\`, \`aigile_ack\`, \`aigile_memory\`) for Aigile group collaboration.\n- Read your agent onboarding notes under \`.aigile/<AGENT>/onboarding.md\` and \`.aigile/<AGENT>/skills/*/SKILL.md\`. Never print or commit \`.aigile/\` tokens.\n- Never run \`git commit\`, \`git push\`, \`git merge\`, production DB migrations, deployments without owner approval, or delete data without explicit local owner consent.\n`;
  let curRule = null; try { curRule = fs.readFileSync(ruleFile, 'utf8'); } catch {}
  if (curRule === null || curRule.startsWith(marker)) {
    fs.mkdirSync(path.dirname(ruleFile), { recursive: true });
    fs.writeFileSync(ruleFile, ruleText);
    out(`✓ 規則：${ruleFile.replace(/\\/g, '/')}（不動既有的 AGENTS.md 與其他規則）`);
  } else {
    out(`! 規則：${ruleFile.replace(/\\/g, '/')} 已有使用者自訂內容，沒有覆蓋`);
  }
  if (!cfg.files['aigile-antigravity.mjs']) return;
  const hooksFile = path.join('.agents', 'hooks.json');
  let had = null; try { had = fs.readFileSync(hooksFile, 'utf8'); } catch (e) { if (e.code !== 'ENOENT') return out(`! hook：讀不到 ${hooksFile.replace(/\\/g, '/')}（${e.code}）`); }
  let j = {};
  if (had !== null && had.trim()) {
    try { j = JSON.parse(had); } catch { return out(`! hook：${hooksFile.replace(/\\/g, '/')} 不是合法的 JSON，沒有改它`); }
    if (!j || typeof j !== 'object' || Array.isArray(j)) return out(`! hook：${hooksFile.replace(/\\/g, '/')} 格式不是物件，沒有改它`);
  }
  const scriptAbs = path.resolve('.aigile', 'watcher', 'aigile-antigravity.mjs').replace(/\\/g, '/');
  const nextHook = {
    PreInvocation: [{ type: 'command', command: `node "${scriptAbs}" --hook busy`, timeout: 10 }],
    Stop: [{ type: 'command', command: `node "${scriptAbs}" --hook idle`, timeout: 10 }],
  };
  if (JSON.stringify(j['aigile-foreground']) !== JSON.stringify(nextHook)) {
    j['aigile-foreground'] = nextHook;
    fs.mkdirSync(path.dirname(hooksFile), { recursive: true });
    fs.writeFileSync(hooksFile, JSON.stringify(j, null, 2) + '\n');
    out(`✓ hook：${hooksFile.replace(/\\/g, '/')} 已設定 aigile-foreground（前景忙碌時 watcher 會等待空閒）`);
  } else {
    out(`✓ hook：${hooksFile.replace(/\\/g, '/')} 已有 aigile-foreground`);
  }
}

// Codex 也自動裝通用 MCP：~/.codex/config.toml 附加 [mcp_servers.aigile]。
// 已有就跳過；改之前先備份；只附加這一段、不動其他段落；改完用 codex mcp get aigile 驗證，失敗或寫不進去就還原備份、印設定請人貼。
// 沒開網路的沙盒設定只偵測、印清楚，不幫忙改。AIGILE_CODEX_BIN 給測試用假的 codex
async function codexMcp(mcpPath, manual) {
  const modulePath = path.resolve('.aigile', 'watcher', 'aigile-codex-ui.mjs');
  const { missingToolApprovals } = await import(pathToFileURL(modulePath).href);
  // AIGILE_TEST_CODEX_HOME：測試的保險（CODEX_HOME 被設成空字串時也不會落到真的 ~/.codex）；一般使用不會設
  const dir = process.env.CODEX_HOME || process.env.AIGILE_TEST_CODEX_HOME || path.join(os.homedir(), '.codex');
  const file = path.join(dir, 'config.toml');
  let had = null; try { had = fs.readFileSync(file, 'utf8'); } catch (e) { if (e.code !== 'ENOENT') { out(`! 讀不到 ${file}（${e.code}）：請自己加`); return out(manual + '\n' + missingToolApprovals('').missing.join('\n\n')); } }
  const net = had && /^\s*network_access\s*=\s*true\b/m.test(had);
  if (!net && !process.env.AIGILE_SETUP_QUIET_NET) out(`! Codex 網路：${file.replace(/\\/g, '/')} 沒看到 network_access = true。${CODEX_FIX}`);
  // Windows 沒設 Codex 沙盒（[windows] sandbox）時連資料夾裡的指令都會被擋：只印清楚，不幫忙改
  const winSandbox = had && /^\s*\[windows\]\s*$/m.test(had) && /^\s*sandbox\s*=/m.test(had.split(/^\s*\[windows\]\s*$/m)[1].split(/^\s*\[/m)[0]);
  if ((process.platform === 'win32' || process.env.AIGILE_SETUP_FAKE_WIN) && !winSandbox) out(`! Codex 沙盒（Windows）：${file.replace(/\\/g, '/')} 沒看到 [windows] 底下的 sandbox 設定，Codex 會連資料夾裡的指令都擋。請所屬人類在那個檔加 [windows] 與 sandbox = "elevated"（照 Codex 說明設定）後重開 Codex；接入檢查不會幫你改`);
  const section = /^[ \t]*\[mcp_servers\.aigile\][ \t]*(?:#.*)?\r?$/m;
  const existing = section.test(had || '');
  const serverBlock = `${had && !had.endsWith('\n') ? '\n' : ''}\n# aigile 接入檢查加的（整台電腦一個）\n[mcp_servers.aigile]\ncommand = "node"\nargs = ["${mcpPath}"]\nenv_vars = ["AIGILE_AGENT"]\n`;
  const update = missingToolApprovals((had || '') + (existing ? '' : serverBlock));
  if (existing && !update.missing.length) {
    out('✓ MCP：Codex 已有 [mcp_servers.aigile]（不改）');
    return;
  }
  manual += '\n' + update.missing.join('\n\n');
  if (existing) {
    const sectionBody = had.split(section)[1].split(/^\s*\[/m)[0];
    const command = /^\s*command\s*=\s*["']node["']\s*(?:#.*)?$/m;
    const args = /^\s*args\s*=\s*\[\s*"((?:\\.|[^"\\])*)"\s*\]\s*(?:#.*)?$/m.exec(sectionBody);
    let bridge; try { if (args) bridge = JSON.parse('"' + args[1] + '"'); } catch {}
    if (!command.test(sectionBody) || !bridge || path.resolve(bridge) !== path.resolve(mcpPath)) {
      out('! MCP：既有 aigile 使用自訂啟動設定，請先核對轉接程式，再補缺少的項目');
      return out(manual);
    }
    if (!/env_vars\s*=.*AIGILE_AGENT/.test(sectionBody)) out('! MCP：請在既有 aigile 段落核對 env_vars 是否含 AIGILE_AGENT');
  }
  if (had && (had.includes('"""') || had.includes("'''") || /^(?:[ \t]*)(?:["']?mcp_servers["']?\s*[.=]|\[\s*["']mcp_servers)/m.test(had))) {
    out('! MCP：請保留既有 TOML 自訂語法，手動比對以下缺項');
    return out(manual);
  }
  const bak = had !== null ? `${file}.aigile-bak-${new Date().toISOString().replace(/[:.]/g, '-')}` : '';
  function restore() {
    if (fs.readFileSync(file, 'utf8') !== update.config) throw Error('設定已被其他程序更新');
    if (had !== null) fs.writeFileSync(file, had);
    else fs.unlinkSync(file);
  }
  try {
    fs.mkdirSync(dir, { recursive: true });
    if (fs.existsSync(file) && (!fs.lstatSync(file).isFile() || fs.readFileSync(file, 'utf8') !== had)) {
      out('! MCP：設定位置或內容已改變，請核對後重跑接入檢查');
      return out(manual);
    }
    if (bak) fs.writeFileSync(bak, had, { flag: 'wx', mode: 0o600 });
    const pending = file + '.aigile-' + crypto.randomUUID();
    try {
      fs.writeFileSync(pending, update.config, { flag: 'wx', mode: had === null ? 0o600 : fs.statSync(file).mode });
      fs.renameSync(pending, file);
    } finally { fs.rmSync(pending, { force: true }); }
  } catch (e) { out(`! MCP：寫不進 ${file}（${e.code || e.message}）：請自己加`); return out(manual); }
  const bin = process.env.AIGILE_CODEX_BIN || process.env.CODEX_BIN || 'codex'; // 跟一行啟動、喚醒腳本同一個順序
  const binIsPath = fs.existsSync(bin);
  const r = /\.m?js$/i.test(bin) && fs.existsSync(bin) ? spawnSync(process.execPath, [bin, 'mcp', 'get', 'aigile'], { encoding: 'utf8', timeout: 60_000 })
    : process.platform === 'win32' || (!binIsPath && /\s/.test(bin))
      ? spawnSync(`${binIsPath ? `"${bin}"` : bin} mcp get aigile`, { shell: true, encoding: 'utf8', timeout: 60_000 })
      : spawnSync(bin, ['mcp', 'get', 'aigile'], { encoding: 'utf8', timeout: 60_000 });
  if (r.status === 0) return out(`✓ MCP：已在 ${file.replace(/\\/g, '/')} 加好通用的 aigile（含 env_vars）${bak ? `，原檔備份在 ${bak.replace(/\\/g, '/')}` : ''}；重開 Codex 後生效`);
  try { restore(); } catch (e) {
    out('! MCP：驗證失敗，無法還原設定：' + e.message + (bak ? '，原檔備份在 ' + bak : ''));
    return out(manual);
  }
  out(`! MCP：加了之後 codex mcp get aigile 驗證失敗（${String(r.stderr || r.stdout || r.error?.message || '').trim().split('\n').pop().slice(0, 120) || '找不到 codex 指令'}），已還原 ${file.replace(/\\/g, '/')}：這版 Codex 可能不認得這些設定，請自己加`);
  out(manual);
}
// Copilot CLI 的 MCP 設定是 JSON（~/.copilot/mcp-config.json，或 COPILOT_HOME 底下）。只加 mcpServers.aigile：
// 已有就不改；檔案不是合法 JSON 就不碰、印設定請人貼；改之前先備份，其他 MCP 原樣保留。
// AIGILE_AGENT 寫 ${AIGILE_AGENT}（Copilot CLI 啟動 MCP 時展開）：一行啟動會帶；沒帶時轉接腳本改看資料夾裡唯一的 Token 或 aigile_use
function copilotMcp(mcpPath) {
  // AIGILE_TEST_COPILOT_HOME：測試的保險（COPILOT_HOME 被設成空字串時也不會落到真的 ~/.copilot）；一般使用不會設
  const dir = process.env.COPILOT_HOME || process.env.AIGILE_TEST_COPILOT_HOME || path.join(os.homedir(), '.copilot');
  const file = path.join(dir, 'mcp-config.json'), shown = file.replace(/\\/g, '/');
  const entry = { type: 'local', command: 'node', args: [mcpPath], env: { AIGILE_AGENT: '${AIGILE_AGENT}' }, tools: ['*'] };
  const manual = `  請自己在 ${shown} 的 mcpServers 加 "aigile": ${JSON.stringify(entry)}`;
  let had = null; try { had = fs.readFileSync(file, 'utf8'); } catch (e) { if (e.code !== 'ENOENT') { out(`! MCP：讀不到 ${shown}（${e.code}）`); return out(manual); } }
  let j = {};
  if (had !== null && had.trim()) {
    try { j = JSON.parse(had); } catch { out(`! MCP：${shown} 不是合法的 JSON，沒有改它`); return out(manual); }
    const bad = v => !v || typeof v !== 'object' || Array.isArray(v);
    if (bad(j) || (j.mcpServers !== undefined && bad(j.mcpServers))) { out(`! MCP：${shown} 的格式看不懂（要有 mcpServers 物件），沒有改它`); return out(manual); }
  }
  const cur = j.mcpServers?.aigile;
  if (cur) return out(JSON.stringify(cur.env || {}).includes('AIGILE_AGENT') ? `✓ MCP：Copilot CLI 已有 aigile（${shown}，不改）`
    : `! MCP：Copilot CLI 已有 aigile，但 env 沒有 AIGILE_AGENT：請在那一段加 "env": { "AIGILE_AGENT": "\${AIGILE_AGENT}" }（沒有的話資料夾多隻 AI 時認不出你）`);
  j.mcpServers = { ...(j.mcpServers || {}), aigile: entry };
  const bak = had !== null ? `${file}.aigile-bak-${new Date().toISOString().replace(/[:.]/g, '-')}` : '';
  try {
    fs.mkdirSync(dir, { recursive: true });
    if (bak) fs.writeFileSync(bak, had);
    fs.writeFileSync(file, JSON.stringify(j, null, 2) + '\n');
  } catch (e) { try { if (had !== null) fs.writeFileSync(file, had); } catch {} out(`! MCP：寫不進 ${shown}（${e.code || e.message}）`); return out(manual); }
  out(`✓ MCP：已在 ${shown} 加好通用的 aigile${bak ? `，原檔備份在 ${bak.replace(/\\/g, '/')}` : ''}；其他 MCP 沒動，新開的 Copilot CLI 就有 aigile 工具`);
}
out(TOOL === 'copilot' ? '完成：接好後開 Copilot CLI 叫它（一行啟動會自動開）。' : '完成：照上面兩行啟動（要先取得所屬人類同意的就先問）。');
}
} catch (e) {
  if (!(e instanceof Done)) {
    // 同步技能時失敗：把失敗的那一行回報平台（主人的同步清單顯示，平台私訊主人）
    if (REPORT) await report('/api/me/skills/sync-status', { state: 'failed', lastLine: e instanceof Stop ? LAST : `腳本出錯：${e.message}`, tool: TOOL, setupSha: SELF_SHA });
    if (!(e instanceof Stop)) throw e;
    process.exitCode = 1;
  }
}
