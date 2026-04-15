export default function TopMarketsTable({ markets }) {
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
        <thead>
          <tr>
            <th className="th">#</th>
            <th className="th">MARKET</th>
            <th className="th">TITLE</th>
            <th className="th">CAT</th>
            <th className="th">TRADES</th>
            <th className="th">TOTAL VOLUME</th>
          </tr>
        </thead>
        <tbody>
          {markets.map((m, i) => (
            <tr key={m.ticker} className={`trade-row ${i % 2 === 0 ? '' : ''}`}>
              <td className="td td--mono">{i + 1}</td>
              <td className="td td--ticker" title={m.ticker}>{m.ticker}</td>
              <td className="td td--title">{m.title || '—'}</td>
              <td className="td td--cat">{m.category}</td>
              <td className="td td--mono">{m.tradeCount.toLocaleString()}</td>
              <td className="td td--notional">{fmtNotional(m.totalNotional)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function fmtNotional(dollars) {
  if (dollars >= 1_000_000) return `$${(dollars / 1_000_000).toFixed(2)}M`;
  if (dollars >= 1_000)     return `$${(dollars / 1_000).toFixed(1)}K`;
  return `$${Number(dollars).toFixed(0)}`;
}
