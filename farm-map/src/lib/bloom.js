// Bloom-window math. Bloom windows are "MM-DD" strings that recur every year,
// so all reasoning is done in day-of-year space against a fixed 365-day ring.

const MONTH_DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
const SOON_DAYS = 21 // "budding soon" / "just past" window on either side

export function dayOfYear(mmdd) {
  const [m, d] = mmdd.split('-').map(Number)
  let doy = d
  for (let i = 0; i < m - 1; i++) doy += MONTH_DAYS[i]
  return doy
}

export function dateToMMDD(date) {
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${m}-${d}`
}

// Forward distance a -> b around the 365-day ring (always 0..364).
function forward(a, b) {
  return ((b - a) % 365 + 365) % 365
}

function inWindow(t, s, e) {
  return s <= e ? t >= s && t <= e : t >= s || t <= e
}

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

export function formatMMDD(mmdd) {
  const [m, d] = mmdd.split('-').map(Number)
  return `${MONTH_NAMES[m - 1]} ${d}`
}

// Status of one planting on a given "MM-DD" today.
//   state: 'blooming' | 'soon' | 'past' | 'dormant'
//   progress: 0..1 through the bloom window (only meaningful when blooming)
export function bloomStatus(planting, todayMMDD) {
  const t = dayOfYear(todayMMDD)
  const s = dayOfYear(planting.bloomStart)
  const e = dayOfYear(planting.bloomEnd)

  if (inWindow(t, s, e)) {
    const span = forward(s, e) || 1
    return { state: 'blooming', progress: forward(s, t) / span }
  }
  const untilStart = forward(t, s)
  if (untilStart <= SOON_DAYS) return { state: 'soon', progress: 0, days: untilStart }
  const sinceEnd = forward(e, t)
  if (sinceEnd <= SOON_DAYS) return { state: 'past', progress: 1, days: sinceEnd }
  return { state: 'dormant', progress: 0 }
}

// A zone is "in bloom" if any of its plantings are blooming.
export function zoneBloomState(zone, todayMMDD) {
  let best = 'dormant'
  const rank = { blooming: 3, soon: 2, past: 1, dormant: 0 }
  for (const p of zone.plantings) {
    const s = bloomStatus(p, todayMMDD).state
    if (rank[s] > rank[best]) best = s
  }
  return best
}

// Upcoming bloom events sorted by how soon they start from today.
export function upcomingBlooms(zones, todayMMDD, limit = 8) {
  const t = dayOfYear(todayMMDD)
  const events = []
  for (const zone of zones) {
    for (const p of zone.plantings) {
      const status = bloomStatus(p, todayMMDD)
      const startsIn = forward(t, dayOfYear(p.bloomStart))
      events.push({
        zoneId: zone.id,
        zoneName: zone.name,
        planting: p,
        status,
        startsIn: status.state === 'blooming' ? -1 : startsIn,
      })
    }
  }
  events.sort((a, b) => a.startsIn - b.startsIn)
  return limit ? events.slice(0, limit) : events
}
