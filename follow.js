// ================= 👥 Following: watch any Solana wallet's trades =================
// Follow traders by wallet address, see their buys and sells live, rank them by profit,
// and copy a buy with one tap. Runs after trade.html's main script and reuses its helpers
// (rpc, pairsFor, quickBuy, openToken, riskCache, scanRisks, openSheetHTML, gt, gtPoolFor).
// Everything is stored on this device only.

const FOLLOW_BACKFILL = 15;       // recent transactions read per wallet when it's first followed
const FOLLOW_CACHE_MAX = 800;     // parsed trades kept on this device
const STABLES = new Set(["EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB"]);

let followTab = ls("followtab", "feed"), followWs = null, followSubs = {}, followPending = {}, followReq = 0, followRetry = 0;
let followBusy = 0, followQueue = [], followLoading = new Set();

function follows(){ return lsJSON("follows", []); }
function saveFollows(f){ lsSet("follows", JSON.stringify(f)); }
function isFollowing(addr){ return follows().some(f => f.addr === addr); }
function followName(addr){ return follows().find(f => f.addr === addr)?.name || short(addr); }
function tradeCache(){ return lsJSON("ftrades", {}); }   // sig -> trade, or sig -> 0 for non-trades
function saveTradeCache(c){
  const keys = Object.keys(c);
  if(keys.length > FOLLOW_CACHE_MAX){ keys.sort((a, b) => (c[a]?.ts || 0) - (c[b]?.ts || 0)).slice(0, keys.length - FOLLOW_CACHE_MAX).forEach(k => delete c[k]); }
  lsSet("ftrades", JSON.stringify(c));
}
function walletTrades(addr){ return Object.values(tradeCache()).filter(t => t && t.w === addr).sort((a, b) => b.ts - a.ts); }
function allTrades(){ const set = new Set(follows().map(f => f.addr)); return Object.values(tradeCache()).filter(t => t && set.has(t.w)).sort((a, b) => b.ts - a.ts); }

// ---------- Reading a wallet's swaps from the chain ----------
// Works for any DEX (pump.fun, PumpSwap, Raydium, Jupiter…): compares the wallet's SOL and token
// balances before and after the transaction. One coin up and SOL down is a buy; the reverse is a sell.
async function parseSwap(sig, owner){
  const tx = await rpc("getTransaction", [sig, {encoding:"jsonParsed", maxSupportedTransactionVersion:0, commitment:"confirmed"}]);
  if(!tx) return undefined;                                  // not visible yet
  if(tx.meta?.err) return null;
  const keys = tx.transaction.message.accountKeys.map(k => k.pubkey || k);
  const i = keys.indexOf(owner);
  let sol = i >= 0 ? BigInt(tx.meta.postBalances[i]) - BigInt(tx.meta.preBalances[i]) : 0n;
  if(i === 0) sol += BigInt(tx.meta.fee || 0);               // leave out the network fee
  const d = {}, dec = {};
  const add = (b, sign) => { if(b.owner !== owner) return; d[b.mint] = (d[b.mint] || 0n) + sign * BigInt(b.uiTokenAmount.amount); dec[b.mint] = b.uiTokenAmount.decimals; };
  (tx.meta.preTokenBalances || []).forEach(b => add(b, -1n));
  (tx.meta.postTokenBalances || []).forEach(b => add(b, 1n));
  if(d[SOL_MINT]){ sol += d[SOL_MINT]; delete d[SOL_MINT]; }
  const moved = Object.entries(d).filter(([m, v]) => v !== 0n && !STABLES.has(m));
  if(!moved.length || sol === 0n) return null;
  moved.sort((a, b) => (a[1] < 0n ? -a[1] : a[1]) > (b[1] < 0n ? -b[1] : b[1]) ? -1 : 1);
  const [mint, tok] = moved[0];
  const isBuy = tok > 0n;
  if(isBuy !== (sol < 0n)) return null;                      // a transfer or airdrop, not a swap
  return { sig, w: owner, mint, isBuy, sol: Number(sol < 0n ? -sol : sol), tok: (tok < 0n ? -tok : tok).toString(), dec: dec[mint], ts: (tx.blockTime || Date.now() / 1000) * 1000 };
}
function queueSig(sig, owner, live){
  const c = tradeCache(); if(sig in c) return;
  followQueue.push({sig, owner, live, tries: 0}); pumpFollowQueue();
}
function pumpFollowQueue(){
  while(followBusy < 2 && followQueue.length){
    const job = followQueue.shift(); followBusy++;
    parseSwap(job.sig, job.owner).then(t => {
      if(t === undefined && job.tries < 4){ job.tries++; setTimeout(() => { followQueue.push(job); pumpFollowQueue(); }, 1500); return; }
      const c = tradeCache(); c[job.sig] = t || 0; saveTradeCache(c);
      if(t){ if(job.live) onFollowTrade(t); scheduleFollowRender(); }
    }).catch(() => { if(job.tries < 2){ job.tries++; setTimeout(() => { followQueue.push(job); pumpFollowQueue(); }, 3000); } })
      .finally(() => { followBusy--; setTimeout(pumpFollowQueue, 250); });
  }
}
async function backfill(addr){
  if(followLoading.has(addr)) return;
  followLoading.add(addr); scheduleFollowRender();
  try{
    const sigs = await rpc("getSignaturesForAddress", [addr, {limit: FOLLOW_BACKFILL, commitment:"confirmed"}]);
    sigs.filter(s => !s.err).forEach(s => queueSig(s.signature, addr, false));
  }catch{ toast("Couldn't read that wallet right now. Try again in a moment."); }
  finally{ followLoading.delete(addr); scheduleFollowRender(); }
}

