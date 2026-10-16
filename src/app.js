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
  var LogicalSize = TAURI ? TAURI.window.LogicalSize : null;

  var KEY = "tickerbelt.widget.v1";

  var DEFAULTS = {
    symbols: ["AAPL","MSFT","NVDA","AMZN","GOOGL","META","TSLA","JPM","V","SPY"],
    apiKey: "",
    refresh: 30,
    speed: 55,
    opacity: 92,
    dir: "left",
    size: "standard",
    width: 900,
    chg: "pct",
    theme: "dark",
    ontop: true,
    hoverpause: true
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

    paint();
    inFlight = false;
  }

  function tick() { if (live()) fetchQuotes(); else simulate(); }

  function schedule() {
    clearInterval(timer);
    var every = live() ? settings.refresh * 1000 : 1600;
    timer = setInterval(tick, every);
    tick();
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
    var s = document.createElement("span"); s.className = "sym"; s.textContent = sym;
    var p = document.createElement("span"); p.className = "px";
    var c = document.createElement("span"); c.className = "chg";
    el.appendChild(s); el.appendChild(p); el.appendChild(c);
    nodes[sym].push({ px: p, chg: c });
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
      var c = changeOf(m);
      nodes[sym].forEach(function (n) {
        n.px.textContent = c.px;
        n.chg.textContent = c.text;
        n.chg.className = "chg " + c.cls;
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
    if (hovering && settings.hoverpause) return;

    offset += (settings.dir === "right" ? -1 : 1) * settings.speed * dt;
    offset = ((offset % copyW) + copyW) % copyW;
    document.getElementById("track").style.transform =
      "translate3d(" + (-offset).toFixed(2) + "px, 0, 0)";
  }

  // ----------------------------------------------------------- the window
  function barHeight() { return (SIZES[settings.size] || SIZES.standard).h; }

  function panelHeight() {
    if (!panelOpen) return 0;
    var inner = document.querySelector(".panelInner");
    var h = inner ? Math.ceil(inner.getBoundingClientRect().height) + 2 : 0;
    return Math.min(h, MAX_PANEL);
  }

  function resize() {
    if (!win || !LogicalSize) return;
    var h = barHeight() + PAD * 2 + panelHeight();
    win.setSize(new LogicalSize(settings.width, h)).catch(function () {});
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
    document.getElementById("panel").hidden = !panelOpen;
    document.getElementById("widget").classList.toggle("open", panelOpen);
    // Unhide first so the panel has a real height to measure.
    requestAnimationFrame(function () { resize(); requestAnimationFrame(measure); });
  }

  // ------------------------------------------------------------------ form
  function syncForm() {
    document.getElementById("symbols").value = settings.symbols.join(", ");
    document.getElementById("apikey").value = settings.apiKey;
    document.getElementById("speed").value = settings.speed;
    document.getElementById("speedVal").textContent = settings.speed;
    document.getElementById("opacity").value = settings.opacity;
    document.getElementById("opacityVal").textContent = settings.opacity + "%";
    document.getElementById("ontop").checked = !!settings.ontop;
    document.getElementById("hoverpause").checked = !!settings.hoverpause;

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

  function readSymbols(raw) {
    var list = raw.toUpperCase().split(/[,\s]+/)
      .map(function (s) { return s.replace(/[^A-Z0-9.\-]/g, ""); })
      .filter(Boolean);
    var seen = {}, out = [];
    list.forEach(function (s) { if (!seen[s] && out.length < 20) { seen[s] = 1; out.push(s); } });
    return out;
  }

  // ------------------------------------------------------------------ wire
  document.getElementById("gear").addEventListener("click", function () { togglePanel(); });
  document.getElementById("close").addEventListener("click", function () {
    if (win) win.close(); else window.close();
  });

  document.getElementById("symbols").addEventListener("change", function (e) {
    var list = readSymbols(e.target.value);
    settings.symbols = list.length ? list : DEFAULTS.symbols.slice();
    market = {};
    save(); seedMarket(); render(); syncForm(); schedule();
  });

  document.getElementById("apikey").addEventListener("change", function (e) {
    settings.apiKey = e.target.value.trim();
    market = {};
    save(); seedMarket(); schedule();
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

  segment("dir", "dir");
  segment("chg", "chg", null, function () { paint(); requestAnimationFrame(measure); });
  segment("theme", "theme");
  segment("size", "size", null, function () { resize(); requestAnimationFrame(measure); });
  segment("width", "width", Number, function () { resize(); requestAnimationFrame(measure); });
  segment("refresh", "refresh", Number, schedule);

  document.getElementById("reset").addEventListener("click", function () {
    var keepKey = settings.apiKey;           // resetting layout shouldn't log you out
    settings = JSON.parse(JSON.stringify(DEFAULTS));
    settings.apiKey = keepKey;
    market = {}; save(); seedMarket(); applyChrome(); syncForm(); render(); resize(); schedule();
  });

  var tape = document.getElementById("tape");
  tape.addEventListener("mouseenter", function () { hovering = true; });
  tape.addEventListener("mouseleave", function () { hovering = false; });

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
  seedMarket();
  applyChrome();
  syncForm();
  render();
  resize();
  schedule();
  requestAnimationFrame(frame);

  if (document.fonts && document.fonts.ready) document.fonts.ready.then(measure);
  setTimeout(measure, 600);
})();
