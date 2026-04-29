import { useState, useRef, useEffect, useCallback } from 'react';
import TradeRow from './TradeRow.jsx';

const COLS = ['DATE', 'TIME', 'MARKET', 'TITLE', 'CAT', 'TIMING', 'SIDE', 'PRICE', 'SIZE', 'NOTIONAL', 'TRADE ID'];

const DEFAULT_WIDTHS = {
  DATE:       112,
  TIME:       128,
  MARKET:     288,
  TITLE:      240,
  CAT:        128,
  TIMING:      72,
  SIDE:        72,
  PRICE:       80,
  SIZE:       112,
  NOTIONAL:   112,
  'TRADE ID': 260,
};

const STORAGE_KEY = 'whaleTrackerColWidths';
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

  // Keep a ref so mousemove handler always sees current startWidth without re-subscribing
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

export default function TradeTable({ trades }) {
  const { widths, onMouseDown, resetWidths } = useColumnResize();

  return (
    <div className="table-wrapper">
      <table className="trade-table">
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
          {trades.length === 0 ? (
            <tr>
              <td colSpan={COLS.length} className="empty-row">
                Waiting for trades…
              </td>
            </tr>
          ) : (
            trades.map((trade) => <TradeRow key={trade.id} trade={trade} />)
          )}
        </tbody>
      </table>
    </div>
  );
}