// ---------- Live: a websocket subscription per followed wallet ----------
function followWsConnect(){
  if(!follows().length || (followWs && followWs.readyState <= 1)) return;
  try{ followWs = new WebSocket(cfg.rpc.replace(/^http/, "ws")); }catch{ followWs = null; return; }
  followWs.onopen = () => { followRetry = 0; follows().forEach(f => followSubscribe(f.addr)); };
  followWs.onmessage = e => {
    let m; try{ m = JSON.parse(e.data); }catch{ return; }
    if(m.id != null && followPending[m.id]){ followPending[m.id](m.result); delete followPending[m.id]; return; }
    if(m.method === "logsNotification"){
      const addr = followSubs[m.params?.subscription], v = m.params?.result?.value;
      if(addr && v && !v.err && v.signature) queueSig(v.signature, addr, true);
    }
  };
  followWs.onclose = () => { followSubs = {}; followPending = {}; if(follows().length) setTimeout(followWsConnect, Math.min(30000, 1000 * 2 ** followRetry++)); };
  followWs.onerror = () => {};
}
function followSend(method, params){
  return new Promise(res => { const id = ++followReq; followPending[id] = res;
    try{ followWs.send(JSON.stringify({jsonrpc:"2.0", id, method, params})); }catch{ delete followPending[id]; res(null); } });
}
async function followSubscribe(addr){
  if(!followWs || followWs.readyState !== 1 || Object.values(followSubs).includes(addr)) return;
  const id = await followSend("logsSubscribe", [{mentions:[addr]}, {commitment:"confirmed"}]);
  if(id != null) followSubs[id] = addr;
}
function followUnsubscribe(addr){
  for(const [id, a] of Object.entries(followSubs)) if(a === addr){
    try{ followWs.send(JSON.stringify({jsonrpc:"2.0", id:++followReq, method:"logsUnsubscribe", params:[Number(id)]})); }catch{}
    delete followSubs[id];
  }
}

