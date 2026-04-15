import { useMemo } from 'react';

export default function StatsBar({ trades }) {
  const stats = useMemo(() => {
    let totalContracts = 0;
    let yesDollar = 0;
    let noDollar = 0;

    for (const t of trades) {
      totalContracts += t.count;
      const price = t.side === 'yes' ? (t.yesPrice ?? 0) : (t.noPrice ?? 0);
      const dollars = (t.count * price) / 100; // price is in cents
      if (t.side === 'yes') yesDollar += dollars;
      else noDollar += dollars;
    }

    return { totalContracts, yesDollar, noDollar };
  }, [trades]);

  const fmt = (n) =>
    n >= 1_000_000
      ? `$${(n / 1_000_000).toFixed(2)}M`
      : n >= 1_000
      ? `$${(n / 1_000).toFixed(1)}K`
      : `$${n.toFixed(0)}`;

  return (
    <div className="stats-bar">
      <Stat label="CONTRACTS" value={stats.totalContracts.toLocaleString()} />
      <Stat label="YES VOLUME" value={fmt(stats.yesDollar)} accent="yes" />
      <Stat label="NO VOLUME" value={fmt(stats.noDollar)} accent="no" />
    </div>
  );
}

function Stat({ label, value, accent }) {
  return (
    <div className="stat">
      <span className="stat-label">{label}</span>
      <span className={`stat-value ${accent ? `stat-value--${accent}` : ''}`}>{value}</span>
    </div>
  );
}
