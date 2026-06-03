import { memo } from 'react';

function fmtTime(iso) {
  try {
    return new Date(iso).toLocaleTimeString('en-US', { hour12: false });
  } catch {
    return '--:--:--';
  }
}

function fmtPrice(cents) {
  return cents == null ? '—' : `${cents}¢`;
}

function fmtNotional(count, cents) {
  if (cents == null) return '—';
  const d = (count * cents) / 100;
  if (d >= 1_000_000) return `$${(d / 1_000_000).toFixed(2)}M`;
  if (d >= 1_000) return `$${(d / 1_000).toFixed(1)}K`;
  return `$${d.toFixed(0)}`;
}

// PRE before event start, LIVE after. Mirrors the logic in TradeRow.
function timingBadge(trade) {
  const HR = 1000 * 60 * 60;
  const GAME_DURATION_HOURS = 3;
  const t = new Date(trade.ts).getTime();
  const actual = trade.eventActualStartTime ? new Date(trade.eventActualStartTime).getTime() : null;
  const eventStart = trade.eventStartTime ? new Date(trade.eventStartTime).getTime() : null;
  const close = trade.closeTime ? new Date(trade.closeTime).getTime() : null;

  let cutoff = actual;
  if (!cutoff) {
    if (!eventStart && !close) return null;
    const isLiveBet = eventStart && close && close - eventStart > 24 * HR;
    cutoff = isLiveBet ? eventStart - GAME_DURATION_HOURS * HR : (eventStart ?? close);
  }
  return t < cutoff ? 'pre' : 'live';
}

const TradeCard = memo(function TradeCard({ trade }) {
  const isYes = trade.side === 'yes';
  const price = isYes ? trade.yesPrice : trade.noPrice;
  const isWhale = trade.count >= 500;
  const isMega = trade.count >= 2000;
  const pick = trade.source === 'polymarket'
    ? trade.outcome
    : (isYes ? trade.yesSub : trade.noSub);
  const timing = timingBadge(trade);
  const isPoly = (trade.source ?? 'kalshi') === 'polymarket';

  return (
    <div className={`trade-card${isMega ? ' trade-card--megawhale' : isWhale ? ' trade-card--whale' : ''}`}>
      <div className="trade-card__top">
        <span className={`badge ${isPoly ? 'badge--polymarket' : 'badge--kalshi'}`}>
          {isPoly ? 'POLY' : 'KALSHI'}
        </span>
        <span className="trade-card__cat">{trade.category}</span>
        {timing && <span className={`badge badge--${timing}`}>{timing.toUpperCase()}</span>}
        <span className="trade-card__time">{fmtTime(trade.ts)}</span>
      </div>

      <div className="trade-card__title">{trade.title ?? trade.ticker}</div>

      <div className={`trade-card__pick side--${trade.side}`}>
        {isYes ? '🟢' : '🔴'} {trade.side.toUpperCase()}{pick ? `: ${pick}` : ''}
      </div>

      <div className="trade-card__stats">
        <span className="td--price">{fmtPrice(price)}</span>
        <span className={isWhale ? 'td--size-whale' : ''}>
          {trade.count.toLocaleString()}{isMega ? ' 🐳' : isWhale ? ' 🐋' : ''}
        </span>
        <span className="trade-card__notional">{fmtNotional(trade.count, price)}</span>
      </div>
    </div>
  );
});

export default function TradeCards({ trades }) {
  if (trades.length === 0) {
    return <div className="cards-wrapper"><div className="empty-row">Waiting for trades…</div></div>;
  }
  return (
    <div className="cards-wrapper">
      {trades.map((t) => <TradeCard key={t.id} trade={t} />)}
    </div>
  );
}