// ---------- Following, alerts ----------
function followWallet(addr, name){
  addr = String(addr || "").trim();
  if(!isMint(addr)){ toast("That doesn't look like a Solana wallet address"); return false; }
  if(wallet && addr === wallet){ toast("That's your own wallet. Your trades are in Holdings."); return false; }
  const f = follows();
  if(f.some(x => x.addr === addr)){ toast("You already follow " + followName(addr)); return false; }
  f.push({addr, name: String(name || "").trim().slice(0, 24), added: Date.now(), alerts: true}); saveFollows(f);
  toast("👥 Following " + (name || short(addr)));
  if(followWs && followWs.readyState === 1) followSubscribe(addr); else followWsConnect();
  backfill(addr); scheduleFollowRender();
  return true;
}
function unfollowWallet(addr){
  saveFollows(follows().filter(f => f.addr !== addr)); followUnsubscribe(addr);
  toast("Unfollowed " + short(addr)); closeSheet(); scheduleFollowRender();
}
function renameWallet(addr){
  const n = prompt("Name this wallet", followName(addr) === short(addr) ? "" : followName(addr));
  if(n === null) return;
  saveFollows(follows().map(f => f.addr === addr ? {...f, name: n.trim().slice(0, 24)} : f));
  openWallet(addr); scheduleFollowRender();
}
function toggleWalletAlerts(addr){
  saveFollows(follows().map(f => f.addr === addr ? {...f, alerts: !f.alerts} : f));
  const on = follows().find(f => f.addr === addr)?.alerts;
  if(on) askNotify();
  toast(on ? "🔔 Alerts on for " + followName(addr) : "🔕 Alerts off for " + followName(addr)); openWallet(addr);
}
function askNotify(){ try{ if(window.Notification && Notification.permission === "default") Notification.requestPermission(); }catch{} }
async function onFollowTrade(t){
  const f = follows().find(x => x.addr === t.w); if(!f) return;
  scanRisks([t.mint]);
  if(!pairCache[t.mint]) await pairsFor([t.mint]).catch(() => {});
  if(!f.alerts) return;
  const sym = pairCache[t.mint]?.baseToken?.symbol || short(t.mint);
  const msg = `${followName(t.w)} ${t.isBuy ? "bought" : "sold"} ${fmtSol(t.sol)} SOL of $${sym}`;
  toast((t.isBuy ? "🟢 " : "🔴 ") + msg, 4000);
  try{ if(document.hidden && window.Notification && Notification.permission === "granted") new Notification("Bulled", {body: msg, icon: "icons/icon-192.png", tag: t.sig}); }catch{}
}

// ---------- Profit and loss from the trades Bulled has seen ----------
function walletStats(addr){
  const by = {};
  for(const t of walletTrades(addr)){
    const m = by[t.mint] || (by[t.mint] = {mint: t.mint, in: 0, out: 0, bought: 0n, sold: 0n, dec: t.dec, buys: 0, sells: 0, last: 0});
    if(t.isBuy){ m.in += t.sol; m.bought += BigInt(t.tok); m.buys++; } else { m.out += t.sol; m.sold += BigInt(t.tok); m.sells++; }
    m.last = Math.max(m.last, t.ts);
  }
  let pnlSol = 0, wins = 0, counted = 0, volSol = 0;
  const coins = Object.values(by).map(m => {
    volSol += m.in + m.out;
    if(!m.buys || m.sold > m.bought) return {...m, pnl: null};   // bought before Bulled started watching: cost unknown
    const left = Number(m.bought - m.sold) / 10 ** (m.dec || 6), px = Number(pairCache[m.mint]?.priceUsd || 0);
    const heldSol = SOL_USD ? left * px / SOL_USD * 1e9 : 0;
    const pnl = m.out + heldSol - m.in;
    pnlSol += pnl; counted++; if(pnl > 0) wins++;
    return {...m, pnl, heldSol};
  }).sort((a, b) => b.last - a.last);
  return { coins, pnlSol, winRate: counted ? wins / counted * 100 : null, trades: walletTrades(addr).length, volSol, counted };
}
let pricesBusy = false; const priceTried = new Set();
async function refreshFollowPrices(all){
  if(pricesBusy) return; pricesBusy = true;
  try{
    const mints = [...new Set(allTrades().map(t => t.mint))].filter(m => all || (!pairCache[m] && !priceTried.has(m))).slice(0, 90);
    mints.forEach(m => priceTried.add(m));
    if(mints.length) await pairsFor(mints).catch(() => {});
  }finally{ pricesBusy = false; }
}
const solUsd = l => SOL_USD ? usd(l / 1e9 * SOL_USD) : fmtSol(l) + " SOL";
const pnlFmt = l => `<b class="${l >= 0 ? "up" : "down"}">${l >= 0 ? "+" : "-"}${solUsd(Math.abs(l))}</b>`;

