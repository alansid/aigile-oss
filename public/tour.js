// 聚光燈導覽：共用框架。自寫、沒有外部套件。
// 畫面變暗、只亮要按的那一塊，旁邊放說明和上一步／下一步。只框、只說明：不替使用者按、不送出、不動資料。
// 遮罩是「亮塊外框＋很大的陰影」，pointer-events: none，只擋視線、不攔點擊（使用者想試就自己按）。
// 用法（app.js）：AigileTour.start({ label, steps, onEnd })；AigileTour.notice({ text })；AigileTour.active()
// 語言：說明框上的字（label、title、text、tip、block 與按鈕）都先經過 aigileI18n.t 再畫，英文介面直接畫英文（量高度、放位置才準）；
//   中文原文要進 public/i18n/en.js（i18n-scan 會掃這個檔和 app.js）
// step：{ title, text, tip, go(), at(), prep(), find(), ready(), skip(), altIf(), alt: { find(), title, text, tip }, pause(), pauseTip, block() }
//   prep() 換好頁後把畫面展開到要框的樣子（例：打開頭像選單、展開某隻 AI 的接入分頁）：跟使用者自己點開一樣，不送出、不動資料
//   pause() 為真時（例：使用者自己打開的表單蓋住畫面）：拿掉遮罩、只留說明框在左下角，表單關掉再回到這一步
//   block() 回一句話時「下一步」先不能按，旁邊寫這句，另外給「結束」（例：還沒有 AI）
//   lock() 為真時「下一步」不能按、不給「結束」；skipLink 是說明框裡的跳過連結文字，按了到下一步（平台 PLAT-319：先走完新增 AI）
//   go()   換頁（只換頁、不動資料）；at() 現在是不是在這一步的頁面（使用者自己點到別頁就結束）
//   find() 回要框的元素（或元素陣列，框住它們的聯集）；最多等 3 秒，找不到就用 alt 改成說明，不默默跳過
//   altIf() 元素找得到、但要改說法（例如 0 件）；skip() 沒權限看那一頁就跳過，進度照算
//   sub：{ open(), enter(), after(), note(), label, steps } 主路線某一步底下的「小步」（平台 PLAT-316：使用者自己打開的表單裡一欄一欄帶）
//     open() 為真就進小步、為假就離開：after() 回要接的主路線步驟（例：建好了 → 下一步），沒回就回到原本那一步
//     note() 回 { text, find() } 時改成只放說明、不加亮塊（例：建好後跳出的視窗：先關掉它，導覽再接下一步）
//     小步：{ title, text, tip, find(), prep(), skip(), clip(), sides, popW }；第 1 小步沒有上一步、最後一小步「下一步」不能按
//     clip() 回捲動的容器：欄位捲出容器就先藏亮塊、說明框留著；sides 說明框放哪邊的優先順序；popW 說明框寬
//     小步裡 Esc 交給表單（關表單＝回主路線那一步）；說明框的 × 結束導覽，表單留著（reason 'keep'）
(() => {
  const MIN_W = 1000, WAIT_MS = 3000, PAD = 6, GAP = 14, POP_W = 320;
  let cur = null; // 進行中的導覽
  const tt = s => (window.aigileI18n?.t ? window.aigileI18n.t(s) : String(s ?? '')); // 照介面語言翻（中文介面原樣）

  const el = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; };
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const shown = e => !!e && e.isConnected && e.getClientRects().length > 0 && e.getBoundingClientRect().width > 0;
  const list = x => (Array.isArray(x) ? x : [x]).filter(shown);
  const wide = () => window.innerWidth >= MIN_W; // 跟 CSS 的 min-width: 1000px 同一把尺
  // 實際看得到的範圍：不含捲軸（innerWidth 會把捲軸算進去，亮塊貼右邊時白框就被捲軸蓋掉）
  const vp = () => ({ w: document.documentElement.clientWidth || window.innerWidth, h: document.documentElement.clientHeight || window.innerHeight });
  const EDGE = 6; // 亮塊離畫面邊至少 6px：3px 白框＋3px 空隙，四邊都看得到

  // 亮塊範圍：幾個元素的聯集，四周留 6px；夾在畫面內，貼邊的區塊白框也完整
  function rectOf(els) {
    const rs = els.map(e => e.getBoundingClientRect()), { w, h } = vp();
    const l = Math.max(EDGE, Math.min(...rs.map(r => r.left)) - PAD), t = Math.max(EDGE, Math.min(...rs.map(r => r.top)) - PAD);
    const r = Math.min(w - EDGE, Math.max(...rs.map(r => r.right)) + PAD), b = Math.min(h - EDGE, Math.max(...rs.map(r => r.bottom)) + PAD);
    return { left: l, top: t, width: Math.max(0, r - l), height: Math.max(0, b - t) };
  }
  // ready()：頁面已經畫好（例如訊息已載入但沒有卡）就不用等滿 3 秒，直接改成說明
  async function waitFind(fn, ms, ready) {
    const end = Date.now() + ms;
    for (;;) {
      let got = [];
      try { got = list(fn?.() || []); } catch {}
      let done = false;
      try { done = !!ready?.(); } catch {}
      if (got.length || done || Date.now() >= end) return got;
      await sleep(100);
    }
  }

  function build() {
    const hole = el('div', 'tour-hole'); hole.setAttribute('aria-hidden', 'true');
    const pop = el('div', 'tour-pop'); pop.setAttribute('role', 'dialog'); pop.setAttribute('aria-modal', 'false'); pop.setAttribute('aria-labelledby', 'tour-title');
    document.body.append(hole, pop);
    return { hole, pop };
  }

  // 說明框放在亮塊的下、上、右、左（空間夠的第一個），再夾進畫面內；小箭頭指向亮塊
  function place(pop, box, sides = ['bottom', 'top', 'right', 'left']) {
    const { w: vw, h: vh } = vp(), ph = pop.offsetHeight, pw = pop.offsetWidth || POP_W;
    pop.classList.remove('at-top', 'at-bottom', 'at-left', 'at-right', 'at-center');
    if (!box) { pop.style.left = `${Math.round((vw - pw) / 2)}px`; pop.style.top = `${Math.round((vh - ph) / 2)}px`; pop.classList.add('at-center'); return; }
    const room = { bottom: vh - (box.top + box.height), top: box.top, right: vw - (box.left + box.width), left: box.left };
    const side = sides.find(s => (s === 'bottom' || s === 'top' ? room[s] >= ph + GAP + 8 : room[s] >= pw + GAP + 8))
      || (room.top > room.bottom ? 'top' : 'bottom');
    const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
    let x, y;
    if (side === 'bottom' || side === 'top') {
      x = clamp(box.left + box.width / 2 - pw / 2, 8, vw - pw - 8);
      y = side === 'bottom' ? box.top + box.height + GAP : box.top - ph - GAP;
      y = clamp(y, 8, vh - ph - 8);
      pop.style.setProperty('--ax', `${clamp(box.left + box.width / 2 - x, 18, pw - 18)}px`);
    } else {
      y = clamp(box.top + box.height / 2 - ph / 2, 8, vh - ph - 8);
      x = side === 'right' ? box.left + box.width + GAP : box.left - pw - GAP;
      pop.style.setProperty('--ay', `${clamp(box.top + box.height / 2 - y, 18, ph - 18)}px`);
    }
    pop.style.left = `${Math.round(x)}px`; pop.style.top = `${Math.round(y)}px`;
    pop.classList.add(`at-${side}`);
  }

  // 亮塊夾進捲動容器看得到的範圍；整個捲出去回 null
  function clipTo(b, box) {
    if (!box) return b;
    const c = box.getBoundingClientRect();
    const l = Math.max(b.left, c.left), t = Math.max(b.top, c.top), r = Math.min(b.left + b.width, c.right), bt = Math.min(b.top + b.height, c.bottom);
    return r - l < 8 || bt - t < 8 ? null : { left: l, top: t, width: r - l, height: bt - t };
  }
  function paint() {
    if (!cur || cur.paused) return;
    const { hole, pop } = cur.ui, v = cur.view || {};
    const els = cur.els && list(cur.els);
    if (els && els.length) {
      const b = clipTo(rectOf(els), v.clip?.());
      if (!b) { hole.style.visibility = 'hidden'; return; } // 欄位捲出表單：先藏亮塊，說明框留在原處
      hole.style.visibility = v.noHole ? 'hidden' : ''; // noHole：只放說明框在旁邊，不加亮塊
      Object.assign(hole.style, { left: `${b.left}px`, top: `${b.top}px`, width: `${b.width}px`, height: `${b.height}px` });
      hole.classList.remove('no-target');
      place(pop, b, v.sides);
    } else {
      hole.classList.add('no-target'); // 沒有東西可框：整片變暗，說明框置中
      place(pop, null);
    }
  }

  // 「下一步」不能按（block）時不放灰底提示，避免同時寫「已經有 AI 可以直接按下一步」
  // view.meta／n／idx／prev／nextLabel／lock（小步用：最後一小步「下一步」不能按、不給「結束」）
  function render(i, view) {
    const { pop } = cur.ui, n = view.n ?? cur.steps.length, idx = view.idx ?? i, last = idx === n - 1;
    const hasPrev = view.prev ?? i > 0, lock = !!view.block || !!view.lock;
    const dots = Array.from({ length: n }, (_, k) => `<i class="${k === idx ? 'on' : k < idx ? 'done' : ''}"></i>`).join('');
    pop.innerHTML = `<button type="button" class="tour-x" data-tour="close" aria-label="${esc(tt('結束導覽'))}" title="${esc(tt(cur.sub ? '結束導覽' : '結束導覽（Esc）'))}">×</button>
      <div class="tour-meta">${esc(view.meta ?? `${tt(cur.label)} · ${i + 1} / ${n}`)}</div>
      <h3 class="tour-title" id="tour-title">${esc(tt(view.title))}</h3>
      <p class="tour-text">${esc(tt(view.text))}</p>
      ${view.tip && !view.block ? `<p class="tour-tip">${esc(tt(view.tip))}</p>` : ''}
      ${view.block ? `<p class="tour-block">${esc(tt(view.block))}</p>` : ''}
      ${view.skipText && !view.block ? `<p class="tour-skipline"><button type="button" class="link small" data-tour="skip">${esc(tt(view.skipText))}</button></p>` : ''}
      <div class="tour-foot"><span class="tour-dots" aria-label="${esc(tt(`第 ${idx + 1} 步，共 ${n} 步`))}">${dots}</span><span class="tour-grow"></span>
        ${hasPrev ? `<button type="button" class="btn small" data-tour="prev">${esc(tt('上一步'))}</button>` : ''}
        ${view.block ? `<button type="button" class="btn small" data-tour="close">${esc(tt('結束'))}</button>` : ''}
        <button type="button" class="btn small primary" data-tour="next"${lock ? ' disabled' : ''}>${esc(tt(view.nextLabel ?? (last ? '完成' : '下一步')))}</button></div>`;
    cur.els = view.els; cur.view = view; cur.blocked = lock; cur.paused = false;
    cur.ui.hole.style.display = ''; cur.ui.hole.style.visibility = ''; pop.classList.remove('paused');
    pop.style.width = view.popW ? `${view.popW}px` : '';
    const first = view.els && list(view.els)[0];
    if (first && !view.clip && !view.noHole) { const r = first.getBoundingClientRect(); if (r.top < 0 || r.bottom > vp().h) first.scrollIntoView({ block: 'center' }); }
    paint();
    // 打開時焦點在「下一步」；不能按時放「結束」，有跳過連結放連結，小步最後一步放「上一步」
    (pop.querySelector(view.block ? '.tour-foot [data-tour="close"]' : lock ? '[data-tour="skip"], [data-tour="prev"]' : '[data-tour="next"]') || pop.querySelector('.tour-x')).focus({ preventScroll: true });
  }

  // 小步：表單裡一欄一欄帶。meta 寫「第 1 章 · 第 2 步 › 表單 · N / 4」
  async function showSub(j, dir = 1) {
    if (!cur?.sub) return;
    const me = cur, sub = me.steps[me.i].sub, n = sub.steps.length;
    const meta = k => `${tt(me.label.split('　')[0])} · ${tt(`第 ${me.i + 1} 步`)} › ${tt(sub.label)} · ${k + 1} / ${n}`;
    me.sub.j = j; me.busy = true;
    try {
      const note = sub.note?.();
      me.sub.note = !!note;
      if (note) { // 例：建好後跳出的視窗：說明框放旁邊、不加亮塊，關掉視窗再接下一步
        const box = note.find?.();
        render(me.i, { title: note.title || '', text: note.text, els: box ? [box] : [], noHole: true, sides: sub.steps[j].sides, popW: sub.steps[j].popW,
          meta: meta(j), n, idx: j, prev: false, nextLabel: '下一步', lock: true });
        return;
      }
      const s = sub.steps[j];
      await s.prep?.();
      if (cur !== me || !me.sub) return;
      if (s.skip?.()) { const k = j + dir; if (k >= 0 && k < n) return showSub(k, dir); }
      const els = await waitFind(s.find, 1500);
      if (cur !== me || !me.sub) return;
      render(me.i, { title: s.title, text: s.text, tip: s.tip, els, clip: s.clip, sides: s.sides, popW: s.popW,
        meta: meta(j), n, idx: j, prev: j > 0, nextLabel: '下一步', lock: j === n - 1 });
    } finally { if (cur === me) me.busy = false; }
  }
  function enterSub() { cur.sub = { j: 0 }; cur.steps[cur.i].sub.enter?.(); return showSub(0); }
  function leaveSub() { // 表單關掉：建好了接 after() 給的那一步，沒建就回原本那一步
    const to = cur.steps[cur.i].sub.after?.();
    cur.sub = null;
    return show(Number.isInteger(to) ? to : cur.i);
  }

  async function show(i, dir = 1) {
    if (!cur) return;
    const me = cur, step = me.steps[i];
    let inSub = false;
    me.i = i; me.busy = true;
    try {
      if (step.at && !step.at()) await step.go?.(); // 下一步要到別頁：直接帶過去（只換頁、不動資料）
      if (cur !== me) return;
      await step.prep?.();
      if (cur !== me) return;
      if (step.skip?.()) { // 沒權限看那一頁：跳過這一步，進度照算
        const j = i + dir;
        if (j < 0 || j >= me.steps.length) return end(dir > 0 ? 'done' : 'close');
        return show(j, dir);
      }
      me.ui.pop.classList.add('loading');
      let els = await waitFind(step.find, step.wait ?? WAIT_MS, step.ready); // 元素還在載入：最多等 3 秒
      if (cur !== me) return;
      me.ui.pop.classList.remove('loading');
      let view = { title: step.title, text: step.text, tip: step.tip, els, block: step.block?.() || '', lock: !!step.lock?.(), skipText: step.skipLink || '' };
      const useAlt = step.alt && (!els.length || step.altIf?.());
      if (useAlt) { // 找不到或是空的：能框別的就框別的，再把說明改成「現在是空的，之後會出現在這裡」
        const a = step.alt;
        const altEls = els.length && !a.find ? els : await waitFind(a.find, 500);
        view = { ...view, title: a.title || step.title, text: a.text, tip: a.tip ?? step.tip, els: altEls };
      }
      if (step.sub?.open()) inSub = true; // 到這一步時表單已經開著：直接進小步
      else render(i, view);
    } finally { if (cur === me) me.busy = false; }
    if (inSub && cur === me) return enterSub();
  }

  // 跟著頁面捲動、縮放重畫；使用者自己點到別頁就結束（點到下一步的頁面就接著走）
  function tick() {
    if (!cur || cur.busy) return;
    if (!wide()) return end('narrow');
    const step = cur.steps[cur.i];
    if (step.sub) {
      const open = !!step.sub.open();
      if (open && !cur.sub) return enterSub();
      if (!open && cur.sub) return leaveSub();
      if (cur.sub) {
        const redo = () => { cur.busy = true; const me = cur; Promise.resolve(showSub(cur.sub.j)).finally(() => { if (cur === me) me.busy = false; }); };
        if (!!step.sub.note?.() !== !!cur.sub.note) return redo(); // 建好後的視窗出現／關掉
        if (!cur.sub.note && cur.els && !list(cur.els).length) return redo();
        return paint();
      }
    }
    const paused = !!step.pause?.();
    if (paused && !cur.paused) return pause();
    if (!paused && cur.paused) return show(cur.i); // 表單關掉：回到這一步（重新找、重新判斷能不能下一步）
    if (paused) return;
    if (step.at && !step.at()) {
      const nx = cur.steps[cur.i + 1];
      if (nx?.at?.()) return show(cur.i + 1);
      return end('left');
    }
    if ((step.block || step.lock) && !!(step.block?.() || step.lock?.()) !== cur.blocked) return show(cur.i); // 例：剛建好 AI，「下一步」可以按了
    if (step.block && step.lock && !!step.block?.() !== !!cur.view?.block) return show(cur.i); // 停用的理由換了（沒有 AI ↔ 有 AI）：重畫說明
    if (cur.els && !list(cur.els).length) { // 元素被重畫掉了：重新找
      cur.busy = true;
      const me = cur;
      Promise.resolve(show(cur.i)).finally(() => { if (cur === me) me.busy = false; });
      return;
    }
    paint();
  }

  // 暫停：拿掉遮罩，說明框移到左下角（不擋表單），上一步／下一步先不能按
  function pause() {
    const { hole, pop } = cur.ui;
    cur.paused = true;
    hole.style.display = 'none';
    pop.classList.remove('at-top', 'at-bottom', 'at-left', 'at-right', 'at-center');
    pop.classList.add('paused');
    // 暫停時灰底換成 pauseTip（例如「表單關掉後就能繼續」），不留「可以直接按下一步」這類跟停用按鈕矛盾的話；恢復時 show() 重畫回原文
    const pt = cur.steps[cur.i]?.pauseTip;
    if (pt) {
      pop.querySelectorAll('.tour-tip,.tour-block').forEach(el => el.remove());
      const el = document.createElement('p'); el.className = 'tour-tip'; el.textContent = tt(pt);
      pop.querySelector('.tour-foot').before(el);
    }
    pop.style.left = '16px'; pop.style.top = `${Math.max(8, vp().h - pop.offsetHeight - 16)}px`;
    pop.querySelectorAll('[data-tour="next"],[data-tour="prev"]').forEach(b => { b.disabled = true; });
  }

  function onKey(e) {
    if (!cur || cur.paused) return; // 暫停時鍵盤留給表單（Esc 關表單）
    if (cur.sub && e.key === 'Escape') return; // 小步：Esc 交給表單（關表單＝回主路線那一步）
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); return end('close'); }
    const t = e.target, typing = t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
    if (typing || cur.busy) return; // 使用者在訊息框打字時，方向鍵照常移游標
    if (e.key === 'ArrowRight') { e.preventDefault(); next(); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); prev(); }
  }
  // 點在說明框裡由導覽自己處理，不再往頁面傳。按「上一步」回第 1 步會打開頭像選單，接著說明框重畫、被點的按鈕已不在畫面上，
  // 頁面「點選單外就關選單」認不出它原本在說明框裡，就把剛打開的選單關掉，導覽又跳回第 2 步（平台 PLAT-313）
  function onClick(e) {
    if (cur && cur.ui.pop.contains(e.target)) e.stopPropagation();
    const b = e.target.closest?.('[data-tour]');
    if (!b || !cur || !cur.ui.pop.contains(b)) return;
    const a = b.dataset.tour;
    if (a === 'close') return end(cur.sub ? 'keep' : 'close'); // 小步裡按 ×：導覽結束，表單留著讓使用者自己填完
    if (cur.busy || cur.paused) return;
    if (a === 'next') return next();
    if (a === 'prev') return prev();
    if (a === 'skip' && !cur.sub) return show(cur.i + 1, 1); // 「已經有 AI 了，跳過這步」
  }
  function next() {
    if (cur.blocked || cur.paused) return;
    if (cur.sub) return showSub(cur.sub.j + 1, 1);
    if (cur.i >= cur.steps.length - 1) return end('done');
    return show(cur.i + 1, 1);
  }
  function prev() {
    if (cur.sub) return cur.sub.j > 0 && !cur.sub.note ? showSub(cur.sub.j - 1, -1) : undefined;
    if (cur.i > 0) return show(cur.i - 1, -1);
  }

  function end(reason) {
    if (!cur) return;
    const me = cur; cur = null;
    clearInterval(me.timer);
    window.removeEventListener('resize', tick);
    window.removeEventListener('scroll', paint, true);
    document.removeEventListener('keydown', onKey, true);
    document.removeEventListener('click', onClick, true);
    me.ui.hole.remove(); me.ui.pop.remove(); // 不留遮罩
    try { me.onEnd?.(reason); } catch {}
  }

  function start({ label, steps, onEnd }) {
    if (!wide() || !steps?.length) return false; // 只在寬 ≥1000 出現
    if (cur) end('restart');
    cur = { label, steps, onEnd, i: 0, els: null, sub: null, busy: false, ui: build() };
    window.addEventListener('resize', tick);
    window.addEventListener('scroll', paint, true);
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('click', onClick, true);
    cur.timer = setInterval(tick, 300);
    show(0);
    return true;
  }

  // 沒辦法開始時的說明（例：還沒加入專案）：只有一個「知道了」
  function notice({ text, button = '知道了' }) {
    if (cur) end('restart');
    const { hole, pop } = build();
    hole.classList.add('no-target');
    pop.innerHTML = `<p class="tour-text" id="tour-title">${esc(tt(text))}</p><div class="tour-foot"><span class="tour-grow"></span><button type="button" class="btn small primary" data-tour-ok>${esc(tt(button))}</button></div>`;
    place(pop, null);
    const close = () => { hole.remove(); pop.remove(); document.removeEventListener('keydown', key, true); };
    const key = e => { if (e.key === 'Escape' || e.key === 'Enter') { e.preventDefault(); close(); } };
    pop.querySelector('[data-tour-ok]').addEventListener('click', close);
    document.addEventListener('keydown', key, true);
    pop.querySelector('[data-tour-ok]').focus();
  }

  window.AigileTour = { start, notice, end: () => end('close'), active: () => !!cur, MIN_W };
})();
