# Gators GameTracker — Cloud

A live Gators scoreboard you can run from a free host and watch on your iPhone.
It reads the Gators' current score and inning from the Texas League schedule and
pushes alerts on every run, lead change, and the final. Two files, no computer
needed.

What it shows: live score, inning, win/lead momentum, the full Gators schedule
with results, and in-app alerts. (Play-by-play, balls/strikes, and base runners
are the phase-2 upgrade that needs a 10-minute step on a computer.)

---

## Deploy it from your iPhone

You'll put the two files on GitHub, then point a free host at them. ~10 minutes.

### 1. Save the two files
From this chat, download **server.js** and **package.json** to your iPhone (they
land in the Files app).

### 2. Put them on GitHub
- Make a free account at github.com if you don't have one.
- Tap your profile → **Your repositories** → **New**. Name it `gators` and make
  it **Public**. Create it.
- On the empty repo, tap **Add file → Upload files**. (If the button's hidden,
  tap "Aa" in Safari's address bar → **Request Desktop Website**.)
- Upload `server.js` and `package.json` from your Files app. **Commit changes.**

### 3. Deploy on Render (free)
- Go to render.com, sign up with your GitHub account.
- **New → Web Service →** pick your `gators` repo.
- It auto-detects Node. Confirm: Build `npm install`, Start `node server.js`.
- Choose the **Free** instance type. **Create Web Service.**
- Wait for the build. You'll get a URL like `https://gators-xxx.onrender.com`.

### 4. Use it
Open that URL in Safari, then **Share → Add to Home Screen**. Tap the icon to
launch it like an app. Open it when a game's on and the score updates live.

---

## About "always-on" and alerts (read this)

Free hosts go to sleep after a stretch of no traffic and wake up in ~30 seconds
when you open the app. For watching a game that's fine — opening the tracker
wakes it, and it stays awake while you're on it.

The honest catch: because a free host sleeps when nobody's looking, **alerts only
fire while the app is open** (keep it on during the game and you'll get the
buzzes). For alerts when your phone's in your pocket and the app is fully closed,
you'd need a paid always-on tier (about $7/month on Render), since the server has
to stay awake to catch a run and send the push. Easy to switch on later — same
app, just flip the instance type.

---

## Optional: phone push (when the app is closed)

Only worth doing if you move to a paid always-on instance. You'll need a key pair:
- Generate one at a VAPID key generator (search "vapid key generator") — it gives
  a public and private key.
- In Render → your service → **Environment**, add:
  - `VAPID_PUBLIC_KEY` = the public key
  - `VAPID_PRIVATE_KEY` = the private key
  - `VAPID_CONTACT` = `mailto:youremail`
- Redeploy. In the app tap **Get alerts** and allow notifications.
- On iPhone, push only works from the **home-screen** version (add to home screen
  first), on iOS 16.4 or newer.

---

## Settings (Render → Environment), all optional

- `POLL_MS` — how often to check the schedule (default 15000 ms).
- `SCHEDULE_URL` — defaults to the 2026 Texas League baseball schedule.

## Files
```
server.js      everything: schedule poller + app + alerts (one file)
package.json   dependencies
```
