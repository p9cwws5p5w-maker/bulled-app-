# Bulled

A Solana memecoin app: learn, practise with paper trading, and trade for real with rug warnings built in.

- `index.html`: the main app (coins, learn, trenches, community, portfolio). `claude-shim.js` stands in for the claude.ai runtime it was built on: data is kept on the device, and coin data comes live from DexScreener and RugCheck.
- `trade.html`: real trading with Phantom, Solflare or Backpack. Open a coin with `trade.html?coin=<mint>`.
- `follow.js`: the Following tab in `trade.html`. Follow any Solana wallet to see its buys and sells live, rank followed traders by profit, copy a buy in one tap, and find traders from each coin's Top buyers.
- `config.js`: your Solana RPC URL (public once deployed, so lock the key to your domain).
