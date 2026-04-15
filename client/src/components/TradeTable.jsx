import TradeRow from './TradeRow.jsx';

const COLS = ['DATE', 'TIME', 'MARKET', 'TITLE', 'CAT', 'SIDE', 'PRICE', 'SIZE', 'NOTIONAL'];

export default function TradeTable({ trades }) {
  return (
    <div className="table-wrapper">
      <table className="trade-table">
        <thead>
          <tr>
            {COLS.map((col) => (
              <th key={col} className="th">
                {col}
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
