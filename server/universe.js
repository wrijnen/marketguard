// Default watchlist — all verified available on the Nasdaq API and CNBC quotes
// (both work from GitHub Actions runners, where Yahoo/Stooq are rate-limited).
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
