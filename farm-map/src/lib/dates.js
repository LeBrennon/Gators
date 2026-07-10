// Calendar helpers shared by the UI. The whole app reasons about a single
// "view date" within the 2026 season, which drives both the blooms in the
// 3D scene and the maintenance schedule.

export const SEASON_YEAR = 2026
// The farm's "today" — matches the seeded schedule around mid-July.
export const TODAY = new Date(SEASON_YEAR, 6, 10)

export function startOfYear() {
  return new Date(SEASON_YEAR, 0, 1)
}

export function dateToIndex(date) {
  return Math.round((date - startOfYear()) / 86400000)
}

export function indexToDate(index) {
  const d = new Date(startOfYear())
  d.setDate(d.getDate() + index)
  return d
}

export function toISO(date) {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

export function fromISO(iso) {
  const [y, m, d] = iso.split('-').map(Number)
  return new Date(y, m - 1, d)
}

// Whole-day difference (b - a), positive if b is later.
export function daysBetween(a, b) {
  const da = new Date(a.getFullYear(), a.getMonth(), a.getDate())
  const db = new Date(b.getFullYear(), b.getMonth(), b.getDate())
  return Math.round((db - da) / 86400000)
}

const SEASONS = [
  { name: 'Winter', emoji: '❄️' }, // Dec, Jan, Feb
  { name: 'Spring', emoji: '🌸' }, // Mar, Apr, May
  { name: 'Summer', emoji: '☀️' }, // Jun, Jul, Aug
  { name: 'Fall', emoji: '🍂' }, // Sep, Oct, Nov
]

export function season(date) {
  const m = date.getMonth()
  if (m <= 1 || m === 11) return SEASONS[0]
  if (m <= 4) return SEASONS[1]
  if (m <= 7) return SEASONS[2]
  return SEASONS[3]
}

const LONG = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December']

export function formatLong(date) {
  return `${LONG[date.getMonth()]} ${date.getDate()}, ${date.getFullYear()}`
}

export function relativeLabel(days) {
  if (days === 0) return 'Today'
  if (days === 1) return 'Tomorrow'
  if (days === -1) return 'Yesterday'
  if (days < 0) return `${-days} days ago`
  return `in ${days} days`
}
