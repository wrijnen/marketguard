// Default watchlist — all available on the Nasdaq API (works from GitHub Actions
// runners, where Yahoo/Stooq are often rate-limited). ASML/SHEL/ING/HEINY are the
// US-listed ADRs of the Euronext Amsterdam names, priced in USD.
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
  'HEINY',
];
