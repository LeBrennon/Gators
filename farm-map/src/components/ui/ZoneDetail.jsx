// Detail card for the currently-selected zone: its plantings with live bloom
// status, notes, and the maintenance tasks scoped to it.

import { bloomStatus, formatMMDD, dateToMMDD } from '../../lib/bloom.js'
import { TASK_CATEGORIES } from '../../data/farm.js'
import { fromISO, daysBetween, relativeLabel } from '../../lib/dates.js'

const STATE_LABEL = {
  blooming: 'In bloom',
  soon: 'Budding soon',
  past: 'Just finished',
  dormant: 'Dormant',
}

function BloomChip({ planting, todayMMDD }) {
  const st = bloomStatus(planting, todayMMDD)
  let extra = ''
  if (st.state === 'soon') extra = ` · ${st.days}d`
  if (st.state === 'blooming') extra = ` · ${Math.round(st.progress * 100)}%`
  return <span className={`chip bloom-${st.state}`}>{STATE_LABEL[st.state]}{extra}</span>
}

export default function ZoneDetail({ zone, viewDate, tasks, toggleTask, onClose }) {
  if (!zone) return null
  const todayMMDD = dateToMMDD(viewDate)
  const zoneTasks = tasks
    .filter((t) => t.zoneId === zone.id)
    .sort((a, b) => a.date.localeCompare(b.date))

  return (
    <div className="panel zone-detail">
      <div className="panel-head">
        <div>
          <div className="eyebrow">{zone.kind}</div>
          <h2>{zone.name}</h2>
        </div>
        <button className="btn btn-icon" onClick={onClose} aria-label="Close">×</button>
      </div>

      {zone.notes && <p className="zone-notes">{zone.notes}</p>}

      {zone.plantings.length > 0 && (
        <>
          <div className="section-title">Plantings</div>
          <ul className="planting-list">
            {zone.plantings.map((p) => (
              <li key={p.id} className="planting-row">
                <span className="swatch" style={{ background: p.bloomColor }} />
                <div className="planting-main">
                  <div className="planting-name">{p.name}</div>
                  <div className="planting-meta">
                    <em>{p.species}</em> · blooms {formatMMDD(p.bloomStart)}–{formatMMDD(p.bloomEnd)}
                  </div>
                </div>
                <BloomChip planting={p} todayMMDD={todayMMDD} />
              </li>
            ))}
          </ul>
        </>
      )}

      <div className="section-title">
        Maintenance <span className="count">{zoneTasks.length}</span>
      </div>
      {zoneTasks.length === 0 ? (
        <p className="empty">No tasks scheduled here.</p>
      ) : (
        <ul className="task-list">
          {zoneTasks.map((t) => {
            const cat = TASK_CATEGORIES[t.category] || TASK_CATEGORIES.other
            const days = daysBetween(viewDate, fromISO(t.date))
            return (
              <li key={t.id} className={`task-row ${t.done ? 'is-done' : ''}`}>
                <label className="task-check">
                  <input type="checkbox" checked={t.done} onChange={() => toggleTask(t.id)} />
                  <span className="dot" style={{ background: cat.color }} />
                </label>
                <div className="task-main">
                  <div className="task-title">{t.title}</div>
                  <div className="task-meta">{cat.label} · {relativeLabel(days)}</div>
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
