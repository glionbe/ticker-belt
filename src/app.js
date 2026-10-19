/* Ticker Belt — widget logic
 *
 * Runs in Tauri, and also in a plain browser (handy for styling work) —
 * every Tauri call is guarded so nothing explodes when the API is absent.
 */
(function () {
  "use strict";

  // --- Tauri bridge (withGlobalTauri: true means no bundler, no imports) ---
  var TAURI = window.__TAURI__ || null;
  var win = TAURI ? TAURI.window.getCurrentWindow() : null;
  var PhysicalSize = TAURI ? TAURI.window.PhysicalSize : null;
  var PhysicalPosition = TAURI ? TAURI.window.PhysicalPosition : null;
  var invoke = TAURI && TAURI.core ? TAURI.core.invoke : null;

  var KEY = "tickerbelt.widget.v1";
  var ALERT_KEY = "tickerbelt.alerts.v1";   // armed/triggered state, see checkAlerts()
  var HIST_KEY = "tickerbelt.history.v1.";  // + symbol: today's prices, see recordLive()
  var GEO_KEY = "tickerbelt.geo.v1";        // how far the window is grown upward, see applyLayout()

  var DEFAULTS = {
    symbols: ["AAPL","MSFT","NVDA","AMZN","GOOGL","META","TSLA","JPM","V","SPY"],
    alerts: {},             // { NVDA: ">150" } — only symbols that have a target
    apiKey: "",
    tdKey: "",              // Twelve Data, optional: real chart history
    range: "1D",            // hover chart range, used with tdKey
    refresh: 30,
    speed: 55,
    opacity: 92,
    dir: "left",
    size: "standard",
    width: 900,
    chg: "pct",
    theme: "dark",
    ontop: true,
    hoverpause: true,
    autostart: false,
    // Global hotkeys, "" = off. Rust keeps the real copy, see get_shortcuts.
    shortcuts: { ontop: "Ctrl+Alt+P", toggle: "Ctrl+Alt+B", settings: "Ctrl+Alt+S" }
  };

  var SIZES = {
    slim:     { h: 32, fs: 13 },
    standard: { h: 44, fs: 15 },
    tall:     { h: 58, fs: 18 }
  };

  var PAD = 6;              // matches --pad in styles.css
  var MAX_PANEL = 620;      // don't grow the window past this

  // Starting points for demo mode.
  var SEED = {
    AAPL: 228.40, MSFT: 432.10, NVDA: 139.25, AMZN: 201.60, GOOGL: 176.85,
    META: 585.30, TSLA: 248.90, JPM: 232.75, V: 302.15, SPY: 586.20
  };

  var settings = load();
  var market = {};
  var nodes = {};
  var panelOpen = false;
  var timer = null;
  var inFlight = false;
  var alertState = loadAlertState();

  // ------------------------------------------------------------------ state
  function load() {
    var s = {};
    for (var k in DEFAULTS) s[k] = DEFAULTS[k];
    try {
      var raw = localStorage.getItem(KEY);
      if (raw) {
        var saved = JSON.parse(raw);
        for (var j in DEFAULTS) if (saved[j] !== undefined) s[j] = saved[j];
      }
    } catch (e) {}
    if (!Array.isArray(s.symbols) || !s.symbols.length) s.symbols = DEFAULTS.symbols.slice();
    // Settings saved before alerts existed have none, which is fine. Drop
    // anything that doesn't parse or no longer matches a symbol in the list.
    var alerts = {};
    s.symbols.forEach(function (sym) {
      var t = s.alerts && s.alerts[sym];
      if (typeof t === "string" && parseTarget(t)) alerts[sym] = t;
    });
    s.alerts = alerts;
    if (["1D", "1W", "1M"].indexOf(s.range) < 0) s.range = "1D";
    // A fresh object either way: DEFAULTS' own must never be edited.
    var keys = {};
    for (var a in DEFAULTS.shortcuts) {
      keys[a] = s.shortcuts && typeof s.shortcuts[a] === "string" ? s.shortcuts[a] : DEFAULTS.shortcuts[a];
    }
    s.shortcuts = keys;
    return s;
  }

  function save() {
    try { localStorage.setItem(KEY, JSON.stringify(settings)); } catch (e) {}
  }

  function live() { return !!(settings.apiKey && settings.apiKey.trim()); }

  // ------------------------------------------------------------- status
  function setStatus(cls, text, detail) {
    var dot = document.getElementById("dot");
    dot.className = "dot" + (cls ? " " + cls : "");
    document.getElementById("statusText").textContent = text;
    document.getElementById("status").title = detail || "";
  }

  function clockText() {
    var d = new Date();
    return d.getHours().toString().padStart(2, "0") + ":" +
           d.getMinutes().toString().padStart(2, "0");
  }

  // ------------------------------------------------------------- demo data
  function basePrice(sym) {
    if (SEED[sym]) return SEED[sym];
    var n = 0;
    for (var i = 0; i < sym.length; i++) n = (n * 31 + sym.charCodeAt(i)) % 100000;
    return 20 + (n % 48000) / 100;
  }

  function seedMarket() {
    settings.symbols.forEach(function (sym) {
      if (market[sym]) return;
      var p = basePrice(sym);
      market[sym] = { prev: p, last: p * (1 + (Math.random() - 0.48) * 0.02) };
      demoHist[sym] = [];   // a fresh demo price starts a fresh demo chart
    });
  }

  function simulate() {
    seedMarket();
    for (var sym in market) {
      var m = market[sym];
      if (m.bad) continue;
      m.last = Math.max(0.5, m.last + (Math.random() - 0.5) * m.last * 0.0016);
    }
    setStatus("", "Demo", "Simulated prices. Add an API key in settings for live quotes.");
    checkAlerts();
    paint();
  }

  // ------------------------------------------------------------- live data
  /* Finnhub's /quote returns:
   *   c  current price      pc  previous close
   *   d  change             dp  percent change
   * An unknown symbol comes back with every field zeroed rather than a 404,
   * which is why we check for c > 0 rather than trusting the status code.
   *
   * Requests go one at a time. Ten symbols is ten calls, well inside the
   * free tier's 60 per minute even on the 15-second refresh. */
  async function fetchQuotes() {
    if (inFlight) return;
    inFlight = true;

    var key = settings.apiKey.trim();
    var syms = settings.symbols.slice();
    var got = 0, problem = null;

    for (var i = 0; i < syms.length; i++) {
      var sym = syms[i];
      try {
        var res = await fetch(
          "https://finnhub.io/api/v1/quote?symbol=" + encodeURIComponent(sym) +
          "&token=" + encodeURIComponent(key)
        );

        if (res.status === 401 || res.status === 403) {
          problem = { cls: "off", text: "Bad key", detail: "Finnhub rejected the API key." };
          break;
        }
        if (res.status === 429) {
          problem = { cls: "warn", text: "Throttled", detail: "Rate limit hit. Try a slower refresh." };
          break;
        }
        if (!res.ok) {
          problem = { cls: "warn", text: "Error " + res.status, detail: "Finnhub returned " + res.status + "." };
          break;
        }

        var q = await res.json();
        if (q && typeof q.c === "number" && q.c > 0) {
          market[sym] = { prev: (q.pc && q.pc > 0) ? q.pc : q.c, last: q.c };
          got++;
        } else {
          // Symbol the exchange doesn't recognise — keep it visible but blank.
          market[sym] = { prev: 0, last: 0, bad: true };
        }
      } catch (e) {
        problem = { cls: "off", text: "Offline", detail: "Couldn't reach Finnhub." };
        break;
      }
    }

    if (problem) setStatus(problem.cls, problem.text, problem.detail);
    else if (got) setStatus("live", clockText(), "Live quotes, updated " + clockText() + ".");
    else setStatus("warn", "No data", "No symbols returned a price.");

    checkAlerts();
    paint();
    inFlight = false;
  }

  // ---------------------------------------------------------- market hours
  /* US equities trade 9:30-16:00 Eastern, Monday to Friday. This is worked
   * out in America/New_York with Intl, never from the machine's local clock,
   * so it's right from any time zone and across daylight-saving changes.
   *
   * Known limitation: there is no holiday calendar, so a market holiday counts
   * as open. The cost is a little extra polling, which is harmless. */
  var OPEN_SECS = 9 * 3600 + 30 * 60;     // 09:30 ET
  var CLOSE_SECS = 16 * 3600;             // 16:00 ET
  var CLOSED_EVERY = 5 * 60 * 1000;       // poll this slowly while closed
  var DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  var ET_CLOCK = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York", weekday: "short",
    hour: "numeric", minute: "numeric", second: "numeric", hourCycle: "h23"
  });

  function easternNow(d) {
    var o = {};
    ET_CLOCK.formatToParts(d).forEach(function (p) { o[p.type] = p.value; });
    return {
      day: DAYS.indexOf(o.weekday),
      secs: Number(o.hour) * 3600 + Number(o.minute) * 60 + Number(o.second)
    };
  }

  function marketOpen(d) {
    var e = easternNow(d || new Date());
    return e.day >= 1 && e.day <= 5 && e.secs >= OPEN_SECS && e.secs < CLOSE_SECS;
  }

  // How long to wait before the next poll.
  function nextDelay() {
    if (!live()) return 1600;
    var every = settings.refresh * 1000;
    var e = easternNow(new Date());
    if (marketOpen()) return every;
    var wait = CLOSED_EVERY;
    // Before the bell on a weekday: wake up for the open instead of
    // sleeping through up to five minutes of it.
    if (e.day >= 1 && e.day <= 5 && e.secs < OPEN_SECS) {
      wait = Math.min(wait, (OPEN_SECS - e.secs) * 1000 + 1000);
    }
    return wait;
  }

  // fetchQuotes() reports a timestamp on success. While the market is closed
  // swap that for "Closed", but leave any error chip (Bad key, Offline, ...) alone.
  function showClosed() {
    if (!live() || marketOpen()) return;
    if (!document.getElementById("dot").classList.contains("live")) return;
    setStatus("", "Closed", "US market closed (9:30–16:00 ET, Mon–Fri). Showing the latest " +
      "prices, checked at " + clockText() + ". Rechecking every 5 minutes.");
  }

  function tick() {
    if (live()) fetchQuotes().then(showClosed).then(recordLive).then(drawChart);
    else { simulate(); recordDemo(); drawChart(); }
  }

  function run() {
    tick();
    timer = setTimeout(run, nextDelay());
  }

  function schedule() {
    clearTimeout(timer);
    run();
  }

  // --------------------------------------------------------------- history
  /* The hover chart draws prices we've seen ourselves; there's no history
   * API. Each live quote that arrives while the market is open is appended
   * as [ms, price] under HIST_KEY + symbol, tagged with its session day.
   * Closed-market polls are skipped, or the 5-minute overnight checks would
   * draw a flat line through to the next open.
   *
   * Only the latest session is kept. Older days are dropped on startup, and
   * a record from an older day starts over on its next append (the app may
   * run across days). Past MAX_POINTS the series is thinned to every other
   * point rather than trimmed, so a 15-second refresh still covers the day.
   *
   * Storage can throw (quota, blocked, ...), so writes are best-effort and
   * the chart reads the copy in memory. Demo prices stay in memory only, so
   * they never mix with real ones. */
  var MAX_POINTS = 1000;
  var hist = {};                // live: sym -> { day: "2026-10-16", pts: [[ms, price], ...] }
  var demoHist = {};            // demo: sym -> [[ms, price], ...]
  var recorded = new WeakSet(); // quotes already seen; fetchQuotes() makes a new object per fresh quote
  var ET_DATE = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit"
  });

  function etDate(t) {
    var o = {};
    ET_DATE.formatToParts(new Date(t)).forEach(function (p) { o[p.type] = p.value; });
    return o.year + "-" + o.month + "-" + o.day;
  }

  // The ET date of the latest session that has started: today after the
  // open, otherwise the last weekday before. Before Monday's bell that's
  // Friday, which is also the session Finnhub's last price belongs to.
  function sessionDay(d) {
    var t = d.getTime(), e = easternNow(d);
    if (!(e.day >= 1 && e.day <= 5 && e.secs >= OPEN_SECS)) {
      // Step to the last second of the previous ET day until it's a weekday.
      do { t -= (e.secs + 1) * 1000; e = easternNow(new Date(t)); } while (e.day < 1 || e.day > 5);
    }
    return etDate(t);
  }

  function thin(pts) {
    if (pts.length <= MAX_POINTS) return pts;
    return pts.filter(function (p, i) { return i % 2 === 0 || i === pts.length - 1; });
  }

  function loadHistory() {
    var day = sessionDay(new Date()), stale = [];
    try {
      for (var i = 0; i < localStorage.length; i++) {
        var k = localStorage.key(i);
        if (!k || k.indexOf(HIST_KEY) !== 0) continue;
        var rec = null;
        try { rec = JSON.parse(localStorage.getItem(k)); } catch (e) {}
        if (rec && rec.day === day && Array.isArray(rec.pts)) hist[k.slice(HIST_KEY.length)] = rec;
        else stale.push(k);
      }
      stale.forEach(function (k) { localStorage.removeItem(k); });
    } catch (e) {}
  }

  function recordLive() {
    var open = marketOpen(), day = open ? sessionDay(new Date()) : null, now = Date.now();
    settings.symbols.forEach(function (sym) {
      var m = market[sym];
      if (!m || m.bad || !(m.last > 0) || recorded.has(m)) return;
      // Marked even while closed, so a pre-open quote isn't logged at the bell.
      recorded.add(m);
      if (!open) return;
      var rec = hist[sym];
      if (!rec || rec.day !== day) rec = hist[sym] = { day: day, pts: [] };
      rec.pts.push([now, m.last]);
      rec.pts = thin(rec.pts);
      try { localStorage.setItem(HIST_KEY + sym, JSON.stringify(rec)); } catch (e) {}
    });
  }

  function recordDemo() {
    var now = Date.now();
    settings.symbols.forEach(function (sym) {
      var m = market[sym];
      if (!m || m.bad) return;
      var pts = demoHist[sym] || (demoHist[sym] = []);
      pts.push([now, m.last]);
      demoHist[sym] = thin(pts);
    });
  }

  function seriesFor(sym) {
    if (!live()) return demoHist[sym] || [];
    var rec = hist[sym];
    return rec && rec.day === sessionDay(new Date()) ? rec.pts : [];
  }

  // ----------------------------------------------------------- twelve data
  /* Optional real history for the hover chart, with 1D / 1W / 1M ranges.
   * Used only with a Twelve Data key AND live Finnhub quotes: on demo prices
   * the header would contradict a real chart. Without it, or whenever it
   * can't be had, the chart uses the self-collected history above.
   *
   * The free tier is 8 requests a minute and 800 a day (one per symbol per
   * request), and a hover along the belt could spend that in seconds, so:
   *   - responses are cached per symbol and range for TD_RANGES[r].ttl;
   *   - a request goes out only for the chart that's open, never ahead;
   *   - at most TD_PER_MIN in any rolling minute and TD_PER_DAY per Eastern
   *     day (under the 800 wall), counted in localStorage so a restart
   *     doesn't reset them. Over budget nothing is queued: the chart shows
   *     stale cache or local data until there's room;
   *   - a symbol/range that failed waits TD_RETRY before it's tried again.
   *
   * Errors arrive as HTTP 200 with status "error", so the body decides. */
  var TD_STORE = "tickerbelt.twelvedata.v1";   // the request budget
  var TD_RANGES = {
    "1D": { interval: "5min",  size: 78, ms: 5 * 60e3,  ttl: 5 * 60e3 },
    "1W": { interval: "30min", size: 65, ms: 30 * 60e3, ttl: 60 * 60e3 },
    "1M": { interval: "1day",  size: 22, ms: 86400e3,   ttl: 4 * 60 * 60e3 }
  };
  var TD_PER_MIN = 8, TD_PER_DAY = 700, TD_RETRY = 60e3;
  var tdCache = {};     // "AAPL|1D" -> { pts, at }
  var tdState = {};     // "AAPL|1D" -> { busy, failedAt, why }
  var tdKeyBad = false; // rejected; no more requests until the key changes
  var tdBudget = loadBudget();
  var ET_FULL = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York", hourCycle: "h23", year: "numeric", month: "2-digit",
    day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit"
  });

  function tdOn() { return live() && !!settings.tdKey; }

  // The New York wall-clock time at instant t, written as if it were UTC.
  function easternAsUTC(t) {
    var o = {};
    ET_FULL.formatToParts(new Date(t)).forEach(function (p) { o[p.type] = p.value; });
    return Date.UTC(+o.year, o.month - 1, +o.day, +o.hour % 24, +o.minute, +o.second);
  }

  /* "2026-10-16 15:55:00" is New York time with no zone on it; new Date()
   * would read it as local time, an hour off from Central. Start from the
   * digits as UTC and correct by New York's offset at that moment (twice,
   * in case the first guess sits across a DST change). A date with no time
   * is a daily bar, placed at the close. */
  function fromEastern(s) {
    var m = /^(\d{4})-(\d\d)-(\d\d)(?:[ T](\d\d):(\d\d)(?::(\d\d))?)?$/.exec(s || "");
    if (!m) return NaN;
    var wall = Date.UTC(+m[1], m[2] - 1, +m[3], m[4] ? +m[4] : 16, +(m[5] || 0), +(m[6] || 0));
    var t = wall;
    for (var i = 0; i < 2; i++) t = wall - (easternAsUTC(t) - t);
    return t;
  }

  function loadBudget() {
    try {
      var b = JSON.parse(localStorage.getItem(TD_STORE));
      if (b && typeof b.count === "number" && Array.isArray(b.recent)) return b;
    } catch (e) {}
    return { day: "", count: 0, recent: [] };
  }

  // Why a request can't go out now, or "" if it can.
  function tdBlocked() {
    var now = Date.now(), day = etDate(now);
    if (tdBudget.day !== day) { tdBudget.day = day; tdBudget.count = 0; }   // midnight Eastern
    tdBudget.recent = tdBudget.recent.filter(function (t) { return now - t < 60e3; });
    if (tdBudget.count >= TD_PER_DAY) return "Daily Twelve Data budget used up.";
    if (tdBudget.recent.length >= TD_PER_MIN) return "Twelve Data rate limit, retrying shortly.";
    return "";
  }

  function tdSpend() {
    tdBudget.recent.push(Date.now());
    tdBudget.count++;
    try { localStorage.setItem(TD_STORE, JSON.stringify(tdBudget)); } catch (e) {}
  }

  function tdWhy(body, sym) {
    var code = body && body.code;
    if (code === 401 || code === 403) return "Twelve Data rejected the key.";
    if (code === 429) return "Twelve Data rate limit, retrying shortly.";
    if (code === 400 || code === 404) return "Twelve Data has no data for " + sym + ".";
    return "Twelve Data returned an error.";
  }

  // Start a fetch for this chart if it needs one and the budget allows.
  function tdRequest(sym, range) {
    var k = sym + "|" + range, r = TD_RANGES[range], now = Date.now();
    var st = tdState[k] || (tdState[k] = {}), hit = tdCache[k];
    if (hit && now - hit.at < r.ttl) return;
    if (st.busy || (st.failedAt && now - st.failedAt < TD_RETRY)) return;
    if (tdKeyBad) { st.why = tdWhy({ code: 401 }); return; }
    var blocked = tdBlocked();
    if (blocked) { st.why = blocked; return; }

    st.busy = true;
    tdSpend();
    var key = settings.tdKey;
    fetch("https://api.twelvedata.com/time_series?symbol=" + encodeURIComponent(sym) +
          "&interval=" + r.interval + "&outputsize=" + r.size + "&apikey=" + encodeURIComponent(key))
      .then(function (res) { return res.json(); })
      .then(function (body) {
        if (!body || body.status !== "ok" || !Array.isArray(body.values)) {
          if (body && (body.code === 401 || body.code === 403) && key === settings.tdKey) tdKeyBad = true;
          throw new Error(tdWhy(body, sym));
        }
        // Sent newest first. Sorted rather than reversed, so order can't bite.
        var pts = body.values
          .map(function (v) { return [fromEastern(v.datetime), Number(v.close)]; })
          .filter(function (p) { return p[0] > 0 && p[1] > 0; })
          .sort(function (a, b) { return a[0] - b[0]; });
        if (!pts.length) throw new Error(tdWhy({ code: 404 }, sym));
        if (key !== settings.tdKey) return;            // key changed while in flight
        tdCache[k] = { pts: pts, at: Date.now() };
        st.failedAt = 0; st.why = "";
      })
      .catch(function (e) {
        st.failedAt = Date.now();
        st.why = e instanceof TypeError ? "Couldn't reach Twelve Data." : e.message;
      })
      .then(function () {
        st.busy = false;
        if (chart && chart.sym === sym && settings.range === range) drawChart();
      });
  }

  /* What the chart should draw: points, how x is laid out, the reference
   * line, the direction for the color, and a note when it had to fall back.
   *   x "session": the trading day, 9:30 to 16:00, so 1D fills in across.
   *   x "data":    first to last point (demo ticks are seconds apart).
   *   x "index":   evenly spaced, so 1W/1M skip nights and weekends. */
  function chartSeries(sym, m, cls) {
    var local = { pts: seriesFor(sym), x: live() ? "session" : "data", base: m.prev, dir: cls, note: "" };
    if (!tdOn()) return local;

    var range = settings.range, r = TD_RANGES[range], k = sym + "|" + range;
    tdRequest(sym, range);
    var hit = tdCache[k], st = tdState[k] || {};
    var pts = hit ? hit.pts.slice() : null, now = Date.now();

    if (pts && range === "1D") {
      // 78 bars can reach back into the day before; keep the last session.
      // If that isn't today's session (data lagging the open), use local.
      var day = etDate(pts[pts.length - 1][0]);
      pts = pts.filter(function (p) { return etDate(p[0]) === day; });
      if (day !== sessionDay(new Date())) pts = null;
    }

    if (!pts) {
      local.note = st.busy ? "Loading…" : "Local data";
      local.why = st.busy ? "" : (st.why || "Twelve Data unavailable.") +
        (range === "1D" ? " Showing prices collected today." : " Showing today's collected prices.");
      return local;
    }

    // End on the live price, so the line finishes where the header does.
    var last = pts[pts.length - 1];
    if (range === "1D") {
      // Bars lag; fill the gap with what we've collected since, then live.
      seriesFor(sym).forEach(function (p) { if (p[0] > last[0]) pts.push(p); });
      var close = fromEastern(etDate(last[0]));   // 16:00 that day
      pts.push([Math.max(pts[pts.length - 1][0], Math.min(now, close)), m.last]);
      return { pts: pts, x: "session", base: m.prev, dir: cls, note: "" };
    }
    // 1W / 1M: the live price replaces the latest bar's close if that bar is
    // from the current session and still open (or the market has closed);
    // otherwise, say a new day with no bar yet, it's a point of its own.
    var current = etDate(last[0]) === sessionDay(new Date());
    if (current && (!marketOpen() || now - last[0] < r.ms)) pts[pts.length - 1] = [last[0], m.last];
    else pts.push([now, m.last]);
    var first = pts[0][1], d = m.last - first;
    return {
      pts: pts, x: "index", base: first, note: "",
      dir: d > first * 1e-5 ? "up" : (d < -first * 1e-5 ? "down" : "flat")
    };
  }

  // ---------------------------------------------------------- price alerts
  /* Each alert is either armed (price on the near side of the target) or
   * triggered (it has crossed). It notifies only on armed -> triggered, then
   * stays quiet until the price goes back across and re-arms it. Without this
   * every refresh would notify again for as long as the price stayed past.
   *
   * State is keyed by "NVDA>150", so editing a target starts it fresh, and is
   * saved so a restart (including the updater's) doesn't re-notify. A target
   * seen for the first time takes the current side as its baseline without
   * notifying: if NVDA is already at 160 when you type NVDA>150 it highlights
   * but doesn't notify, since nothing crossed. */
  function loadAlertState() {
    try {
      var o = JSON.parse(localStorage.getItem(ALERT_KEY));
      return o && typeof o === "object" ? o : {};
    } catch (e) { return {}; }
  }

  function saveAlertState() {
    var keep = {};   // forget targets that have been edited away
    settings.symbols.forEach(function (sym) {
      var id = settings.alerts[sym] ? sym + settings.alerts[sym] : null;
      if (id && id in alertState) keep[id] = alertState[id];
    });
    alertState = keep;
    try { localStorage.setItem(ALERT_KEY, JSON.stringify(alertState)); } catch (e) {}
  }

  // `was` is undefined (never seen), false (armed) or true (triggered).
  function alertStep(was, hit) {
    return { now: hit, fire: was === false && hit };
  }

  function checkAlerts() {
    // Outside market hours live prices are the last close and don't move, so
    // there's nothing to cross. Hold the current state until the open.
    if (live() && !marketOpen()) return;

    var changed = false;
    settings.symbols.forEach(function (sym) {
      var target = settings.alerts[sym], m = market[sym];
      if (!target || !m || m.bad || !(m.last > 0)) return;
      var t = parseTarget(target), id = sym + target;
      var step = alertStep(alertState[id], t.op === ">" ? m.last > t.price : m.last < t.price);
      if (step.fire) notifyAlert(sym, m.last, t);
      if (alertState[id] !== step.now) { alertState[id] = step.now; changed = true; }
    });

    if (changed) {
      saveAlertState();
      requestAnimationFrame(measure);   // the ALERT tag changes the belt's width
    }
  }

  function alertOn(sym) {
    var t = settings.alerts[sym];
    return !!t && alertState[sym + t] === true;
  }

  // The notification plugin replaces window.Notification with a version that
  // goes through Tauri, so this is the plain web API. Skipped in a browser.
  function notifyAlert(sym, price, t) {
    if (!TAURI || typeof window.Notification !== "function") return;
    var above = t.op === ">";
    try {
      new window.Notification(sym + (above ? " rose above " : " fell below ") + money(t.price), {
        body: sym + " is at " + money(price) + ", " + (above ? "above" : "below") +
              " your " + money(t.price) + " alert." + (live() ? "" : " (Demo prices.)")
      });
    } catch (e) {}
  }

  // ------------------------------------------------------ global shortcuts
  /* The widget almost never has keyboard focus, so these are OS-level
   * hotkeys, registered and handled in Rust (see main.rs). Rust also keeps
   * the bindings, since it registers them at launch before this page runs;
   * settings.shortcuts mirrors them and whatever Rust reports back wins.
   *
   * A combo is captured from the next keydown, never typed in. Its key part
   * comes from KeyboardEvent.code, the physical key, which is what Tauri's
   * accelerator parser reads, so a binding doesn't shift with the layout.
   * While a row is capturing, Rust lets go of the current hotkeys; otherwise
   * pressing one would run its action instead of reaching this page. */
  var keyErrors = {};      // action -> why Rust couldn't register it
  var capturing = null;    // { action, msg } while a row waits for keys
  var toastTimer = null;

  // Keys other than letters, digits, F1-F24 and the numpad, by code -> label.
  var KEY_NAMES = {
    Minus: "-", Equal: "=", BracketLeft: "[", BracketRight: "]", Backslash: "\\",
    Semicolon: ";", Quote: "'", Comma: ",", Period: ".", Slash: "/", Backquote: "`",
    Space: "Space", Enter: "Enter", Tab: "Tab", Backspace: "Backspace", Delete: "Delete",
    Insert: "Insert", Home: "Home", End: "End", PageUp: "PageUp", PageDown: "PageDown",
    ArrowUp: "Up", ArrowDown: "Down", ArrowLeft: "Left", ArrowRight: "Right"
  };

  // The accelerator's key part for a KeyboardEvent.code, or null if unusable.
  function accelKey(code) {
    var m = /^(?:Key([A-Z])|Digit(\d))$/.exec(code);
    if (m) return m[1] || m[2];
    if (/^(?:F(?:[1-9]|1\d|2[0-4])|Numpad\d)$/.test(code)) return code;
    return KEY_NAMES[code] ? code : null;
  }

  // Input from remote-desktop or macro tools can arrive with no code; for
  // the common keys the legacy keyCode still says which one it was.
  function codeFromKeyCode(k) {
    if (k >= 65 && k <= 90) return "Key" + String.fromCharCode(k);
    if (k >= 48 && k <= 57) return "Digit" + (k - 48);
    if (k >= 112 && k <= 135) return "F" + (k - 111);
    return "";
  }

  // "Ctrl+Alt+BracketLeft" -> "Ctrl+Alt+["
  function keyLabel(accel) {
    if (!accel) return "Off";
    var parts = accel.split("+"), k = parts.pop();
    return parts.concat(KEY_NAMES[k] || k.replace(/^Numpad/, "Num")).join("+");
  }

  // { accel } for a usable combo, { why } for one to refuse, or { wait }
  // while only modifiers are down.
  function comboOf(e) {
    if (e.metaKey || e.key === "Meta" || e.key === "OS") {
      return { why: "Windows keeps Win+ shortcuts for itself. Try Ctrl+Alt instead." };
    }
    if (["Control", "Alt", "Shift", "AltGraph"].indexOf(e.key) >= 0) return { wait: true };
    var key = accelKey(e.code || codeFromKeyCode(e.keyCode));
    if (!key) return { why: "That key can't be used in a shortcut." };
    if (!e.ctrlKey && !e.altKey) return { why: "Include Ctrl or Alt, so it doesn't get in the way of typing." };
    var mods = [];
    if (e.ctrlKey) mods.push("Ctrl");
    if (e.altKey) mods.push("Alt");
    if (e.shiftKey) mods.push("Shift");
    return { accel: mods.concat(key).join("+") };
  }

  function renderKeys() {
    Array.prototype.forEach.call(document.querySelectorAll(".keyRow"), function (row) {
      var a = row.dataset.action, accel = settings.shortcuts[a] || "";
      var here = !!capturing && capturing.action === a;
      var text = here ? capturing.msg : (keyErrors[a] ? "Not active: " + keyErrors[a] : "");
      var cap = row.querySelector(".keyCap"), msg = row.querySelector(".keyMsg");
      cap.textContent = here ? "Press keys…" : keyLabel(accel);
      cap.classList.toggle("capturing", here);
      cap.classList.toggle("off", !accel && !here);
      cap.title = here ? "Esc cancels" : "Click to change";
      cap.setAttribute("aria-label", row.querySelector(".keyName").textContent + ": " +
        (here ? "press the new keys, Esc cancels" : keyLabel(accel) + ". Click to change"));
      row.querySelector(".keyClear").disabled = !accel;
      row.classList.toggle("bad", !!text);
      msg.hidden = !text;
      msg.textContent = text;
    });
  }

  // Rust's answer to get/set/resume: the bindings it holds and what failed.
  function gotShortcuts(r) {
    if (!r || !r.binds) return;
    for (var a in DEFAULTS.shortcuts) if (typeof r.binds[a] === "string") settings.shortcuts[a] = r.binds[a];
    keyErrors = r.errors || {};
    save(); renderKeys();
  }

  function startCapture(action) {
    if (capturing && capturing.action === action) return;
    var paused = !!capturing;
    capturing = { action: action, msg: "" };
    renderKeys();
    if (!paused && invoke) invoke("pause_shortcuts").catch(function () {});
  }

  // Cancelled (Esc, clicked away, panel closed): put the current set back.
  function endCapture() {
    if (!capturing) return;
    capturing = null;
    renderKeys();
    if (invoke) invoke("resume_shortcuts").then(gotShortcuts).catch(function () {});
  }

  function setShortcut(action, accel) {
    capturing = null;
    settings.shortcuts[action] = accel;
    save(); renderKeys();
    if (invoke) invoke("set_shortcuts", { binds: settings.shortcuts }).then(gotShortcuts).catch(function () {});
  }

  function captureKey(e) {
    if (!capturing) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.key === "Escape") { endCapture(); return; }
    var c = comboOf(e);
    if (c.wait) return;
    if (!c.why) {
      for (var a in settings.shortcuts) {
        if (a !== capturing.action && settings.shortcuts[a] === c.accel) {
          var other = document.querySelector('.keyRow[data-action="' + a + '"] .keyName').textContent;
          c.why = keyLabel(c.accel) + " is already used for " + other.toLowerCase() + ".";
        }
      }
    }
    if (c.why) { capturing.msg = c.why; renderKeys(); return; }   // keep listening
    setShortcut(capturing.action, c.accel);
  }

  // A brief note over the tape, for a shortcut with nothing else to show.
  function toast(text) {
    var el = document.getElementById("toast");
    el.textContent = text;
    el.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.classList.remove("show"); }, 1200);
  }

  // ------------------------------------------------------------- rendering
  function money(n) {
    return n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  function changeOf(m) {
    if (m.bad) return { px: "—", text: "not found", cls: "flat" };
    var d = m.last - m.prev;
    var pct = m.prev ? (d / m.prev) * 100 : 0;
    var mark = d > 0.004 ? "▲" : (d < -0.004 ? "▼" : "–");
    var sign = d >= 0 ? "+" : "−";
    var abs = sign + money(Math.abs(d));
    var per = sign + Math.abs(pct).toFixed(2) + "%";
    var body = settings.chg === "abs" ? abs : (settings.chg === "both" ? abs + "  " + per : per);
    return { px: money(m.last), text: mark + " " + body, cls: d > 0.004 ? "up" : (d < -0.004 ? "down" : "flat") };
  }

  function buildQuote(sym) {
    var el = document.createElement("div");
    el.className = "quote";
    // The quote takes pointer events now (for the hover chart), so it needs
    // its own drag region. "deep" so a press on the text inside drags too.
    el.setAttribute("data-tauri-drag-region", "deep");
    el.addEventListener("mouseenter", function () { hoverQuote(sym, el); });
    el.addEventListener("mouseleave", leaveSoon);
    var s = document.createElement("span"); s.className = "sym"; s.textContent = sym;
    var p = document.createElement("span"); p.className = "px";
    var c = document.createElement("span"); c.className = "chg";
    // Text tag, not just a tint: red/green already means up/down here.
    var f = document.createElement("span"); f.className = "flag";
    el.appendChild(s); el.appendChild(p); el.appendChild(c); el.appendChild(f);
    nodes[sym].push({ el: el, px: p, chg: c, flag: f });
    return el;
  }

  function render() {
    var track = document.getElementById("track");
    track.innerHTML = "";
    nodes = {};
    settings.symbols.forEach(function (s) { nodes[s] = []; });

    // Two identical copies so the loop can wrap without a visible seam.
    for (var copy = 0; copy < 2; copy++) {
      var wrap = document.createElement("div");
      wrap.style.display = "flex";
      wrap.setAttribute("aria-hidden", copy === 1 ? "true" : "false");
      settings.symbols.forEach(function (sym) { wrap.appendChild(buildQuote(sym)); });
      track.appendChild(wrap);
    }
    paint();
    requestAnimationFrame(measure);
  }

  function paint() {
    settings.symbols.forEach(function (sym) {
      var m = market[sym];
      if (!m || !nodes[sym]) return;
      var c = changeOf(m), hit = alertOn(sym);
      nodes[sym].forEach(function (n) {
        n.px.textContent = c.px;
        n.chg.textContent = c.text;
        n.chg.className = "chg " + c.cls;
        n.el.classList.toggle("hit", hit);
        n.flag.textContent = hit ? "ALERT " + settings.alerts[sym] : "";
      });
    });
  }

  // -------------------------------------------------------- the conveyor
  var offset = 0, copyW = 0, lastT = 0, hovering = false;

  function measure() {
    var first = document.getElementById("track").firstElementChild;
    copyW = first ? first.getBoundingClientRect().width : 0;
    if (copyW > 0 && offset > copyW) offset = offset % copyW;
  }

  function frame(t) {
    requestAnimationFrame(frame);
    if (!lastT) { lastT = t; return; }
    var dt = Math.min(0.1, (t - lastT) / 1000);
    lastT = t;

    if (!copyW) { measure(); return; }
    if (chart || (hovering && settings.hoverpause)) return;   // can't read a chart on a moving quote

    offset += (settings.dir === "right" ? -1 : 1) * settings.speed * dt;
    offset = ((offset % copyW) + copyW) % copyW;
    document.getElementById("track").style.transform =
      "translate3d(" + (-offset).toFixed(2) + "px, 0, 0)";
  }

  // ------------------------------------------------------- the hover chart
  /* Hovering a quote for OPEN_DELAY opens a small chart of today's prices,
   * attached above or below the bar (see applyLayout). It closes once the
   * pointer has been off both the quote and the chart for CLOSE_GRACE, which
   * also covers crossing the gap between them. The belt holds still while
   * it's open, whatever the hover-pause setting says.
   *
   * Settings wins over the chart: opening settings closes it, and it won't
   * open while settings is up. So the window only ever makes room for one. */
  var OPEN_DELAY = 200, CLOSE_GRACE = 150;
  var chart = null;          // { sym, el } while open
  var openTimer = null, closeTimer = null;
  var pressed = false;       // mouse held on the tape, maybe dragging the window
  var SVG_NS = "http://www.w3.org/2000/svg";

  function hoverQuote(sym, el) {
    clearTimeout(closeTimer);
    clearTimeout(openTimer);
    if (chart && chart.el === el) return;
    openTimer = setTimeout(function () {
      if (pressed || panelOpen || !el.matches(":hover")) return;
      openChart(sym, el);
    }, OPEN_DELAY);
  }

  function leaveSoon() {
    clearTimeout(openTimer);
    clearTimeout(closeTimer);
    closeTimer = setTimeout(function () {
      // Don't resize the window mid-drag; release() checks again after.
      if (!chart || pressed) return;
      if (chart.el.matches(":hover") || document.getElementById("chart").matches(":hover")) return;
      closeChart();
    }, CLOSE_GRACE);
  }

  function release() {
    if (!pressed) return;
    pressed = false;
    if (chart) leaveSoon();
  }

  function openChart(sym, el) {
    var m = market[sym];
    if (!m || m.bad) return;
    var swap = !!chart;
    chart = { sym: sym, el: el };
    var wrap = document.getElementById("chartWrap");
    var card = document.getElementById("chart");
    wrap.hidden = false;
    // Line the card up with the quote, kept inside the window.
    var room = wrap.clientWidth - card.offsetWidth;
    var x = el.getBoundingClientRect().left - wrap.getBoundingClientRect().left;
    card.style.marginLeft = Math.max(0, Math.min(room, Math.round(x))) + "px";
    drawChart();
    if (!swap) layout();     // moving to another quote reuses the room already made
  }

  function closeChart() {
    clearTimeout(openTimer);
    clearTimeout(closeTimer);
    if (!chart) return;
    chart = null;
    document.getElementById("chartWrap").hidden = true;
    layout();
  }

  function chartHeight() {
    if (!chart) return 0;
    return Math.ceil(document.getElementById("chartWrap").getBoundingClientRect().height);
  }

  function svgEl(tag, attrs) {
    var el = document.createElementNS(SVG_NS, tag);
    for (var k in attrs) el.setAttribute(k, attrs[k]);
    return el;
  }

  function drawChart() {
    if (!chart) return;
    var sym = chart.sym, m = market[sym];
    if (!m || m.bad) { closeChart(); return; }
    var c = changeOf(m), s = chartSeries(sym, m, c.cls), pts = s.pts;
    var card = document.getElementById("chart");
    var svg = document.getElementById("cSvg");

    card.setAttribute("data-dir", s.dir);
    document.getElementById("cSym").textContent = sym;
    document.getElementById("cPx").textContent = c.px;
    var chg = document.getElementById("cChg");
    chg.textContent = c.text;
    chg.className = "chg " + c.cls;

    // Ranges only exist with Twelve Data; without it the card is as before.
    card.classList.toggle("ranged", tdOn());
    Array.prototype.forEach.call(document.querySelectorAll("#cRange button"), function (b) {
      b.setAttribute("aria-pressed", String(b.dataset.v === settings.range));
    });
    var note = document.getElementById("cNote");
    note.textContent = s.note;
    note.title = s.why || "";

    // Fewer than three points isn't a line yet.
    var enough = pts.length >= 3;
    card.classList.toggle("empty", !enough);
    document.getElementById("cWhen").textContent =
      live() && !marketOpen() ? "Fills in while the market is open." : "";
    while (svg.firstChild) svg.removeChild(svg.firstChild);
    if (!enough) return;

    var w = svg.clientWidth, h = svg.clientHeight, inset = 3;
    svg.setAttribute("viewBox", "0 0 " + w + " " + h);

    // See chartSeries() for the three x layouts.
    var t0 = pts[0][0], t1 = pts[pts.length - 1][0];
    if (s.x === "session") {
      var open = t0 - (easternNow(new Date(t0)).secs - OPEN_SECS) * 1000;
      t0 = Math.min(t0, open);
      t1 = Math.max(t1, open + (CLOSE_SECS - OPEN_SECS) * 1000);
    }

    var lo = Infinity, hi = -Infinity;
    pts.forEach(function (p) { lo = Math.min(lo, p[1]); hi = Math.max(hi, p[1]); });
    document.getElementById("cHi").textContent = money(hi);
    document.getElementById("cLo").textContent = money(lo);
    // Keep the reference (previous close, or the range's start) in frame.
    var prev = s.base > 0 ? s.base : null;
    var top = prev ? Math.max(hi, prev) : hi, bot = prev ? Math.min(lo, prev) : lo;
    if (top - bot < top * 1e-6) { top *= 1.001; bot *= 0.999; }   // flat: centre it

    function X(t, i) {
      var f = s.x === "index" ? i / (pts.length - 1) : (t - t0) / ((t1 - t0) || 1);
      return (f * w).toFixed(1);
    }
    function Y(p) { return (inset + (top - p) / (top - bot) * (h - inset * 2)).toFixed(1); }

    var n = pts.length - 1;
    var line = pts.map(function (p, i) { return (i ? "L" : "M") + X(p[0], i) + " " + Y(p[1]); }).join("");
    var area = line + "L" + X(pts[n][0], n) + " " + h + "L" + X(pts[0][0], 0) + " " + h + "Z";

    var grad = svgEl("linearGradient", { id: "cFade", x1: 0, y1: 0, x2: 0, y2: 1 });
    grad.appendChild(svgEl("stop", { offset: 0, "class": "fade0" }));
    grad.appendChild(svgEl("stop", { offset: 1, "class": "fade1" }));
    var defs = svgEl("defs", {});
    defs.appendChild(grad);
    svg.appendChild(defs);
    svg.appendChild(svgEl("path", { d: area, "class": "area", fill: "url(#cFade)" }));
    if (prev) svg.appendChild(svgEl("line", { x1: 0, x2: w, y1: Y(prev), y2: Y(prev), "class": "prev" }));
    svg.appendChild(svgEl("path", { d: line, "class": "line" }));
  }

  // ----------------------------------------------------------- the window
  function barHeight() { return (SIZES[settings.size] || SIZES.standard).h; }

  function panelHeight() {
    if (!panelOpen) return 0;
    var inner = document.querySelector(".panelInner");
    var h = inner ? Math.ceil(inner.getBoundingClientRect().height) + 2 : 0;
    return Math.min(h, MAX_PANEL);
  }

  /* The window is the bar plus whatever is open (settings or the chart).
   * With the bar in the top half of its monitor that grows downward: size
   * only. In the bottom half it grows upward, so the window also moves up by
   * the same amount and the page flips to column-reverse, which keeps the
   * bar where it was on screen.
   *
   * All of this is in physical pixels. Position and monitor come back
   * physical and the scale factor needn't be 1 (or the same per monitor), so
   * the logical heights are converted once here and the size is set as
   * physical too. Everything is read fresh each call since the widget moves.
   *
   * `geo` is what the window has right now: how much extra height, and
   * whether it went upward. The window-state plugin saves the position as it
   * is at quit, so geo is saved as well and the next launch undoes it.
   * Calls are queued so a quick open-then-close can't interleave. */
  var geo = loadGeo();
  var geoQueue = Promise.resolve();

  function loadGeo() {
    try {
      var g = JSON.parse(localStorage.getItem(GEO_KEY));
      if (g && g.up && g.extra > 0) return { extra: g.extra, up: true };
    } catch (e) {}
    return { extra: 0, up: false };
  }

  function saveGeo() {
    try {
      if (geo.up) localStorage.setItem(GEO_KEY, JSON.stringify(geo));
      else localStorage.removeItem(GEO_KEY);
    } catch (e) {}
  }

  function layout() {
    geoQueue = geoQueue.then(applyLayout).catch(function () {});
  }

  async function applyLayout() {
    var widget = document.getElementById("widget");
    var want = panelOpen ? panelHeight() : chartHeight();    // logical px
    if (!win || !PhysicalSize) { widget.classList.remove("up"); return; }

    var f = await win.scaleFactor();
    var pos = await win.outerPosition();
    var mon = await TAURI.window.currentMonitor();

    var baseH = Math.round((barHeight() + PAD * 2) * f);
    var width = Math.round(settings.width * f);
    var top = pos.y + (geo.up ? geo.extra : 0);   // the window's top with nothing open
    var up = false, room = Infinity;
    if (mon) {
      // The work area leaves out the taskbar.
      var area = mon.workArea || { position: mon.position, size: mon.size };
      up = top + baseH / 2 > mon.position.y + mon.size.height / 2;
      room = up ? top - area.position.y
                : area.position.y + area.size.height - (top + baseH);
    }
    var extra = Math.max(0, Math.min(Math.round(want * f), room));
    var y = up ? top - extra : top;

    widget.classList.toggle("up", up);
    geo = { extra: extra, up: up && extra > 0 };
    saveGeo();
    // Sent together so the resize and the move land as close as possible.
    var jobs = [win.setSize(new PhysicalSize(width, baseH + extra))];
    if (y !== pos.y) jobs.push(win.setPosition(new PhysicalPosition(pos.x, y)));
    await Promise.all(jobs);
  }

  function applyChrome() {
    var root = document.documentElement;
    var sz = SIZES[settings.size] || SIZES.standard;
    root.setAttribute("data-theme", settings.theme);
    root.style.setProperty("--bar-h", sz.h + "px");
    root.style.setProperty("--bar-fs", sz.fs + "px");
    root.style.setProperty("--alpha", (settings.opacity / 100).toFixed(2));
    document.getElementById("widget").classList.toggle("open", panelOpen);
    if (win) win.setAlwaysOnTop(!!settings.ontop).catch(function () {});
  }

  function togglePanel(open) {
    panelOpen = open === undefined ? !panelOpen : open;
    if (!panelOpen) endCapture();
    if (panelOpen && chart) {             // settings takes the room, see the hover chart
      clearTimeout(closeTimer);
      chart = null;
      document.getElementById("chartWrap").hidden = true;
    }
    document.getElementById("panel").hidden = !panelOpen;
    document.getElementById("widget").classList.toggle("open", panelOpen);
    // Unhide first so the panel has a real height to measure.
    requestAnimationFrame(function () { layout(); requestAnimationFrame(measure); });
  }

  // ------------------------------------------------------------------ form
  function syncForm() {
    document.getElementById("symbols").value = settings.symbols
      .map(function (s) { return s + (settings.alerts[s] || ""); }).join(", ");
    document.getElementById("apikey").value = settings.apiKey;
    document.getElementById("tdkey").value = settings.tdKey;
    document.getElementById("speed").value = settings.speed;
    document.getElementById("speedVal").textContent = settings.speed;
    document.getElementById("opacity").value = settings.opacity;
    document.getElementById("opacityVal").textContent = settings.opacity + "%";
    document.getElementById("ontop").checked = !!settings.ontop;
    document.getElementById("hoverpause").checked = !!settings.hoverpause;
    document.getElementById("autostart").checked = !!settings.autostart;
    renderKeys();

    [["dir","dir"],["size","size"],["chg","chg"],["theme","theme"],
     ["width","width"],["refresh","refresh"]]
      .forEach(function (pair) {
        var group = document.getElementById(pair[0]);
        Array.prototype.forEach.call(group.querySelectorAll("button"), function (b) {
          b.setAttribute("aria-pressed", String(b.dataset.v == settings[pair[1]]));
        });
      });
  }

  function segment(id, key, coerce, after) {
    document.getElementById(id).addEventListener("click", function (e) {
      var b = e.target.closest("button");
      if (!b) return;
      settings[key] = coerce ? coerce(b.dataset.v) : b.dataset.v;
      save(); syncForm(); applyChrome();
      if (after) after();
    });
  }

  // ">150" -> { op: ">", price: 150 }. Anything else (">abc", ">", ">0") is null.
  function parseTarget(t) {
    var m = /^([<>])(\d+(?:\.\d+)?|\.\d+)$/.exec(t);
    return m && Number(m[2]) > 0 ? { op: m[1], price: Number(m[2]) } : null;
  }

  /* "AAPL, NVDA>150, TSLA < 300" -> symbols [AAPL, NVDA, TSLA] plus
   * alerts { NVDA: ">150", TSLA: "<300" }. A target that doesn't parse leaves
   * a plain symbol rather than dropping it. First mention of a symbol wins. */
  function readSymbols(raw) {
    var tokens = raw.toUpperCase().replace(/\s*([<>])\s*/g, "$1").split(/[,\s]+/);
    var seen = {}, out = [], alerts = {};
    tokens.forEach(function (tok) {
      var cut = tok.search(/[<>]/);
      var sym = (cut < 0 ? tok : tok.slice(0, cut)).replace(/[^A-Z0-9.\-]/g, "");
      if (!sym || seen[sym] || out.length >= 20) return;
      seen[sym] = 1; out.push(sym);
      var target = cut < 0 ? "" : tok.slice(cut);
      if (parseTarget(target)) alerts[sym] = target;
    });
    return { symbols: out, alerts: alerts };
  }

  // ------------------------------------------------------------------ wire
  document.getElementById("gear").addEventListener("click", function () { togglePanel(); });
  document.getElementById("close").addEventListener("click", function () {
    if (win) win.close(); else window.close();
  });

  // The tray's "Settings" item shows the window and asks us to open the panel.
  if (TAURI && TAURI.event) {
    TAURI.event.listen("open-settings", function () { togglePanel(true); }).catch(function () {});

    // Global shortcuts: Rust has already done the action, this is the UI.
    TAURI.event.listen("ontop-changed", function (e) {
      settings.ontop = !!e.payload;
      save();
      document.getElementById("ontop").checked = settings.ontop;
      toast("Always on top: " + (settings.ontop ? "on" : "off"));
    }).catch(function () {});
    TAURI.event.listen("toggle-settings", function () {
      togglePanel();
      if (panelOpen && win) win.setFocus().catch(function () {});   // ready to type in
    }).catch(function () {});
  }

  document.addEventListener("keydown", captureKey, true);
  Array.prototype.forEach.call(document.querySelectorAll(".keyRow"), function (row) {
    var a = row.dataset.action, cap = row.querySelector(".keyCap");
    cap.addEventListener("click", function () { startCapture(a); });
    cap.addEventListener("blur", endCapture);   // clicked elsewhere, or the window lost focus
    row.querySelector(".keyClear").addEventListener("click", function () { setShortcut(a, ""); });
  });

  document.getElementById("symbols").addEventListener("change", function (e) {
    var list = readSymbols(e.target.value);
    settings.symbols = list.symbols.length ? list.symbols : DEFAULTS.symbols.slice();
    settings.alerts = list.symbols.length ? list.alerts : {};
    market = {};
    save(); saveAlertState(); seedMarket(); render(); syncForm(); schedule();
  });

  document.getElementById("apikey").addEventListener("change", function (e) {
    settings.apiKey = e.target.value.trim();
    market = {};
    // Demo and live prices differ, so switching would look like a crossing.
    alertState = {}; saveAlertState();
    save(); seedMarket(); schedule();
  });

  document.getElementById("tdkey").addEventListener("change", function (e) {
    settings.tdKey = e.target.value.trim();
    tdCache = {}; tdState = {}; tdKeyBad = false;   // all of that was about the old key
    save();
  });

  document.getElementById("speed").addEventListener("input", function (e) {
    settings.speed = Number(e.target.value);
    document.getElementById("speedVal").textContent = settings.speed;
  });
  document.getElementById("speed").addEventListener("change", save);

  document.getElementById("opacity").addEventListener("input", function (e) {
    settings.opacity = Number(e.target.value);
    document.getElementById("opacityVal").textContent = settings.opacity + "%";
    document.documentElement.style.setProperty("--alpha", (settings.opacity / 100).toFixed(2));
  });
  document.getElementById("opacity").addEventListener("change", save);

  document.getElementById("ontop").addEventListener("change", function (e) {
    settings.ontop = e.target.checked; save(); applyChrome();
  });
  document.getElementById("hoverpause").addEventListener("change", function (e) {
    settings.hoverpause = e.target.checked; save();
  });
  document.getElementById("autostart").addEventListener("change", function (e) {
    var box = e.target, want = box.checked;
    if (!invoke) { settings.autostart = want; save(); return; }   // plain browser
    invoke("set_autostart", { enabled: want })
      .then(function () { settings.autostart = want; save(); })
      .catch(function () { box.checked = !want; });               // OS refused; keep the box honest
  });

  segment("dir", "dir");
  segment("chg", "chg", null, function () { paint(); requestAnimationFrame(measure); });
  segment("theme", "theme");
  segment("size", "size", null, function () { layout(); requestAnimationFrame(measure); });
  segment("width", "width", Number, function () { layout(); requestAnimationFrame(measure); });
  segment("refresh", "refresh", Number, schedule);

  document.getElementById("reset").addEventListener("click", function () {
    var keepKey = settings.apiKey;           // resetting layout shouldn't log you out
    var keepTd = settings.tdKey;
    var keepAuto = settings.autostart;       // ...or desync us from the OS startup entry
    var keepKeys = settings.shortcuts;       // ...or from the hotkeys Rust has registered
    settings = JSON.parse(JSON.stringify(DEFAULTS));
    settings.apiKey = keepKey;
    settings.tdKey = keepTd;
    settings.autostart = keepAuto;
    settings.shortcuts = keepKeys;
    market = {}; save(); saveAlertState(); seedMarket(); applyChrome(); syncForm(); render(); layout(); schedule();
  });

  var tape = document.getElementById("tape");
  tape.addEventListener("mouseenter", function () { hovering = true; });
  tape.addEventListener("mouseleave", function () { hovering = false; });
  // A press may turn into a window drag: leave the chart as it is until it
  // ends. After a native drag the page may never get the mouseup, so a move
  // with no button held counts as the release too.
  tape.addEventListener("mousedown", function (e) {
    if (e.button === 0) { pressed = true; clearTimeout(openTimer); }
  });
  document.addEventListener("mouseup", release);
  document.addEventListener("mousemove", function (e) { if (pressed && !(e.buttons & 1)) release(); });

  var card = document.getElementById("chart");
  card.addEventListener("mouseenter", function () { clearTimeout(closeTimer); clearTimeout(openTimer); });
  card.addEventListener("mouseleave", leaveSoon);
  document.getElementById("cRange").addEventListener("click", function (e) {
    var b = e.target.closest("button");
    if (!b || b.dataset.v === settings.range) return;
    settings.range = b.dataset.v;
    save(); drawChart();          // fetches if this range isn't cached fresh
  });

  window.addEventListener("resize", function () { requestAnimationFrame(measure); });

  // If the user drags an edge, remember the new width instead of snapping back.
  if (win) {
    var t = null;
    win.onResized(function () {
      clearTimeout(t);
      t = setTimeout(function () {
        win.innerSize().then(function (sz) {
          return win.scaleFactor().then(function (f) {
            var logical = Math.round(sz.width / f);
            if (logical > 200 && logical !== settings.width) { settings.width = logical; save(); syncForm(); }
          });
        }).catch(function () {});
      }, 400);
    });
  }

  // ------------------------------------------------------------------ boot
  loadHistory();
  seedMarket();
  applyChrome();
  syncForm();
  render();
  layout();
  schedule();
  requestAnimationFrame(frame);

  // The OS startup entry is the truth (the user can also toggle it in Task
  // Manager), so reflect it rather than trusting what we saved last time.
  if (invoke) {
    invoke("get_autostart").then(function (on) {
      if (on !== settings.autostart) { settings.autostart = on; save(); syncForm(); }
    }).catch(function () {});
    // Likewise the hotkeys: what Rust registered at launch, and what failed.
    invoke("get_shortcuts").then(gotShortcuts).catch(function () {});
  }

  if (document.fonts && document.fonts.ready) document.fonts.ready.then(measure);
  setTimeout(measure, 600);
})();
