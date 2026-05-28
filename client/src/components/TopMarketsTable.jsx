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
            <th className="th">YES VOL</th>
            <th className="th">NO VOL</th>
            <th className="th">TOTAL</th>
            <th className="th">YES / NO</th>
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
                  {m.yesSub && <span className="td--outcome"> ▸ {m.yesSub}</span>}
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
