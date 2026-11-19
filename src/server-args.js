// npm start／node server.js 的啟動參數：埠號與要聽的位址
// 優先順序：命令列（-p／--port、--host）＞ 環境變數（PORT、HOST）＞ 預設（3000、所有網卡）
// 不合法就丟錯（呼叫端印說明並結束），不默默改用預設
import os from 'node:os';

export const SERVER_USAGE = `用法：npm start -- [-p 埠號] [--host 位址]
  -p, --port <埠號>   要聽的埠號（1～65535），也可以寫 --port=8080；沒給就看環境變數 PORT，再沒有用 3000
  --host <位址>       只聽這個位址（例 127.0.0.1＝只給這台電腦連），也可以寫 --host=127.0.0.1；沒給就看環境變數 HOST，再沒有就聽所有網卡
  --help              印這段說明
（用 npm start 時參數前面要多一個 --，例：npm start -- -p 8080；直接 node server.js -p 8080 不用）`;

export class ServerArgError extends Error {}

const portOf = (v, from) => {
  const s = String(v ?? '').trim();
  if (!/^\d+$/.test(s) || Number(s) < 1 || Number(s) > 65535) throw new ServerArgError(`${from} 的埠號「${s}」不對：要是 1～65535 的整數`);
  return Number(s);
};
const hostOf = (v, from) => {
  const s = String(v ?? '').trim();
  if (!s || /\s/.test(s) || s.startsWith('-')) throw new ServerArgError(`${from} 的位址「${s}」不對：例 127.0.0.1、0.0.0.0、::1 或主機名稱`);
  return s.replace(/^\[(.*)\]$/, '$1'); // [::1] 也收
};

export function parseServerArgs(argv = [], env = {}) {
  let port, host, help = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const eq = /^(--port|-p|--host)=(.*)$/.exec(a);
    const name = eq ? eq[1] : a, inline = eq ? eq[2] : undefined;
    const value = () => {
      if (inline !== undefined) return inline;
      if (i + 1 >= argv.length) throw new ServerArgError(`${name} 後面要接值`);
      return argv[++i];
    };
    if (name === '-p' || name === '--port') port = portOf(value(), name);
    else if (name === '--host') host = hostOf(value(), name);
    else if (name === '--help' || name === '-h') help = true;
    else throw new ServerArgError(`不認得的參數「${a}」`);
  }
  if (port === undefined) port = env.PORT !== undefined && env.PORT !== '' ? portOf(env.PORT, '環境變數 PORT') : 3000;
  if (host === undefined && env.HOST !== undefined && env.HOST !== '') host = hostOf(env.HOST, '環境變數 HOST');
  return { port, host: host ?? null, help };
}

const ANY = new Set(['0.0.0.0', '::', '']);
const urlHost = h => (h.includes(':') ? `[${h}]` : h);
// 啟動訊息：實際網址；聽所有網卡時列出這台的區網 IP，同網段的人可以用它連進來
export function startupLines(port, host, nets = os.networkInterfaces()) {
  const any = host === null || ANY.has(host);
  const lines = [`Aigile-Switch 已啟動：http://${any ? 'localhost' : urlHost(host)}:${port}`];
  if (any) {
    const ips = Object.values(nets).flat().filter(n => n && n.family === 'IPv4' && !n.internal).map(n => n.address);
    if (ips.length) lines.push(`同網段的其他電腦可以用：${ips.map(ip => `http://${ip}:${port}`).join('、')}（只給這台用：--host 127.0.0.1）`);
  }
  return lines;
}
