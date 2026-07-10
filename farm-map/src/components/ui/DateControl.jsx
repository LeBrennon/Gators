// Bottom scrubber: drag through the year to watch the farm bloom and fade.

import { dateToIndex, indexToDate, season, formatLong, TODAY } from '../../lib/dates.js'

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

export default function DateControl({ viewDate, setViewDate }) {
  const index = dateToIndex(viewDate)
  const s = season(viewDate)

  return (
    <div className="date-control panel">
      <div className="date-control-head">
        <div className="date-season">
          <span className="season-emoji">{s.emoji}</span>
          <div>
            <div className="date-long">{formatLong(viewDate)}</div>
            <div className="date-sub">{s.name} · Willow Bend season</div>
          </div>
        </div>
        <button className="btn btn-ghost" onClick={() => setViewDate(new Date(TODAY))}>
          Jump to today
        </button>
      </div>

      <input
        className="date-slider"
        type="range"
        min={0}
        max={364}
        value={index}
        onChange={(e) => setViewDate(indexToDate(Number(e.target.value)))}
        aria-label="Date of year"
      />
      <div className="month-ticks">
        {MONTHS.map((m) => (
          <span key={m}>{m}</span>
        ))}
      </div>
    </div>
  )
}
