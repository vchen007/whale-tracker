import { useState, useMemo, useEffect, useCallback } from 'react';
import { useWebSocket } from './useWebSocket.js';
import FilterBar from './components/FilterBar.jsx';
import TradeTable from './components/TradeTable.jsx';
import TopMarketsTable from './components/TopMarketsTable.jsx';
import StatusBar from './components/StatusBar.jsx';
import StatsBar from './components/StatsBar.jsx';

const TIME_RANGES = [
  { label: 'TODAY', cutoff: () => new Date().setHours(0, 0, 0, 0) },
  { label: '1H',   cutoff: () => Date.now() - 60 * 60 * 1000 },
  { label: '24H',  cutoff: () => Date.now() - 24 * 60 * 60 * 1000 },
  { label: '7D',   cutoff: () => Date.now() - 7  * 24 * 60 * 60 * 1000 },
  { label: '30D',  cutoff: () => Date.now() - 30 * 24 * 60 * 60 * 1000 },
  { label: 'ALL',  cutoff: () => null },
];

const TOP_MARKETS_URL = 'http://localhost:3001/markets/top';

export default function App() {
  const [tab,       setTab]       = useState('trades');
  const [minSize,   setMinSize]   = useState('10000');
  const [category,  setCategory]  = useState('');
  const [side,      setSide]      = useState('');
  const [timeRange, setTimeRange] = useState('30D');
  const [sortBy,    setSortBy]    = useState('notional');

  const { trades, status, connected, refresh, refreshing } = useWebSocket(
    minSize === '' ? 0 : Number(minSize),
    sortBy,
    10_000,
  );

  // ── Top Markets ──────────────────────────────────────────────────────────────
  const [topMarkets,         setTopMarkets]         = useState([]);
  const [topMarketsLoading,  setTopMarketsLoading]  = useState(false);

  const fetchTopMarkets = useCallback(() => {
    setTopMarketsLoading(true);
    const cutoff = TIME_RANGES.find((r) => r.label === timeRange)?.cutoff() ?? null;
    const since  = cutoff ?? (Date.now() - 30 * 24 * 60 * 60 * 1000);
    fetch(`${TOP_MARKETS_URL}?since=${since}`)
      .then((r) => r.json())
      .then(setTopMarkets)
      .catch(() => {})
      .finally(() => setTopMarketsLoading(false));
  }, [timeRange]);

  useEffect(() => {
    if (tab === 'markets') fetchTopMarkets();
  }, [tab, fetchTopMarkets]);

  // ── Trades tab ───────────────────────────────────────────────────────────────
  const categories = useMemo(() =>
    [...new Set(trades.map((t) => t.category).filter(Boolean))].sort(),
    [trades],
  );

  const filtered = useMemo(() => {
    const min    = minSize === '' ? 0 : Number(minSize);
    const cutoff = TIME_RANGES.find((r) => r.label === timeRange)?.cutoff() ?? null;

    return trades.filter((t) => {
      if (cutoff && new Date(t.ts).getTime() < cutoff) return false;
      const price    = t.side === 'yes' ? t.yesPrice : t.noPrice;
      const notional = price != null ? (t.count * price) / 100 : 0;
      if (notional < min) return false;
      if (category && t.category !== category) return false;
      if (side && t.side !== side) return false;
      return true;
    });
  }, [trades, minSize, category, side, timeRange]);

  const handleRefresh = () => {
    if (tab === 'markets') fetchTopMarkets();
    else refresh();
  };

  return (
    <div className="app">
      <header className="app-header">
        <span className="app-title">🐳 KALSHI WHALE TRACKER</span>
        <button className="refresh-btn" onClick={handleRefresh} disabled={refreshing || topMarketsLoading}>
          {(refreshing || topMarketsLoading) ? '↻ Refreshing…' : '↻ Refresh'}
        </button>
        <StatusBar connected={connected} status={status} />
      </header>

      <div className="tabs">
        <button className={`tab-btn${tab === 'trades'  ? ' tab-btn--active' : ''}`} onClick={() => setTab('trades')}>TRADES</button>
        <button className={`tab-btn${tab === 'markets' ? ' tab-btn--active' : ''}`} onClick={() => setTab('markets')}>TOP MARKETS</button>
      </div>

      {tab === 'trades' && (
        <>
          <StatsBar trades={filtered} />
          <FilterBar
            minSize={minSize}
            onMinSize={setMinSize}
            category={category}
            onCategory={setCategory}
            categories={categories}
            side={side}
            onSide={setSide}
            timeRange={timeRange}
            onTimeRange={setTimeRange}
            timeRanges={TIME_RANGES}
            sortBy={sortBy}
            onSortBy={setSortBy}
            totalShown={filtered.length}
            totalAll={trades.length}
          />
          <TradeTable trades={filtered} />
        </>
      )}

      {tab === 'markets' && (
        <>
          <div className="filter-bar">
            <div className="filter-group">
              <span className="filter-label">TIME</span>
              <div className="time-range-btns">
                {TIME_RANGES.map((r) => (
                  <button
                    key={r.label}
                    className={`time-btn${timeRange === r.label ? ' time-btn--active' : ''}`}
                    onClick={() => setTimeRange(r.label)}
                  >
                    {r.label}
                  </button>
                ))}
              </div>
            </div>
          </div>
          <TopMarketsTable markets={topMarkets} />
        </>
      )}
    </div>
  );
}
