// Bulled runs on GitHub Pages, outside claude.ai, so this file stands in for the
// claude.ai runtime the app was first built on (window.claude.use).
//  - db: kept on this device (localStorage). Leaderboards, reports and votes are
//    this phone's own until a shared backend is added.
//  - market/snapshot, market/holders, trackrecord/log: built live in the browser
//    from DexScreener and RugCheck, refreshed every few minutes.
(function(){
  if(window.claude && window.claude.use) return;
  const LS_DB = "bulled_db_v1", LS_UID = "bulled_uid", LS_MKT = "bulled_market_v1";
  const lsGet = (k, d) => { try{ const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); }catch{ return d; } };
  const lsSet = (k, v) => { try{ localStorage.setItem(k, JSON.stringify(v)); }catch{} };

  // ================= db =================
  let store = lsGet(LS_DB, {});          // "collection/doc" -> data (nested paths allowed)
  const live = {};                        // generated docs (market data), never saved to LS_DB
  const docSubs = {}, colSubs = {};
  const clone = v => v == null ? v : JSON.parse(JSON.stringify(v));
  const read = p => p in live ? live[p] : store[p];
  const snapDoc = p => { const d = read(p), id = p.split("/").pop(); return {id, exists: d != null, data: () => clone(d)}; };
  const colOf = p => p.split("/").slice(0, -1).join("/");
  const snapCol = c => {
    const docs = Object.keys(Object.assign({}, store, live)).filter(p => colOf(p) === c).map(snapDoc);
    return {docs, size: docs.length, empty: !docs.length, forEach: f => docs.forEach(f)};
  };
  function emit(p){
    (docSubs[p] || []).forEach(f => { try{ f(snapDoc(p)); }catch{} });
    const c = colOf(p); (colSubs[c] || []).forEach(f => { try{ f(snapCol(c)); }catch{} });
  }
  function write(p, d){
    if(d == null) delete store[p]; else store[p] = clone(d);
    lsSet(LS_DB, store); setTimeout(() => emit(p), 0);
  }
  function setLive(p, d){ live[p] = d; emit(p); }
  const sub = (map, k, f, snap) => { (map[k] = map[k] || []).push(f); setTimeout(() => f(snap()), 0);
    return () => { map[k] = (map[k] || []).filter(x => x !== f); }; };
  const db = Object.freeze({
    doc: p => ({
      id: p.split("/").pop(), path: p,
      get: async () => snapDoc(p),
      set: async (d, o) => write(p, o && o.merge ? Object.assign({}, store[p], d) : d),
      update: async d => write(p, Object.assign({}, store[p], d)),
      delete: async () => write(p, null),
      onSnapshot: (f) => sub(docSubs, p, f, () => snapDoc(p)),
    }),
    collection: c => ({
      get: async () => snapCol(c),
      onSnapshot: (f) => sub(colSubs, c, f, () => snapCol(c)),
    }),
  });
  window.addEventListener("storage", e => { if(e.key === LS_DB){ store = lsGet(LS_DB, {}); Object.keys(store).forEach(emit); } });

  // ================= user =================
  let uid = lsGet(LS_UID, null);
  if(!uid){ uid = "u_" + Array.from(crypto.getRandomValues(new Uint8Array(11)), b => b.toString(16).padStart(2, "0")).join(""); lsSet(LS_UID, uid); }
  const user = Object.freeze({
    id: async () => uid, me: async () => ({id: uid, name: "", guest: false}),
    isOwner: () => false, canEdit: () => false, can: async n => n === "data.write" ? true : null,
    profiles: async ids => Object.fromEntries((ids || []).map(i => [i, {id: i, name: ""}])),
    search: async () => [],
  });

  // ================= downloads =================
  const downloads = Object.freeze({
    save: async ({filename, data}) => {
      const blob = data instanceof Blob ? data : new Blob([data]);
      const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = filename || "bulled";
      document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 4000);
      return {ok: true};
    },
  });

  const caps = {db, user, downloads};
  window.claude = Object.freeze({ use: async name => caps[name] || null });

  // ================= live market data =================
  const DS = "https://api.dexscreener.com", RC = "https://api.rugcheck.xyz/v1/tokens/";
  const SOL = "So11111111111111111111111111111111111111112";
  const FIXED = ["DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263","EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm","7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr","9BB6NFEcjBCtnNLFko2FqVQBq8HHM13kCyYcdQbgpump","2zMMhcVQEXDtdE6vsFS7S7D5oUodfJHE8vd1gnBouauv","6p6xgHyF7AeE6TZkSmFsko444wqoP15icUSqi2jfGiPN","63LfDmNb3MQ8mw9MtZ2To9bEA2M71kZUUGq5tiJxcqj9","ED5nyyWEzpPPiWimP8vYm7sD7TD3LAt3Q3gRTWHzPJBY","2qEHjDLDLbuBgRYvsxhc5D6uDWAivNFZGan56P1tpump","Df6yfrKC8kZE3KNkrHERKzAetSxbrWeniQfyJY4Jpump","Dz9mQ9NzkBcCsuGPFJ3r1bS4wgqKMHBPiVuniW8Mbonk","MEW1gQWJ3nEXg2qgERiKu7FAFj79PHvQVREQUzScPP5","pumpCmXqMfrsAkQ5r49WcJnRayYRqmXz6ae8H7H9Dfn","ukHH6c7mMyiWCf1b9pnWe25TSpkDDt3H5pQZgZ74J82","7BgBvyjrZX1YKz4oh9mjb8ZScatkkwb8DzFx7LoiVkM3","5z3EqYQo9HiCEs3R84RCDMu2n7anpDMxRhdK8PSWmrRC","5mbK36SZ7J19An8jFochhQS4of8g6BwUjbeCSxBSoWdp","6ogzHhzdrQr9Pgv6hZ2MNze7UrzBMAFyBBWUYp1Fhitx","CzLSujWBLFsSjncfkh59rUFqvafWcY5tzedWJSuypump","J3NKxxXZcnNiMjKw9hYb2K4LUxgwB6t1FtPtQVsv3KFr","8x5VqbHA8D7NkD52uNuS5nnt3PwA8pLD34ymskeSo2Wn"];
  const AMM = new Set(["5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1","GpMZbSM2GgvTKHJirzeGfMFoaZ8UR2X7F4v8vHTvxFbL","HLnpSz9h2S4hiLQ43rnSD9XkcUThA7B8hQMKmDaiTLcC"]);
  const REFRESH_MS = 5 * 60e3, RISK_TTL = 6 * 3600e3, HOLD_TTL = 12 * 3600e3;
  const n = v => { const x = typeof v === "string" ? parseFloat(v.replace("−", "-")) : v; return typeof x === "number" && isFinite(x) ? x : null; };
  async function getJSON(u){ const r = await fetch(u, {cache: "no-store"}); if(!r.ok) throw new Error(r.status); return r.json(); }
  async function pool(items, k, f){ const out = []; let i = 0;
    await Promise.all(Array.from({length: k}, async () => { while(i < items.length){ const j = i++; try{ out[j] = await f(items[j]); }catch{ out[j] = null; } } })); return out; }

  // m = {snapshot, holders, track} kept on this device so the list shows instantly next time
  const m = lsGet(LS_MKT, {snapshot: null, holders: {updatedAt: 0, source: "RugCheck top holders", coins: {}}, track: null});
  function publish(){
    if(m.snapshot) setLive("market/snapshot", m.snapshot);
    setLive("market/holders", m.holders);
    if(m.track) setLive("trackrecord/log", m.track);
    lsSet(LS_MKT, m);
  }

  async function candidates(){
    const lists = await Promise.all([DS + "/token-boosts/top/v1", DS + "/token-profiles/latest/v1"].map(u => getJSON(u).catch(() => [])));
    const fresh = lists.flatMap(l => (Array.isArray(l) ? l : []).filter(x => x.chainId === "solana").slice(0, 20).map(x => x.tokenAddress));
    const prev = (m.snapshot?.coins || []).map(c => c.mint);
    return [...new Set([...FIXED, ...fresh, ...prev])].slice(0, 60);
  }
  async function pairs(mints){
    const rows = {};
    for(let i = 0; i < mints.length; i += 30){
      const arr = await getJSON(DS + "/tokens/v1/solana/" + mints.slice(i, i + 30).join(",")).catch(() => []);
      for(const p of Array.isArray(arr) ? arr : []){
        const a = p.baseToken?.address; if(!a) continue;
        if(!rows[a] || (n(p.liquidity?.usd) || 0) > (n(rows[a].liquidity?.usd) || 0)) rows[a] = p;
      }
    }
    return rows;
  }
  async function risk(mint, old){
    if(old && Date.now() - old.checkedAt < RISK_TTL) return old;
    try{
      const r = await getJSON(RC + mint + "/report/summary");
      return {score: n(r.score_normalised) ?? 0, lpLockedPct: n(r.lpLockedPct) ?? 0,
        risks: (r.risks || []).map(x => ({name: x.name, level: x.level})), checkedAt: Date.now()};
    }catch{ return old || null; }
  }
  async function holders(mint){
    const r = await getJSON(RC + mint + "/report");
    const pools = new Set((r.markets || []).map(x => x.liquidityAAccount?.owner).filter(Boolean));
    const h = (r.topHolders || []).slice(0, 20).map(x => [x.owner, n(x.pct) ?? 0, pools.has(x.owner) || AMM.has(x.owner) ? "p" : x.insider ? "i" : ""]);
    if(h.length < 5) throw new Error("few");
    return {at: Date.now(), h};
  }
  function updateTrack(now, coins, rows){
    const t = m.track || {startedAt: now, updatedAt: now, coins: {}};
    for(const c of coins) if(!t.coins[c.mint] && c.risk) t.coins[c.mint] = {sym: c.symbol, name: c.name, score: c.risk.score, ratedAt: now,
      p0: c.priceUsd, liq0: c.liqUsd, pLast: c.priceUsd, liqLast: c.liqUsd, lastAt: now, minP: c.priceUsd, minLiq: c.liqUsd, misses: 0, outcome: null, closedAt: null, chg: null};
    for(const [mint, e] of Object.entries(t.coins)){
      if(e.outcome) continue;
      const p = rows[mint], price = n(p?.priceUsd), liq = n(p?.liquidity?.usd);
      if(price != null){ Object.assign(e, {pLast: price, liqLast: liq ?? e.liqLast, lastAt: now, misses: 0, minP: Math.min(e.minP, price), minLiq: Math.min(e.minLiq, liq ?? e.minLiq)}); }
      else if(now - e.lastAt > 3600e3) e.misses++;   // only count a miss once per hour, like the hourly job did
      if(e.minP <= 0.1 * e.p0 || e.minLiq <= 0.2 * e.liq0 || e.misses >= 3){ e.outcome = "rugged"; e.closedAt = now; e.chg = e.misses >= 3 ? -100 : Math.round((e.pLast / e.p0 - 1) * 100); }
      else if(now - e.ratedAt >= 7 * 864e5){ e.chg = Math.round((e.pLast / e.p0 - 1) * 100); e.outcome = e.chg <= -50 ? "down50" : "held"; e.closedAt = now; }
    }
    t.updatedAt = now; m.track = t;
  }

  let running = false;
  async function refresh(){
    if(running || document.hidden) return; running = true;
    try{
      const now = Date.now();
      if(!m.track) m.track = await getJSON("data/trackrecord.json").catch(() => null);
      const mints = await candidates();
      const open = Object.entries(m.track?.coins || {}).filter(([, e]) => !e.outcome).map(([k]) => k);
      const rows = await pairs([...new Set([...mints, ...open, SOL])]);
      const solUsd = n(rows[SOL]?.priceUsd) || m.snapshot?.solUsd || null;
      const prev = Object.fromEntries((m.snapshot?.coins || []).map(c => [c.mint, c]));
      const kept = mints.map(k => rows[k]).filter(p => p && n(p.priceUsd) > 0 && (n(p.liquidity?.usd) || 0) >= 20000
        && !(p.dexId === "pumpfun" && (n(p.marketCap) || 0) < (n(p.liquidity?.usd) || 0)));
      if(kept.length < 10) return;
      const risks = await pool(kept, 4, p => risk(p.baseToken.address, prev[p.baseToken.address]?.risk));
      const coins = kept.map((p, i) => {
        const mint = p.baseToken.address, old = prev[mint], price = n(p.priceUsd);
        return {mint, name: (p.baseToken.name || "").trim(), symbol: (p.baseToken.symbol || "").replace(/^\$/, "").trim(),
          priceUsd: price, mcUsd: n(p.marketCap), liqUsd: n(p.liquidity?.usd), vol24: n(p.volume?.h24), vol1h: n(p.volume?.h1),
          ch5m: n(p.priceChange?.m5), ch1h: n(p.priceChange?.h1), ch6h: n(p.priceChange?.h6), ch24: n(p.priceChange?.h24),
          createdAt: n(p.pairCreatedAt), dex: p.dexId || null, url: p.url || null,
          buys24: n(p.txns?.h24?.buys), sells24: n(p.txns?.h24?.sells), buys1h: n(p.txns?.h1?.buys), sells1h: n(p.txns?.h1?.sells),
          risk: risks[i], hist: [...(old?.hist || []), [now, price]].slice(-72)};
      }).filter(c => c.risk);
      m.snapshot = {updatedAt: now, solUsd, source: "DexScreener + RugCheck", coins};
      updateTrack(now, coins, rows);
      publish();
      // holder maps: a few coins per refresh, oldest first
      const due = coins.map(c => c.mint).filter(k => !m.holders.coins[k] || now - m.holders.coins[k].at > HOLD_TTL)
        .sort((a, b) => (m.holders.coins[a]?.at || 0) - (m.holders.coins[b]?.at || 0)).slice(0, 6);
      const got = await pool(due, 2, holders);
      due.forEach((k, i) => { if(got[i]) m.holders.coins[k] = got[i]; });
      for(const k of Object.keys(m.holders.coins)) if(!prev[k] && !coins.some(c => c.mint === k) && now - m.holders.coins[k].at > 3 * 864e5) delete m.holders.coins[k];
      m.holders.updatedAt = Date.now(); publish();
    }catch(e){ console.warn("Bulled market refresh failed", e); }
    finally{ running = false; }
  }
  publish();
  setTimeout(refresh, 400);
  setInterval(refresh, REFRESH_MS);
  document.addEventListener("visibilitychange", () => { if(!document.hidden && Date.now() - (m.snapshot?.updatedAt || 0) > REFRESH_MS) refresh(); });
})();
