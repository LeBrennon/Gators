// Right-hand sidebar with two tabs: the maintenance Schedule (add / check off
// tasks) and the Bloom calendar (what's flowering, and what's next).

import { useMemo, useState } from 'react'
import { TASK_CATEGORIES } from '../../data/farm.js'
import { upcomingBlooms, formatMMDD, dateToMMDD } from '../../lib/bloom.js'
import { fromISO, daysBetween, relativeLabel, toISO } from '../../lib/dates.js'

function TaskRow({ task, zoneName, viewDate, toggleTask, deleteTask }) {
  const cat = TASK_CATEGORIES[task.category] || TASK_CATEGORIES.other
  const days = daysBetween(viewDate, fromISO(task.date))
  const overdue = !task.done && days < 0
  return (
    <li className={`task-row ${task.done ? 'is-done' : ''} ${overdue ? 'is-overdue' : ''}`}>
      <label className="task-check">
        <input type="checkbox" checked={task.done} onChange={() => toggleTask(task.id)} />
        <span className="dot" style={{ background: cat.color }} />
      </label>
      <div className="task-main">
        <div className="task-title">{task.title}</div>
        <div className="task-meta">
          {zoneName} · {cat.label} · <span className={overdue ? 'overdue-text' : ''}>{relativeLabel(days)}</span>
          {task.recurring && <span className="recur" title={`every ${task.intervalDays} days`}>↻</span>}
        </div>
      </div>
      <button className="btn btn-icon subtle" onClick={() => deleteTask(task.id)} aria-label="Delete">×</button>
    </li>
  )
}

function AddTaskForm({ zones, viewDate, addTask, onDone }) {
  const [title, setTitle] = useState('')
  const [zoneId, setZoneId] = useState(zones[0]?.id ?? '')
  const [category, setCategory] = useState('water')
  const [date, setDate] = useState(toISO(viewDate))

  const submit = (e) => {
    e.preventDefault()
    if (!title.trim()) return
    addTask({ title: title.trim(), zoneId, category, date })
    onDone()
  }

  return (
    <form className="add-form" onSubmit={submit}>
      <input className="input" placeholder="Task, e.g. Deadhead roses" value={title}
        onChange={(e) => setTitle(e.target.value)} autoFocus />
      <div className="add-row">
        <select className="input" value={zoneId} onChange={(e) => setZoneId(e.target.value)}>
          {zones.filter((z) => z.kind !== 'structure').map((z) => (
            <option key={z.id} value={z.id}>{z.name}</option>
          ))}
        </select>
        <select className="input" value={category} onChange={(e) => setCategory(e.target.value)}>
          {Object.entries(TASK_CATEGORIES).map(([k, v]) => (
            <option key={k} value={k}>{v.label}</option>
          ))}
        </select>
      </div>
      <div className="add-row">
        <input className="input" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        <button className="btn btn-primary" type="submit">Add task</button>
      </div>
    </form>
  )
}

export default function Sidebar({ zones, viewDate, tasks, addTask, toggleTask, deleteTask, resetTasks, onSelectZone }) {
  const [tab, setTab] = useState('schedule')
  const [adding, setAdding] = useState(false)
  const zoneName = useMemo(() => Object.fromEntries(zones.map((z) => [z.id, z.name])), [zones])
  const todayMMDD = dateToMMDD(viewDate)

  const { open, done } = useMemo(() => {
    const sorted = [...tasks].sort((a, b) => a.date.localeCompare(b.date))
    return {
      open: sorted.filter((t) => !t.done),
      done: sorted.filter((t) => t.done),
    }
  }, [tasks])

  const blooms = useMemo(() => upcomingBlooms(zones, todayMMDD, 12), [zones, todayMMDD])

  return (
    <div className="panel sidebar">
      <div className="tabs">
        <button className={`tab ${tab === 'schedule' ? 'active' : ''}`} onClick={() => setTab('schedule')}>
          Schedule
        </button>
        <button className={`tab ${tab === 'blooms' ? 'active' : ''}`} onClick={() => setTab('blooms')}>
          Blooms
        </button>
      </div>

      {tab === 'schedule' && (
        <div className="tab-body">
          <div className="toolbar">
            <button className="btn btn-primary sm" onClick={() => setAdding((v) => !v)}>
              {adding ? 'Cancel' : '+ Add task'}
            </button>
            <button className="btn btn-ghost sm" onClick={resetTasks} title="Restore the seeded schedule">
              Reset
            </button>
          </div>

          {adding && (
            <AddTaskForm zones={zones} viewDate={viewDate} addTask={addTask} onDone={() => setAdding(false)} />
          )}

          <div className="section-title">Up next <span className="count">{open.length}</span></div>
          {open.length === 0 ? (
            <p className="empty">All caught up 🌿</p>
          ) : (
            <ul className="task-list">
              {open.map((t) => (
                <TaskRow key={t.id} task={t} zoneName={zoneName[t.zoneId] || '—'}
                  viewDate={viewDate} toggleTask={toggleTask} deleteTask={deleteTask} />
              ))}
            </ul>
          )}

          {done.length > 0 && (
            <>
              <div className="section-title muted">Completed <span className="count">{done.length}</span></div>
              <ul className="task-list">
                {done.map((t) => (
                  <TaskRow key={t.id} task={t} zoneName={zoneName[t.zoneId] || '—'}
                    viewDate={viewDate} toggleTask={toggleTask} deleteTask={deleteTask} />
                ))}
              </ul>
            </>
          )}
        </div>
      )}

      {tab === 'blooms' && (
        <div className="tab-body">
          <p className="hint">Tap a bloom to fly the map to it. Drag the timeline below to watch the season change.</p>
          <ul className="bloom-list">
            {blooms.map(({ planting, zoneId, zoneName: zn, status, startsIn }) => (
              <li key={planting.id} className="bloom-row" onClick={() => onSelectZone(zoneId)}>
                <span className="swatch" style={{ background: planting.bloomColor }} />
                <div className="bloom-main">
                  <div className="bloom-name">{planting.name}</div>
                  <div className="bloom-meta">{zn} · {formatMMDD(planting.bloomStart)}–{formatMMDD(planting.bloomEnd)}</div>
                </div>
                <span className={`chip bloom-${status.state}`}>
                  {status.state === 'blooming' ? 'Now' : status.state === 'soon' ? `${startsIn}d` :
                    status.state === 'past' ? 'Done' : `${startsIn}d`}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}
