// Tracked watchlist (Dashboard). All verified available on the Nasdaq API and CNBC.
// ASML/SHEL/ING are US-listed ADRs of Euronext Amsterdam names, priced in USD.
// (HEINY was removed: it 404s on the Nasdaq API.)
export const DEFAULT_UNIVERSE = [
  'AAPL',
  'MSFT',
  'NVDA',
  'AMZN',
  'GOOGL',
  'META',
  'TSLA',
  'JPM',
  'AMD',
  'NFLX',
  'ASML',
  'SHEL',
  'ING',
  'KO',
];

// Wide market scan (Scanner tab). category: stock | etf | crypto | index.
// region: US | EU | Asia | India | Global. quote/history resolve via CNBC -> Yahoo ->
// Stooq -> Nasdaq (US listings); crypto via CoinGecko; indices quote via CNBC and take
// history from a proxy ETF scaled to the index level when no direct history exists.
export const SCAN_UNIVERSE = [
  // US mega/large caps
  { symbol: 'AAPL', category: 'stock', region: 'US' },
  { symbol: 'MSFT', category: 'stock', region: 'US' },
  { symbol: 'NVDA', category: 'stock', region: 'US' },
  { symbol: 'AMZN', category: 'stock', region: 'US' },
  { symbol: 'GOOGL', category: 'stock', region: 'US' },
  { symbol: 'META', category: 'stock', region: 'US' },
  { symbol: 'TSLA', category: 'stock', region: 'US' },
  { symbol: 'JPM', category: 'stock', region: 'US' },
  { symbol: 'AMD', category: 'stock', region: 'US' },
  { symbol: 'NFLX', category: 'stock', region: 'US' },
  { symbol: 'AVGO', category: 'stock', region: 'US' },
  { symbol: 'CRM', category: 'stock', region: 'US' },
  { symbol: 'ORCL', category: 'stock', region: 'US' },
  { symbol: 'COST', category: 'stock', region: 'US' },
  { symbol: 'PLTR', category: 'stock', region: 'US' },
  { symbol: 'COIN', category: 'stock', region: 'US' },
  { symbol: 'MSTR', category: 'stock', region: 'US' },
  { symbol: 'SHOP', category: 'stock', region: 'US' },
  { symbol: 'KO', category: 'stock', region: 'US' },
  // EU names via US ADR listings (USD)
  { symbol: 'ASML', category: 'stock', region: 'EU', note: 'US ADR listing, USD' },
  { symbol: 'SHEL', category: 'stock', region: 'EU', note: 'US ADR listing, USD' },
  { symbol: 'ING', category: 'stock', region: 'EU', note: 'US ADR listing, USD' },
  { symbol: 'SAP', category: 'stock', region: 'EU', note: 'US ADR listing, USD' },
  { symbol: 'NVO', category: 'stock', region: 'EU', note: 'US ADR listing, USD' },
  { symbol: 'ADYEY', category: 'stock', region: 'EU', note: 'US ADR (Adyen), USD' },
  // Asia via US ADR listings (USD)
  { symbol: 'TSM', category: 'stock', region: 'Asia', note: 'US ADR listing, USD' },
  { symbol: 'BABA', category: 'stock', region: 'Asia', note: 'US ADR listing, USD' },
  { symbol: 'TM', category: 'stock', region: 'Asia', note: 'US ADR (Toyota), USD' },
  { symbol: 'SONY', category: 'stock', region: 'Asia', note: 'US ADR listing, USD' },
  { symbol: '7203.T', category: 'stock', region: 'Asia', note: 'Tokyo Exchange, JPY (needs Yahoo/Stooq for history)' },
  // India
  { symbol: 'RELIANCE.NS', category: 'stock', region: 'India', note: 'NSE listing, INR (needs Yahoo/Stooq for history)' },
  // US-listed ETFs
  { symbol: 'SPY', category: 'etf', region: 'US', note: 'S&P 500 ETF' },
  { symbol: 'QQQ', category: 'etf', region: 'US', note: 'Nasdaq-100 ETF' },
  { symbol: 'IWM', category: 'etf', region: 'US', note: 'Russell 2000 ETF' },
  { symbol: 'VTI', category: 'etf', region: 'US', note: 'Total market ETF' },
  { symbol: 'SMH', category: 'etf', region: 'US', note: 'Semiconductors ETF' },
  { symbol: 'XLF', category: 'etf', region: 'US', note: 'Financials ETF' },
  { symbol: 'ARKK', category: 'etf', region: 'US', note: 'ARK Innovation ETF' },
  { symbol: 'FXI', category: 'etf', region: 'Asia', note: 'China large-cap ETF, US-listed' },
  { symbol: 'INDA', category: 'etf', region: 'India', note: 'MSCI India ETF, US-listed' },
  // Crypto (USD pairs via CoinGecko)
  { symbol: 'BTC-USD', category: 'crypto', region: 'Global' },
  { symbol: 'ETH-USD', category: 'crypto', region: 'Global' },
  { symbol: 'SOL-USD', category: 'crypto', region: 'Global' },
  { symbol: 'XRP-USD', category: 'crypto', region: 'Global' },
  { symbol: 'ADA-USD', category: 'crypto', region: 'Global' },
  // Indices (CNBC real-time quote; history via proxy ETF scaled to the index level)
  { symbol: '.SPX', category: 'index', region: 'US', note: 'S&P 500 index' },
  { symbol: '.DJI', category: 'index', region: 'US', note: 'Dow Jones index' },
  { symbol: '.IXIC', category: 'index', region: 'US', note: 'Nasdaq Composite index' },
  { symbol: '.VIX', category: 'index', region: 'US', note: 'CBOE volatility index' },
];

export const SCAN_SYMBOLS = SCAN_UNIVERSE.map((e) => e.symbol);

export function scanEntry(symbol) {
  return SCAN_UNIVERSE.find((e) => e.symbol === String(symbol).toUpperCase()) || { symbol: String(symbol).toUpperCase(), category: 'stock', region: 'US' };
}
