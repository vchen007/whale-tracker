export default function FilterBar({
  minSize, onMinSize,
  category, onCategory, categories,
  side, onSide,
  timeRange, onTimeRange, timeRanges,
  sortBy, onSortBy,
  totalShown, totalAll,
}) {
  return (
    <div className="filter-bar">
      <div className="filter-group">
        <span className="filter-label">TIME</span>
        <div className="time-range-btns">
          {timeRanges.map((r) => (
            <button
              key={r.label}
              className={`time-btn${timeRange === r.label ? ' time-btn--active' : ''}`}
              onClick={() => onTimeRange(r.label)}
            >
              {r.label}
            </button>
          ))}
        </div>
      </div>

      <label className="filter-group">
        <span className="filter-label">MIN $ VALUE</span>
        <input
          className="filter-input"
          type="number"
          min="0"
          placeholder="1000"
          value={minSize}
          onChange={(e) => onMinSize(e.target.value)}
        />
      </label>

      <label className="filter-group">
        <span className="filter-label">CATEGORY</span>
        <select
          className="filter-select"
          value={category}
          onChange={(e) => onCategory(e.target.value)}
        >
          <option value="">ALL</option>
          {categories.map((c) => (
            <option key={c} value={c}>{c}</option>
          ))}
        </select>
      </label>

      <label className="filter-group">
        <span className="filter-label">SIDE</span>
        <select
          className="filter-select"
          value={side}
          onChange={(e) => onSide(e.target.value)}
        >
          <option value="">ALL</option>
          <option value="yes">YES</option>
          <option value="no">NO</option>
        </select>
      </label>

      <div className="filter-group">
        <span className="filter-label">SORT BY</span>
        <div className="time-range-btns">
          {['notional', 'time'].map((s) => (
            <button
              key={s}
              className={`time-btn${sortBy === s ? ' time-btn--active' : ''}`}
              onClick={() => onSortBy(s)}
            >
              {s === 'notional' ? '$ SIZE' : 'RECENT'}
            </button>
          ))}
        </div>
      </div>

      <span className="filter-count">
        {totalShown.toLocaleString()} / {totalAll.toLocaleString()} trades
      </span>
    </div>
  );
}
