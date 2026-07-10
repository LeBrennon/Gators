// Tiny persistence layer. No backend: the editable state (the maintenance
// task list) lives in localStorage, seeded from src/data/farm.js on first run.

import { useEffect, useState, useCallback } from 'react'
import { FARM } from '../data/farm.js'

const KEY = 'willow-bend-farm/v1'

function loadTasks() {
  try {
    const raw = localStorage.getItem(KEY)
    if (raw) {
      const parsed = JSON.parse(raw)
      if (Array.isArray(parsed.tasks)) return parsed.tasks
    }
  } catch {
    /* fall through to seed */
  }
  return FARM.tasks.map((t) => ({ ...t }))
}

function saveTasks(tasks) {
  try {
    localStorage.setItem(KEY, JSON.stringify({ tasks }))
  } catch {
    /* storage full or unavailable — non-fatal */
  }
}

let counter = 0
function newId() {
  counter += 1
  return `t-user-${counter}-${counter * 7 + 3}`
}

// React hook: returns the task list and mutators, persisting on every change.
export function useTasks() {
  const [tasks, setTasks] = useState(loadTasks)

  useEffect(() => {
    saveTasks(tasks)
  }, [tasks])

  const toggleTask = useCallback((id) => {
    setTasks((prev) => prev.map((t) => (t.id === id ? { ...t, done: !t.done } : t)))
  }, [])

  const addTask = useCallback((task) => {
    setTasks((prev) => [...prev, { id: newId(), done: false, recurring: false, ...task }])
  }, [])

  const deleteTask = useCallback((id) => {
    setTasks((prev) => prev.filter((t) => t.id !== id))
  }, [])

  const resetTasks = useCallback(() => {
    setTasks(FARM.tasks.map((t) => ({ ...t })))
  }, [])

  return { tasks, toggleTask, addTask, deleteTask, resetTasks }
}