// ---------- Following screen ----------
let followRenderTimer = null;
function scheduleFollowRender(){
  if(followRenderTimer) return;
  followRenderTimer = setTimeout(() => { followRenderTimer = null; if(view === "following") renderFollowing(); }, 300);
}
function setFollowTab(t){ followTab = t; lsSet("followtab", t); renderFollowing(); }
function addFromInput(){
  const a = $("followAddr"), n = $("followNameIn");
  if(followWallet(a.value, n.value)){ a.value = ""; n.value = ""; }
}
function coinImg(mint, size){
  const p = pairCache[mint], sym = p?.baseToken?.symbol || "?", img = p?.info?.imageUrl, r = riskCache[mint];
  return `<div class="av-wrap">${img ? `<img class="av" ${size ? `style="width:${size}px;height:${size}px"` : ""} src="${esc(img)}" alt="" loading="lazy" onerror="this.style.visibility='hidden'">` : `<div class="av">${esc(sym[0])}</div>`}<span class="rdot ${r ? r.level : ""}"></span></div>`;
}
function tradeRow(t, showWho = true){
  const p = pairCache[t.mint], sym = p?.baseToken?.symbol || short(t.mint);
  const who = showWho ? `<a href="#" onclick="event.stopPropagation();openWallet('${esc(t.w)}');return false" style="color:var(--text);text-decoration:none">${esc(followName(t.w))}</a> ` : "";
  return `<div class="row" data-mint="${esc(t.mint)}" onclick="openToken('${esc(t.mint)}')">${coinImg(t.mint)}
    <div class="grow"><div class="nm" style="font-size:14px">${who}<span style="margin:0;color:${t.isBuy ? "var(--up)" : "var(--down)"};font-weight:800">${t.isBuy ? "bought" : "sold"}</span> <span style="margin:0;color:var(--text);font-weight:700">$${esc(sym)}</span></div>
      <div class="meta">${solUsd(t.sol)} · ${fmtSol(t.sol)} SOL · <span data-age="${t.ts}">${ageShort(t.ts)}</span>${p?.marketCap ? " · MC " + usd(p.marketCap) : ""}</div></div>
    ${t.isBuy ? `<button class="qb" title="Buy this coin too" onclick="event.stopPropagation();quickBuy('${esc(t.mint)}', this)">⚡ Copy ${cfg.quick}</button>` : ""}</div>`;
}
function renderFollowing(){
  const el = $("following"); if(!el) return;
  const f = follows();
  const tabs = `<div class="tabs">${[["feed","📡 Feed"],["leaders","🏆 Leaderboard"]].map(([k, l]) => `<div class="tab ${followTab === k ? "on" : ""}" onclick="setFollowTab('${k}')">${l}</div>`).join("")}</div>`;
  const add = `<div class="panel" style="margin-top:0"><div class="panel-head"><span>Follow a trader</span></div>
      <input id="followAddr" placeholder="Paste a Solana wallet address" autocomplete="off" autocapitalize="off" spellcheck="false" style="margin-top:10px">
      <div style="display:flex;gap:8px;margin-top:8px"><input id="followNameIn" placeholder="Name (optional)" maxlength="24" autocomplete="off"><button class="btn" onclick="addFromInput()">Follow</button></div>
      <p class="fine" style="margin-top:8px">Find traders worth following on any coin: open it and check <b>Top buyers</b>.</p></div>`;
  let body;
  if(!f.length){
    body = `<div class="empty">👥 Follow traders to see what they buy and sell, live.<br>Tap ⚡ Copy to buy the same coin in one tap.</div>`;
  } else if(followTab === "leaders"){
    const rows = f.map(x => ({...x, st: walletStats(x.addr)})).sort((a, b) => (b.st.counted ? b.st.pnlSol : -Infinity) - (a.st.counted ? a.st.pnlSol : -Infinity));
    body = rows.map((x, i) => `<div class="row" onclick="openWallet('${esc(x.addr)}')">
        <div class="av" style="font-size:15px">${i < 3 && x.st.counted ? ["🥇","🥈","🥉"][i] : i + 1}</div>
        <div class="grow"><div class="nm">${esc(followName(x.addr))}</div>
          <div class="meta">${x.st.trades} trades${x.st.winRate != null ? ` · ${x.st.winRate.toFixed(0)}% win rate` : ""}${followLoading.has(x.addr) ? " · loading…" : ""}</div></div>
        <div class="px">${x.st.counted ? pnlFmt(x.st.pnlSol) : `<b style="color:var(--sub)">—</b>`}<span class="chg" style="color:var(--sub)">profit</span></div></div>`).join("")
      + `<p class="fine">Ranked by profit on the trades Bulled has seen from each wallet (its latest ${FOLLOW_BACKFILL} transactions when you followed it, plus everything since). Coins still held are valued at today's price.</p>`;
  } else {
    const trades = allTrades().slice(0, 80), loading = followLoading.size || followQueue.length;
    body = (trades.length ? trades.map(t => tradeRow(t)).join("") : `<div class="empty">${loading ? "Reading their recent trades…" : "No trades yet. New buys and sells show up here the moment they happen."}</div>`)
      + `<p class="fine" style="text-align:center"><span class="live"><i></i>Live</span> · following ${f.length} wallet${f.length > 1 ? "s" : ""}</p>`;
    scanRisks([...new Set(trades.map(t => t.mint))]);
  }
  const typed = [$("followAddr")?.value || "", $("followNameIn")?.value || ""], focused = document.activeElement?.id;   // keep what's being typed when live trades re-draw the screen
  el.innerHTML = `<h2 class="page">Following</h2>${add}${f.length ? tabs : ""}${body}`;
  $("followAddr").value = typed[0]; $("followNameIn").value = typed[1];
  if(focused === "followAddr" || focused === "followNameIn") $(focused).focus();
  if(!pricesBusy && allTrades().some(t => !pairCache[t.mint] && !priceTried.has(t.mint))) refreshFollowPrices().then(scheduleFollowRender);   // names, pictures and prices for new coins
}

