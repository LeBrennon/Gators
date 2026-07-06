# Lightning-delay watch

A gameday-ops helper for lightning delays at the ballpark. It taps the
Blitzortung / lightningmaps.org real-time strike feed, filters strikes to a
radius around the park, and runs the 30-minute delay clock for you.

> **Decision support only — not the decision.** Blitzortung is a community
> network that is explicitly *"for entertainment only, not for protecting
> people or equipment."* It can miss strikes and mislocate them. Always
> cross-check the NWS radar lightning layer and your own eyes/ears. The
> go/no-go is the operator's call, not the tool's.

## The rule it implements

- Any strike **inside the clearing radius** (default **6 mi**) → **clear the
  field** and start a **30-minute** clock.
- **Every** new strike inside the radius **restarts** the 30-minute clock.
- The field can reopen **30 minutes after the last strike inside the radius**.

The commonly cited guidance is an 8–10 mi radius; we ran 6 mi. Set whatever
your safety plan calls for with `--radius`.

## Run it

```bash
node tools/lightning-delay.js                 # Joe Miller Ballpark, 6 mi
node tools/lightning-delay.js --radius 8      # 8 mi clearing radius
node tools/lightning-delay.js --lat 30.17 --lon -93.21 --name "Some Park"
```

Requires Node 18+ (uses the built-in global `WebSocket`; tested on Node 22).
No `npm install` — it's a single dependency-free file. Leave it running in a
terminal during the delay; it reprints a status line every ~20s and shouts
(a `*** ... ***` banner) on the events that matter.

### Flags

| flag | default | meaning |
|------|---------|---------|
| `--lat` / `--lon` | Joe Miller Ballpark | park coordinates |
| `--name` | `Joe Miller Ballpark` | label in the header |
| `--radius <mi>` | `6` | clearing radius — strike inside = clear + reset clock |
| `--close <mi>` | `3` | danger-close alert radius |
| `--hold <min>` | `30` | quiet time inside radius before all-clear |
| `--tz <zone>` | `America/Chicago` | IANA timezone for display |
| `--every <sec>` | `20` | status readout interval |

## What it tells you

- **FIELD DOWN** — the last strike inside the radius, the earliest restart
  time, and how long it's been quiet.
- **DANGER-CLOSE** banner — a strike inside `--close` (default 3 mi).
- **10-MINUTE WARNING** — once it's been quiet long enough that restart is 10
  min out.
- **ALL CLEAR** — the full hold has elapsed with no strike inside the radius.
- **Feed health** — every line ends with `feed OK` or `FEED SILENT …`. This
  matters: because the tool only logs *nearby* strikes, a long local quiet
  could mean "storm moved off" **or** "socket died." The feed-health tag uses a
  global heartbeat (any strike anywhere) to tell them apart. If it says
  `FEED SILENT`, don't trust an all-clear until the socket is back.

## How it works (for the next person)

- Connects to a Blitzortung WebSocket (`wss://ws1.blitzortung.org/`, with
  fallbacks) and subscribes with `{"a":111}`.
- Strikes stream in as an LZW-compressed JSON string; `decode()` is the same
  decompressor the lightningmaps.org client uses. Each strike has `lat`, `lon`,
  and `time` (nanoseconds since epoch).
- Distance is haversine miles from the park; direction is an 8-point compass
  bearing.
- The server drops the socket roughly every ~6 minutes; the tool auto-reconnects
  within ~2s, so brief gaps are expected and coverage stays effectively continuous.

## History

Built live during the 7/5/2026 delay at Joe Miller Ballpark. That night the
storm circled the park for ~1.5 hours, throwing sub-2-mile strikes from every
quadrant and repeatedly resetting the clock just as it neared restart — a good
reminder not to reopen on a short lull.
