function fmtNotional(dollars) {
  if (!dollars) return '—';
  if (dollars >= 1_000_000) return `$${(dollars / 1_000_000).toFixed(2)}M`;
  if (dollars >= 1_000) return `$${(dollars / 1_000).toFixed(1)}K`;
  return `$${Number(dollars).toFixed(0)}`;
}

export default function TopMarketsCards({ markets }) {
  if (!markets.length) {
    return <div className="cards-wrapper"><div className="empty-row">No data yet — hit ↻ Refresh</div></div>;
  }
  return (
    <div className="cards-wrapper">
      {markets.map((m, i) => {
        const yes = Number(m.yesNotional ?? 0);
        const no = Number(m.noNotional ?? 0);
        const total = Number(m.totalNotional ?? yes + no);
        const yesPct = total > 0 ? Math.round((yes / total) * 100) : 0;
        const pick = yes >= no ? m.yesSub : m.noSub;
        return (
          <div className="trade-card" key={m.ticker}>
            <div className="trade-card__top">
              <span className="market-rank">#{i + 1}</span>
              <span className="td--ticker">{m.ticker}</span>
              <span className="trade-card__cat">{m.category}</span>
              <span className="trade-card__time">{m.tradeCount.toLocaleString()} trades</span>
            </div>

            <div className="trade-card__title">{m.title || m.ticker}</div>
            {pick && <div className="trade-card__pick">▸ {pick}</div>}

            <div className="trade-card__stats">
              <span className="trade-card__notional">{fmtNotional(total)}</span>
              <span className="td--yes-vol">Y {fmtNotional(yes)}</span>
              <span className="td--no-vol">N {fmtNotional(no)}</span>
            </div>

            <div className="pct-bar" style={{ marginTop: '0.45rem' }}>
              <div className="pct-bar__yes" style={{ width: `${yesPct}%` }}>
                {yesPct >= 15 ? `${yesPct}%` : ''}
              </div>
              <div className="pct-bar__no" style={{ width: `${100 - yesPct}%` }}>
                {100 - yesPct >= 15 ? `${100 - yesPct}%` : ''}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
