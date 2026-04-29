import { memo } from 'react';

function fmtTime(isoString) {
  try {
    return new Date(isoString).toLocaleTimeString('en-US', { hour12: false, timeZoneName: 'short' });
  } catch {
    return '--:--:--';
  }
}

function fmtDate(isoString) {
  try {
    return new Date(isoString).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  } catch {
    return '—';
  }
}

function fmtPrice(cents) {
  if (cents == null) return '—';
  return `${cents}¢`;
}

function fmtNotional(count, priceCents) {
  if (priceCents == null) return '—';
  const dollars = (count * priceCents) / 100;
  if (dollars >= 1_000_000) return `$${(dollars / 1_000_000).toFixed(2)}M`;
  if (dollars >= 1_000) return `$${(dollars / 1_000).toFixed(1)}K`;
  return `$${dollars.toFixed(0)}`;
}

const TradeRow = memo(function TradeRow({ trade }) {
  const isYes = trade.side === 'yes';
  const price = isYes ? trade.yesPrice : trade.noPrice;
  const notional = fmtNotional(trade.count, price);

  // Whale size thresholds: highlight big trades
  const isWhale = trade.count >= 500;
  const isMegaWhale = trade.count >= 2000;

  return (
    <tr
      className={[
        'trade-row',
        isYes ? 'trade-row--yes' : 'trade-row--no',
        isWhale ? 'trade-row--whale' : '',
        isMegaWhale ? 'trade-row--megawhale' : '',
      ]
        .filter(Boolean)
        .join(' ')}
    >
      <td className="td td--mono">{fmtDate(trade.ts)}</td>
      <td className="td td--mono">{fmtTime(trade.ts)}</td>
      <td className="td td--ticker" title={trade.ticker}>
        {trade.ticker}
      </td>
      <td className="td td--title" title={trade.title ?? ''}>
        {trade.title ?? '—'}
      </td>
      <td className="td td--cat">{trade.category}</td>
      <td className="td td--timing">
        {trade.closeTime
          ? new Date(trade.ts) < new Date(trade.closeTime)
            ? <span className="badge badge--pre">PRE</span>
            : <span className="badge badge--live">LIVE</span>
          : <span className="badge badge--unknown">—</span>}
      </td>
      <td className={`td td--side side--${trade.side}`}>
        {trade.side.toUpperCase()}
      </td>
      <td className="td td--price">{fmtPrice(price)}</td>
      <td className={`td td--size ${isWhale ? 'td--size-whale' : ''}`}>
        {trade.count.toLocaleString()}
        {isMegaWhale && ' 🐳'}
        {isWhale && !isMegaWhale && ' 🐋'}
      </td>
      <td className="td td--notional">{notional}</td>
      <td className="td td--mono td--tradeid" title={trade.tradeId ?? ''}>{trade.tradeId ?? '—'}</td>
    </tr>
  );
});

export default TradeRow;