// ---------- Wallet profile sheet ----------
function openWallet(addr){
  const st = walletStats(addr), f = follows().find(x => x.addr === addr), following = !!f;
  openSheetHTML(`<div class="tk-head"><div class="av">👤</div><div class="grow"><h2>${esc(following ? followName(addr) : short(addr))}</h2>
      <div class="meta" style="cursor:pointer" onclick="navigator.clipboard?.writeText('${esc(addr)}').then(()=>toast('Address copied'))">${short(addr)} ⧉</div></div></div>
    ${following ? `<div class="grid">
      <div class="st"><div class="l">Profit</div><div class="v">${st.counted ? pnlFmt(st.pnlSol) : "—"}</div></div>
      <div class="st"><div class="l">Win rate</div><div class="v">${st.winRate != null ? st.winRate.toFixed(0) + "%" : "—"}</div></div>
      <div class="st"><div class="l">Volume</div><div class="v">${solUsd(st.volSol)}</div></div></div>
      <div style="display:flex;gap:8px"><button class="btn ghost full" style="padding:12px" onclick="toggleWalletAlerts('${esc(addr)}')">${f.alerts ? "🔔 Alerts on" : "🔕 Alerts off"}</button>
        <button class="btn ghost full" style="padding:12px" onclick="renameWallet('${esc(addr)}')">✏️ Rename</button></div>
      <div class="section">Coins traded</div>
      ${st.coins.length ? st.coins.slice(0, 25).map(c => { const p = pairCache[c.mint], sym = p?.baseToken?.symbol || short(c.mint);
        return `<div class="row" data-mint="${esc(c.mint)}" onclick="openToken('${esc(c.mint)}')">${coinImg(c.mint)}
          <div class="grow"><div class="nm">${esc(p?.baseToken?.name || sym)}<span>${esc(sym)}</span></div>
          <div class="meta">${c.buys} buy${c.buys === 1 ? "" : "s"} · ${c.sells} sell${c.sells === 1 ? "" : "s"} · ${ago(c.last)}</div></div>
          <div class="px">${c.pnl != null ? pnlFmt(c.pnl) : `<b style="color:var(--sub)">—</b>`}<span class="chg" style="color:var(--sub)">${c.pnl == null ? "bought earlier" : c.bought > c.sold ? "holding" : "closed"}</span></div></div>`; }).join("")
        : `<div class="empty">${followLoading.has(addr) || followQueue.some(j => j.owner === addr) ? "Reading recent trades…" : "No swaps found in this wallet's recent activity."}</div>`}
      <button class="btn ghost full" style="margin-top:14px" onclick="unfollowWallet('${esc(addr)}')">Unfollow</button>`
    : `<p style="color:var(--sub);font-size:14px;line-height:1.5">Follow this wallet to see its buys and sells live, its profit, and to copy its trades.</p>
      <button class="btn full" onclick="if(followWallet('${esc(addr)}'))openWallet('${esc(addr)}')">👥 Follow</button>`}
    <div class="links"><a href="https://solscan.io/account/${esc(addr)}" target="_blank" rel="noopener">Solscan ↗</a><a href="https://gmgn.ai/sol/address/${esc(addr)}" target="_blank" rel="noopener">GMGN ↗</a></div>
    <p class="fine">Profit counts only trades Bulled has seen from this wallet, so it isn't the wallet's all-time result. Not financial advice.</p>`);
}

