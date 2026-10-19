# Ticker Belt

A scrolling stock ticker that floats on your desktop. Frameless, transparent,
draggable, and it remembers where you left it.

Prices are currently simulated. See *Adding live prices* below.

---

## Running it the first time

You need two things installed once:

1. **Node.js** — https://nodejs.org (LTS is fine)
2. **Rust** — https://rustup.rs
3. **Visual Studio Build Tools** with the "Desktop development with C++"
   workload — https://visualstudio.microsoft.com/visual-cpp-build-tools/
   Rust needs the MSVC linker on Windows; without it the first build fails
   with a `link.exe not found` error.

Then:

```
npm install
npm run dev
```

The first build compiles a few hundred Rust crates and takes several minutes.
Every build after that is seconds.

## Using the widget

- **Move it** — drag anywhere on the bar, including the scrolling tape itself.
- **Resize it** — drag the left or right edge, or use the width presets.
- **Chart** — hover a quote for a moment to see today's price line. It
  draws from prices the widget has seen while the market was open, so it
  fills in as the day goes on. The belt holds still while it's open.
  With a free Twelve Data key (settings, optional) the chart shows the
  full day from the API instead, plus 1W and 1M ranges. Requests stay
  inside the free tier: cached, at most 8 a minute and 700 a day, and
  only for the quote you're hovering. If Twelve Data can't answer, the
  chart falls back to collected prices and says "Local data".
- **Settings** — the gear icon. The window grows to make room: downward
  when the bar is near the top of the screen, upward near the bottom.
- **Quit** — the × icon. The widget stays out of the taskbar, so this is the
  only way out.

## Building an installer

```
npm run build
```

The installer lands in `src-tauri/target/release/bundle/nsis/`. It's roughly
3–6 MB because Tauri uses the WebView2 runtime already present in Windows
instead of shipping a browser.

## Sharing it

First time only, from the project folder:

```
git init
git add .
git commit -m "Ticker Belt v0.1.0"
gh repo create ticker-belt --public --source=. --push
```

That needs the GitHub CLI (`winget install GitHub.cli`, then `gh auth login`).
Claude Code can run all of it for you.

Then tag a release:

```
git tag v0.1.0
git push origin v0.1.0
```

`.github/workflows/release.yml` builds the installer and attaches it to a
draft release. Publish the draft and send people the link.

**They will see a warning.** The app is unsigned, so Windows SmartScreen says
"publisher unknown" and requires More info → Run anyway. That's the honest
cost of not paying for a certificate. If this ever outgrows your friends,
Microsoft's Azure Artifact Signing is about $10/month and is the cheapest
route; note that signing doesn't remove the warning immediately, since
reputation accrues per file over download history.

## Live prices

Open settings, paste a free Finnhub key, done. Get one at
finnhub.io/register. With no key the widget runs on simulated prices, so it
still works for anyone who doesn't want to bother.

The status chip on the left tells you what's going on:

| Chip | Meaning |
|---|---|
| `Demo` | No key. Prices are made up. |
| `14:32` (green) | Live, with the time of the last update. |
| `Bad key` | Finnhub rejected the key. |
| `Throttled` | Rate limit hit. Pick a slower refresh. |
| `Offline` | Couldn't reach Finnhub. |

Each user brings their own key, stored locally and never bundled into the
binary. That matters: strings are trivially extractable from an executable,
so a shared key would leak the moment you hand someone the installer, and
you'd all be fighting over one rate limit.

Ten symbols on the 30-second refresh is about 20 calls a minute against a
limit of 60. Twenty symbols at 15 seconds would blow past it, which is what
`Throttled` is telling you when it appears.

**Licensing:** Finnhub's free tier is for personal, non-commercial use. Fine
for you and your friends. If this ever becomes something you charge for,
you'd need a different plan or a different provider.

**Outside market hours** Finnhub returns the last close, so prices sit still.
That's correct, not a bug.

### Using a different provider

The only piece that knows about Finnhub is `fetchQuotes()` in `src/app.js`.
Swap the URL and the response mapping and everything else keeps working. Add
the new host to `connect-src` in the CSP in `src-tauri/tauri.conf.json`, or
requests will be blocked with a console error and no obvious cause.

## Layout

```
src/                  the widget — plain HTML, CSS, JS, no build step
  index.html
  styles.css
  app.js              settings, the scroll loop, the data handoff point
src-tauri/
  tauri.conf.json     window flags: frameless, transparent, always on top
  src/main.rs         app entry; registers the window-state plugin
  capabilities/       which Tauri APIs the frontend is allowed to call
```

## Gotchas worth knowing before you edit

- **`html` and `body` must stay transparent.** Give them a background and the
  webview paints an opaque rectangle over your rounded corners.
- **Buttons inside a drag region never fire.** The drag region swallows the
  click. The gear and × sit outside it on purpose.
- **`.track` has `pointer-events: none`.** Without it the individual quote
  elements intercept mousedown and dragging the tape won't move the window.
- **Permissions are explicit.** Calling a new Tauri API from JS means adding
  its permission to `src-tauri/capabilities/default.json` or it fails at
  runtime with a permission error.
- **If the window renders blank**, the CSP is usually the culprit. Setting
  `"csp": null` in `tauri.conf.json` temporarily will confirm it.
