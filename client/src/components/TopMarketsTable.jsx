import { useState, useRef, useEffect, useCallback } from 'react';
import TopMarketsCards from './TopMarketsCards.jsx';
import { useMediaQuery } from '../useMediaQuery.js';

const COLS = ['#', 'MARKET', 'TITLE', 'PICK', 'CAT', 'TRADES', 'YES VOL', 'NO VOL', 'TOTAL', 'YES / NO'];

const DEFAULT_WIDTHS = {
  '#':        48,
  MARKET:    260,
  TITLE:     280,
  PICK:      160,
  CAT:       128,
  TRADES:     80,
  'YES VOL': 100,
  'NO VOL':  100,
  TOTAL:     100,
  'YES / NO': 160,
};

const STORAGE_KEY = 'whaleTrackerTopMktWidths';
const MIN_COL_WIDTH = 40;

function useColumnResize() {
  const [widths, setWidths] = useState(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      return saved ? { ...DEFAULT_WIDTHS, ...JSON.parse(saved) } : DEFAULT_WIDTHS;
    } catch {
      return DEFAULT_WIDTHS;
    }
  });

  const widthsRef = useRef(widths);
  useEffect(() => { widthsRef.current = widths; }, [widths]);

  const onMouseDown = useCallback((col, e) => {
    e.preventDefault();
    const startX     = e.clientX;
    const startWidth = widthsRef.current[col];

    function onMouseMove(e) {
      const next = Math.max(MIN_COL_WIDTH, startWidth + (e.clientX - startX));
      setWidths((prev) => ({ ...prev, [col]: next }));
    }

    function onMouseUp() {
      setWidths((prev) => {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(prev));
        return prev;
      });
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
    }

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  }, []);

  const resetWidths = useCallback(() => {
    localStorage.removeItem(STORAGE_KEY);
    setWidths(DEFAULT_WIDTHS);
  }, []);

  return { widths, onMouseDown, resetWidths };
}

export default function TopMarketsTable({ markets }) {
  const isMobile = useMediaQuery('(max-width: 768px)');
  const { widths, onMouseDown, resetWidths } = useColumnResize();

  if (isMobile) return <TopMarketsCards markets={markets} />;

  if (markets.length === 0) {
    return (
      <div className="table-wrapper">
        <table className="trade-table">
          <tbody>
            <tr><td className="empty-row">No data yet — hit ↻ Refresh</td></tr>
          </tbody>
        </table>
      </div>
    );
  }

  return (
    <div className="table-wrapper">
      <table className="trade-table top-markets-table">
        <colgroup>
          {COLS.map((col) => (
            <col key={col} style={{ width: widths[col] + 'px' }} />
          ))}
        </colgroup>
        <thead>
          <tr>
            {COLS.map((col) => (
              <th key={col} className="th">
                {col}
                <span
                  className="th-resize-handle"
                  onMouseDown={(e) => onMouseDown(col, e)}
                  onDoubleClick={resetWidths}
                  title="Drag to resize · Double-click to reset all"
                />
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {markets.map((m, i) => {
            const yes = Number(m.yesNotional ?? 0);
            const no  = Number(m.noNotional  ?? 0);
            const total = Number(m.totalNotional ?? (yes + no));
            const yesPct = total > 0 ? Math.round((yes / total) * 100) : 0;
            return (
              <tr key={m.ticker} className="trade-row">
                <td className="td td--mono">{i + 1}</td>
                <td className="td td--ticker" title={m.ticker}>{m.ticker}</td>
                <td className="td td--title">
                  {m.title || '—'}
                </td>
                <td className="td td--pick">
                  {(() => {
                    const yes = Number(m.yesNotional ?? 0);
                    const no  = Number(m.noNotional  ?? 0);
                    const pick = yes >= no ? m.yesSub : m.noSub;
                    return pick ?? '—';
                  })()}
                </td>
                <td className="td td--cat">{m.category}</td>
                <td className="td td--mono">{m.tradeCount.toLocaleString()}</td>
                <td className="td td--notional td--yes-vol">{fmtNotional(yes)}</td>
                <td className="td td--notional td--no-vol">{fmtNotional(no)}</td>
                <td className="td td--notional">{fmtNotional(total)}</td>
                <td className="td td--pct-bar">
                  <div className="pct-bar">
                    <div className="pct-bar__yes" style={{ width: `${yesPct}%` }}>
                      {yesPct >= 20 ? `${yesPct}%` : ''}
                    </div>
                    <div className="pct-bar__no" style={{ width: `${100 - yesPct}%` }}>
                      {(100 - yesPct) >= 20 ? `${100 - yesPct}%` : ''}
                    </div>
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function fmtNotional(dollars) {
  if (!dollars) return '—';
  if (dollars >= 1_000_000) return `$${(dollars / 1_000_000).toFixed(2)}M`;
  if (dollars >= 1_000)     return `$${(dollars / 1_000).toFixed(1)}K`;
  return `$${Number(dollars).toFixed(0)}`;
}