// ---------- Top buyers on every coin (find traders to follow) ----------
async function loadTopBuyers(mint){
  const box = $("topBuyers"); if(!box) return;
  try{
    const pool = await gtPoolFor(mint);
    if(!pool) throw new Error("no pool");
    const j = await gt(`/pools/${pool}/trades`);
    const by = {};
    for(const t of j.data || []){
      const a = t.attributes, w = a.tx_from_address; if(!w) continue;
      const r = by[w] || (by[w] = {w, buy: 0, sell: 0, n: 0});
      const v = Number(a.volume_in_usd) || 0;
      if(a.kind === "buy") r.buy += v; else r.sell += v; r.n++;
    }
    const top = Object.values(by).filter(r => r.buy > 0).sort((a, b) => b.buy - a.buy).slice(0, 6);
    if(cur?.mint !== mint || !$("topBuyers")) return;
    $("topBuyers").innerHTML = `<div class="panel-head"><span>👥 Top buyers</span><span class="pill wait">latest trades</span></div>` +
      (top.length ? top.map(r => `<div class="check" style="align-items:center"><span style="cursor:pointer" onclick="openWallet('${esc(r.w)}')">${isFollowing(r.w) ? "✓ " + esc(followName(r.w)) : short(r.w)}</span>
        <span style="display:flex;align-items:center;gap:10px"><b class="up">${usd(r.buy)}</b>${r.sell ? `<b class="down">-${usd(r.sell)}</b>` : ""}
        ${isFollowing(r.w) ? "" : `<button class="qb" style="padding:5px 8px" onclick="if(followWallet('${esc(r.w)}'))this.remove()">+ Follow</button>`}</span></div>`).join("")
        : `<div class="check"><span>No recent buys yet</span></div>`);
  }catch{ const b = $("topBuyers"); if(b) b.remove(); }
}
const _renderToken = renderToken;
renderToken = function(){
  _renderToken();
  const s = $("safety"); if(!s || !cur) return;
  s.insertAdjacentHTML("afterend", `<div class="panel" id="topBuyers"><div class="panel-head"><span>👥 Top buyers</span><span class="pill wait">Loading…</span></div></div>`);
  loadTopBuyers(cur.mint);
};

// ---------- Boot ----------
setInterval(() => { if(!document.hidden && view === "following" && !sheetOpen()) refreshFollowPrices(true).then(scheduleFollowRender); }, 30000);
if(follows().length){
  followWsConnect();
  // catch up on anything that happened while the app was closed
  setTimeout(() => follows().forEach(f => backfill(f.addr)), 1500);
  refreshFollowPrices();
}
