// 雲端 AI 呼叫模型用的 fetch（Node 版，server.js 用）：在「真的要連線」那一層檢查位址。
// 用 http(s).request 的 lookup：DNS 查到的每個 IP 都要過 addrRestricted，有一個是雲端 metadata（或 hosted 時的內網）就不連；
// 連線用的就是檢查過的那個 IP，不會被「檢查時是公網、連線時換成內網」（DNS rebinding）繞過。網址直接寫 IP 時 Node 不查 DNS，先自己檢查。
// Worker 不載入這支（沒有 node:http）。
import http from 'node:http';
import https from 'node:https';
import dns from 'node:dns';
import { addrRestricted, classifyHost, ModelError } from './cloud-ai.js';

export function nodeModelFetch({ hosted = false, resolve = dns.lookup } = {}) {
  const lookup = (host, opts, cb) => {
    resolve(host, { ...opts, all: true }, (err, list) => {
      if (err) return cb(err);
      const all = Array.isArray(list) ? list : [{ address: list, family: opts.family || 4 }];
      const bad = all.map(a => addrRestricted(a.address, { hosted })).find(Boolean);
      if (bad) return cb(Object.assign(new Error(bad), { code: 'EBLOCKED_ADDRESS' }));
      if (opts.all) return cb(null, all);
      cb(null, all[0].address, all[0].family);
    });
  };
  return (url, init = {}) => new Promise((ok, fail) => {
    const u = new URL(url);
    const c = classifyHost(u.hostname);
    if (c.ip) { const why = addrRestricted(c.host, { hosted }); if (why) return fail(new ModelError('blocked', 0, why)); }
    const mod = u.protocol === 'https:' ? https : http;
    // agent: false：不共用連線池，每次都重新查 DNS、重新檢查（共用的話會沿用別次檢查過的連線）
    const req = mod.request(u, { method: init.method || 'GET', headers: init.headers || {}, lookup, agent: false, signal: init.signal }, res => {
      const chunks = [];
      res.on('data', d => chunks.push(d));
      res.on('error', fail);
      res.on('end', () => {
        const noBody = [101, 204, 205, 304].includes(res.statusCode);
        ok(new Response(noBody ? null : Buffer.concat(chunks), { status: res.statusCode, headers: Object.entries(res.headers).filter(([, v]) => typeof v === 'string') }));
      });
    });
    req.on('error', e => fail(e.code === 'EBLOCKED_ADDRESS' ? new ModelError('blocked', 0, e.message) : e));
    req.end(init.body ?? undefined);
  });
}
