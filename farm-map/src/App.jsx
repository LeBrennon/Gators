import { useState } from 'react'
import FarmScene from './components/FarmScene.jsx'
import Sidebar from './components/ui/Sidebar.jsx'
import ZoneDetail from './components/ui/ZoneDetail.jsx'
import DateControl from './components/ui/DateControl.jsx'
import { FARM } from './data/farm.js'
import { useTasks } from './lib/store.js'
import { TODAY } from './lib/dates.js'

export default function App() {
  const [viewDate, setViewDate] = useState(() => new Date(TODAY))
  const [selectedId, setSelectedId] = useState(null)
  const { tasks, toggleTask, addTask, deleteTask, resetTasks } = useTasks()

  const selectedZone = FARM.zones.find((z) => z.id === selectedId) || null

  return (
    <div className="app">
      <div className="scene-layer">
        <FarmScene viewDate={viewDate} selectedId={selectedId} onSelect={setSelectedId} />
      </div>

      <header className="brand panel">
        <div className="brand-mark">🌿</div>
        <div>
          <h1>{FARM.name}</h1>
          <div className="brand-sub">{FARM.location} · {FARM.zone}</div>
        </div>
      </header>

      <div className="overlay overlay-right">
        <Sidebar
          zones={FARM.zones}
          viewDate={viewDate}
          tasks={tasks}
          addTask={addTask}
          toggleTask={toggleTask}
          deleteTask={deleteTask}
          resetTasks={resetTasks}
          onSelectZone={setSelectedId}
        />
      </div>

      {selectedZone && (
        <div className="overlay overlay-left">
          <ZoneDetail
            zone={selectedZone}
            viewDate={viewDate}
            tasks={tasks}
            toggleTask={toggleTask}
            onClose={() => setSelectedId(null)}
          />
        </div>
      )}

      <div className="overlay overlay-bottom">
        <DateControl viewDate={viewDate} setViewDate={setViewDate} />
      </div>
    </div>
  )
}
