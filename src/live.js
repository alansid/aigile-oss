// 內建即時通道（本機／Docker 版，node server.js）：不用 Supabase，伺服器用一條長連線（Server-Sent Events）把「有新東西」推給連著的成員
// - 只推「哪一類有變」與 ID，不推內容；網頁與 watcher 收到後再用自己的 Token 呼叫 API 拿資料（專案隔離由 API 照舊把關）
// - 誰收得到由呼叫端決定（core 只推給看得到那則訊息、那張卡的人；門鈴只推給要叫醒的 AI）
// - 連線數有上限（全站、每人）；每 25 秒送一行心跳；連太久（預設 1 小時）或寫不出去就關掉，用戶端自己重連
// - Cloudflare Workers 版沒有這條（每個請求可能在不同機器上，推不到彼此），照舊用 Supabase 或巡檢
export function createLiveHub({ maxConnections = 500, maxPerMember = 5, heartbeatMs = 25_000, maxAgeMs = 3600_000 } = {}) {
  const conns = new Map(); // id → { pid, kind, write, close, at }
  let seq = 0;
  const enc = new TextEncoder();
  const byMember = pid => [...conns.values()].filter(c => c.pid === pid);

  // 開一條連線：回傳 Response（text/event-stream）；超過上限回 null（呼叫端回 503／429）
  function open(me, { signal } = {}) {
    if (conns.size >= maxConnections) return { error: 'LIVE_FULL' };
    const mine = byMember(me.id);
    if (mine.length >= maxPerMember) mine.sort((a, b) => a.at - b.at)[0].close(); // 同一人開太多（例如很多分頁）：關掉最舊的
    const id = ++seq;
    let ctl, hb = null, age = null, closed = false;
    const close = () => {
      if (closed) return;
      closed = true; clearInterval(hb); clearTimeout(age); conns.delete(id);
      try { ctl.close(); } catch {}
    };
    const write = text => { if (closed) return false; try { ctl.enqueue(enc.encode(text)); return true; } catch { close(); return false; } };
    const stream = new ReadableStream({
      start(c) {
        ctl = c;
        write(`retry: 15000\nevent: hello\ndata: ${JSON.stringify({ at: new Date().toISOString() })}\n\n`);
        hb = setInterval(() => write(': hb\n\n'), heartbeatMs);
        age = setTimeout(() => { write('event: bye\ndata: {"reason":"max-age"}\n\n'); close(); }, maxAgeMs);
      },
      cancel: close,
    });
    signal?.addEventListener?.('abort', close);
    conns.set(id, { pid: me.id, kind: me.kind, write, close, at: Date.now() });
    return { response: new Response(stream, { headers: { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' } }) };
  }

  // 推給指定的成員（同一人多條連線都送）
  function toPeople(ids, type, data = {}) {
    const want = new Set(ids);
    if (!want.size) return 0;
    const line = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
    let n = 0;
    for (const c of [...conns.values()]) if (want.has(c.pid) && c.write(line)) n++;
    return n;
  }
  const connectedIds = () => [...new Set([...conns.values()].map(c => c.pid))];
  const closeAll = () => { for (const c of [...conns.values()]) c.close(); };
  return { open, toPeople, connectedIds, closeAll, size: () => conns.size, limits: { maxConnections, maxPerMember, heartbeatMs, maxAgeMs } };
}
