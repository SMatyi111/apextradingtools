/* APXTT NFP replay: real EURUSD M1 data of 2 Oct 2026 replayed in the browser (no libraries).
   Data: assets/nfp-replay.json (built by tools/build_nfp_replay.py). Not live. */
(function () {
  "use strict";
  var root = document.getElementById("nfp-replay");
  if (!root || !window.fetch || !window.requestAnimationFrame) return;

  var C = { bg: "#02192b", grid: "rgba(159,179,195,0.10)", axis: "#9fb3c3", up: "#1aa82a", upHi: "#22c435",
    down: "#e8eef3", orange: "#f5a623", green: "#22c435", grey: "#9fb3c3", text: "#e8eef3" };
  var FONT = '"Inter","Segoe UI",Roboto,system-ui,sans-serif';
  // timeline: [animation seconds, replayed M1 bars] - long countdown fast, the NFP minutes slow
  var KF = [[0, 0], [1.2, 0], [9, 270], [14, 325], [22, 345], [25.5, 360]];
  var END = 34, NFP_BAR = 330; // 15:30 = bar 330 from 10:00

  var canvas = root.querySelector("canvas"), ctx = canvas.getContext("2d");
  var stage = root.querySelector(".rp-stage");
  var el = function (s) { return root.querySelector(s); };
  var clockEl = el(".rp-clock-time"), utcEl = el(".rp-clock-utc"), badge = el(".rp-badge"), card = el(".rp-card");
  var btnPlay = el(".rp-play"), btnReplay = el(".rp-replay"), btnSpeed = el(".rp-speed"), bar = el(".rp-progress i");
  var pl = { lu: el(".pl-u"), l2: el(".pl-2"), l3: el(".pl-3"), l4: el(".pl-4"), l5: el(".pl-5"), hist: el(".pl-hist"), panel: el(".rp-panel") };

  var D, H = [], W = 0, Hh = 0, dpr = 1;
  var t = 0, playing = false, userPaused = false, visible = false, speed = 1, last = 0, reduced = false;
  var lastPanelKey = "", lastBadge = "", lastClock = "";

  function barsAt(tt) {
    for (var i = 1; i < KF.length; i++) {
      if (tt <= KF[i][0]) {
        var a = KF[i - 1], b = KF[i];
        return a[1] + (b[1] - a[1]) * (tt - a[0]) / (b[0] - a[0]);
      }
    }
    return 360;
  }
  function pad(n) { return (n < 10 ? "0" : "") + n; }
  function hm(min) { return pad(Math.floor(min / 60) % 24) + ":" + pad(min % 60); }
  function mins(m) { return m < 60 ? m + " min" : Math.floor(m / 60) + "h " + (m % 60) + "m"; }
  function f1(x) { return x.toFixed(1); }
  function f0(x) { return Math.round(x).toString(); }

  function prep(d) {
    D = d;
    // per-bar running H1 candle (open of the hour, high/low so far, last close)
    for (var i = 0; i < d.m1.length; i++) {
      var b = d.m1[i], h0 = i % 60 === 0;
      var p = h0 ? null : H[i - 1];
      H.push(h0 ? [b[0], b[1], b[2], b[3]] : [p[0], Math.max(p[1], b[1]), Math.min(p[2], b[2]), b[3]]);
    }
    var lo = 1e9, hi = -1e9;
    d.ctx.forEach(function (c) { lo = Math.min(lo, c[3]); hi = Math.max(hi, c[2]); });
    d.m1.forEach(function (b) { lo = Math.min(lo, b[2]); hi = Math.max(hi, b[1]); });
    // keep the NFP hour's final projection lines (hour low + forecast, hour high - forecast) on the scale
    var fcP = d.panels[5].fc * 10;
    lo = Math.min(lo, d.nfpHour.high - fcP); hi = Math.max(hi, d.nfpHour.low + fcP);
    var padv = (hi - lo) * 0.07;
    D.lo = lo - padv; D.hi = hi + padv * 0.6;
  }

  function resize() {
    var r = stage.getBoundingClientRect();
    dpr = Math.min(window.devicePixelRatio || 1, 3);
    W = Math.round(r.width); Hh = Math.round(r.height);
    canvas.width = Math.round(W * dpr); canvas.height = Math.round(Hh * dpr);
    canvas.style.width = W + "px"; canvas.style.height = Hh + "px";
    sizePanel();
    draw();
  }

  // ----------------------------------------------------------------- chart
  function draw() {
    if (!D || !W) return;
    var n = Math.max(1, Math.min(360, Math.floor(barsAt(t)) + 1)); // M1 bars shown
    var cur = n - 1, hourIdx = Math.floor(cur / 60);
    var small = W < 560;
    var nCtx = small ? 7 : 13;
    var ctxBars = D.ctx.slice(D.ctx.length - nCtx);
    var nC = nCtx + 6;
    var axisW = small ? 44 : 56, top = small ? 84 : 104, bottom = 22, left = 6;
    var plotW = W - axisW - left, plotH = Hh - top - bottom;
    var LZ = Math.max(small ? 112 : 150, plotW * 0.24);
    var slot = (plotW - LZ) / nC, cw = Math.max(3, Math.round(slot * 0.62));
    var y = function (p) { return top + plotH * (D.hi - p) / (D.hi - D.lo); };
    var xs = function (i) { return left + slot * (i + 0.5); };
    var g = ctx;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.fillStyle = C.bg; g.fillRect(0, 0, W, Hh);

    // grid + price axis every 10 pips (100 points)
    g.font = (small ? "10px " : "11px ") + FONT; g.textBaseline = "middle"; g.textAlign = "left";
    var step = (D.hi - D.lo) / 100 > 9 ? 200 : 100;
    for (var p = Math.ceil(D.lo / step) * step; p <= D.hi; p += step) {
      var yy = Math.round(y(p)) + 0.5;
      g.strokeStyle = C.grid; g.lineWidth = 1; g.beginPath(); g.moveTo(left, yy); g.lineTo(W - axisW, yy); g.stroke();
      g.fillStyle = C.axis; g.fillText((D.base + p * D.point).toFixed(small ? 4 : 5), W - axisW + 5, yy);
    }
    // time labels
    g.textAlign = "center"; g.textBaseline = "alphabetic"; g.fillStyle = C.axis;
    var all = ctxBars.map(function (c) { return c[0].slice(6); });
    for (var k = 0; k < 6; k++) all.push(pad(10 + k) + ":00");
    for (var i = 0; i < all.length; i++) {
      var ti = all[i], hh = parseInt(ti, 10);
      if (hh % (small ? 3 : 2) === 0) g.fillText(ti === "00:00" ? "2 Oct" : ti, xs(i), Hh - 7);
    }

    var nfpSlot = nCtx + 5, xN = xs(nfpSlot);
    // NFP event marker (vertical, orange) - known in advance from the calendar
    g.save(); g.strokeStyle = "rgba(245,166,35,0.55)"; g.setLineDash([3, 4]); g.lineWidth = 1;
    g.beginPath(); g.moveTo(Math.round(xN) + 0.5, top - 6); g.lineTo(Math.round(xN) + 0.5, Hh - bottom); g.stroke(); g.restore();
    g.fillStyle = C.orange; g.font = "700 " + (small ? "10px " : "11px ") + FONT; g.textAlign = "right"; g.textBaseline = "alphabetic";
    if (hourIdx < 5) g.fillText("NFP 15:30", xN - 4, Hh - bottom - 6);

    // range projection in the NFP hour (as the indicator draws it): shaded box = range traded so far this hour,
    // dashed lines = hour low + forecast and hour high - forecast, both moving live with the hour's running high/low
    var inNfp = hourIdx >= 5;
    var fcP = D.panels[5].fc * 10, cN = H[cur], bx0 = xN - slot / 2 - 2, bx1 = W - axisW;
    var projA = inNfp ? Math.min(1, (barsAt(t) - 300) / 3) : 0;
    if (inNfp) {
      g.globalAlpha = projA;
      var yHi = y(cN[1]), yLo = y(cN[2]);
      g.fillStyle = "rgba(159,179,195,0.16)"; g.fillRect(bx0, yHi, bx1 - bx0, Math.max(1, yLo - yHi));
      g.strokeStyle = "rgba(159,179,195,0.55)"; g.lineWidth = 1;
      [yHi, yLo].forEach(function (yy) { yy = Math.round(yy) + 0.5; g.beginPath(); g.moveTo(bx0, yy); g.lineTo(bx1, yy); g.stroke(); });
      g.globalAlpha = 1;
    }
    // candles
    function candle(i, c, live) {
      var x = Math.round(xs(i)), up = c[3] >= c[0];
      var col = up ? C.up : C.down;
      g.strokeStyle = col; g.lineWidth = 1;
      g.beginPath(); g.moveTo(x + 0.5, y(c[1])); g.lineTo(x + 0.5, y(c[2])); g.stroke();
      var yt = y(Math.max(c[0], c[3])), yb = y(Math.min(c[0], c[3]));
      g.fillStyle = live && up ? C.upHi : col;
      g.fillRect(x - Math.floor(cw / 2) + 0.5, Math.round(yt), cw, Math.max(1, Math.round(yb - yt)));
    }
    ctxBars.forEach(function (c, i) { candle(i, [c[1], c[2], c[3], c[4]], false); });
    for (var hI = 0; hI <= hourIdx; hI++) {
      var lastBar = hI < hourIdx ? hI * 60 + 59 : cur;
      candle(nCtx + hI, H[lastBar], hI === hourIdx && n < 360);
    }

    // projection lines + their labels (drawn over the candles, labels left of the hour like the indicator)
    if (inNfp) {
      var fsL = small ? 10 : 12, fcR = f0(D.panels[5].fc);
      var lines = [
        { v: cN[2] + fcP, txt: small ? "low + " + fcR : "low + " + fcR + " pips: full range plays out up", up: true },
        { v: cN[1] - fcP, txt: small ? "high − " + fcR : "high − " + fcR + " pips: full range plays out down", up: false }
      ];
      g.globalAlpha = projA;
      lines.forEach(function (L) {
        var yy = y(L.v), yTop = top + 2, yBot = Hh - bottom - 2;
        if (yy >= yTop && yy <= yBot) {
          var yr = Math.round(yy) + 0.5;
          g.save(); g.strokeStyle = C.green; g.lineWidth = 1.5; g.setLineDash([6, 4]);
          g.beginPath(); g.moveTo(bx0, yr); g.lineTo(bx1, yr); g.stroke(); g.restore();
          tag(L.txt, bx0 - 4, yr + (L.up ? fsL * 0.5 + 6 : -(fsL * 0.5 + 6)), C.green, fsL); // label on the inner side of each line
        } else {
          // off the visible scale: an edge note instead of the line (the indicator does the same)
          var px2 = (D.base + L.v * D.point).toFixed(small ? 4 : 5);
          tag((L.up ? "▲ " : "▼ ") + (small ? L.txt.split(":")[0] : L.txt.split(":")[0] + " = " + px2 + " (off the chart)"),
            bx0 - 4, L.up ? yTop + fsL * 0.5 + 6 : yBot - fsL * 0.5 - 6, "rgba(34,196,53,0.85)", fsL);
        }
      });
      g.globalAlpha = 1;
    }
    function tag(txt, xr, yc, fg, fs) { // right-aligned pill ending at xr
      g.font = "600 " + fs + "px " + FONT;
      var w = g.measureText(txt).width + 10, h = fs + 7, x = Math.max(left + 2, xr - w);
      g.fillStyle = "rgba(2,25,43,0.88)"; rr(x, yc - h / 2, w, h, 4); g.fill();
      g.fillStyle = fg; g.textAlign = "left"; g.textBaseline = "middle"; g.fillText(txt, x + 5, yc + 0.5);
    }

    // NFP flash
    var since = barsAt(t) - NFP_BAR;
    if (since >= 0 && since < 6) {
      var r = (small ? 26 : 40) * (0.6 + since / 6), al = 0.55 * (1 - since / 6);
      var cy = y(D.m1[Math.min(cur, 359)][3]);
      var gr = g.createRadialGradient(xN, cy, 0, xN, cy, r * 2);
      gr.addColorStop(0, "rgba(245,166,35," + al + ")"); gr.addColorStop(1, "rgba(245,166,35,0)");
      g.fillStyle = gr; g.fillRect(xN - r * 2, cy - r * 2, r * 4, r * 4);
    }

    // live price line + tag
    var px = D.m1[cur][3], py = Math.round(y(px)) + 0.5;
    g.save(); g.strokeStyle = "rgba(232,238,243,0.45)"; g.setLineDash([2, 3]); g.lineWidth = 1;
    g.beginPath(); g.moveTo(left, py); g.lineTo(W - axisW, py); g.stroke(); g.restore();
    g.fillStyle = C.up; g.fillRect(W - axisW, py - 8.5, axisW, 17);
    g.fillStyle = "#fff"; g.textAlign = "left"; g.textBaseline = "middle"; g.font = "600 " + (small ? "10px " : "11px ") + FONT;
    g.fillText((D.base + px * D.point).toFixed(small ? 4 : 5), W - axisW + 5, py);

    // actual-range bracket + labels in the label zone
    if (inNfp) {
      var c5 = H[cur], bxx = Math.round(xN + slot / 2 + (small ? 5 : 8)) + 0.5;
      var yH = y(c5[1]), yL = y(c5[2]), rng = (c5[1] - c5[2]) / 10;
      g.strokeStyle = C.text; g.lineWidth = 2;
      g.beginPath(); g.moveTo(bxx - 4, yH); g.lineTo(bxx, yH); g.lineTo(bxx, yL); g.lineTo(bxx - 4, yL); g.stroke();
      var lx = bxx + 7, fs = small ? 11 : 13;
      g.font = "700 " + fs + "px " + FONT; g.textBaseline = "middle"; g.textAlign = "left";
      g.globalAlpha = projA;
      // actual: pill at the hour's high, kept inside the plot
      var ya = Math.max(top + fs, Math.min(yH, Hh - bottom - fs * 4));
      pill("Actual " + f0(rng) + " pips", lx, ya, "rgba(13,15,32,0.92)", C.text, C.text, fs);
      pill("ATR said ~" + f0(D.panels[5].atr), lx, ya + fs * 2 + 4, "rgba(2,25,43,0.85)", C.grey, "rgba(159,179,195,0.6)", fs - 1);
      // "X of 56 pips used" counter, above the plot
      if (barsAt(t) < 360) { // hidden once the summary card is up
      var used = rng, pct = Math.round(100 * used / D.panels[5].fc);
      var ctxt = "This hour: " + f0(used) + " of " + f0(D.panels[5].fc) + " pips used (" + pct + "%)";
      var cfs = small ? 12 : 15, cy2 = top - (small ? 14 : 18);
      g.font = "700 " + cfs + "px " + FONT; g.textAlign = "left"; g.textBaseline = "middle"; g.fillStyle = C.green;
      var cw2 = g.measureText(ctxt).width, cx2 = Math.max(left + 4, Math.min(xN - cw2 / 2, W - axisW - cw2 - 4));
      g.fillText(ctxt, cx2, cy2);
      g.fillStyle = "rgba(159,179,195,0.25)"; g.fillRect(cx2, cy2 + cfs * 0.75, cw2, 3);
      g.fillStyle = C.green; g.fillRect(cx2, cy2 + cfs * 0.75, cw2 * Math.min(1, used / D.panels[5].fc), 3);
      }
      g.globalAlpha = 1;
    }

    function pill(txt, x, yc, bg, fg, border, fs) {
      g.font = "700 " + fs + "px " + FONT;
      var w = g.measureText(txt).width + 12, h = fs + 9;
      x = Math.min(x, W - axisW - w - 2);
      g.fillStyle = bg; rr(x, yc - h / 2, w, h, h / 2); g.fill();
      g.strokeStyle = border; g.lineWidth = 1; g.stroke();
      g.fillStyle = fg; g.textAlign = "left"; g.textBaseline = "middle"; g.fillText(txt, x + 6, yc + 0.5);
    }
    function rr(x, y0, w, h, r) {
      g.beginPath(); g.moveTo(x + r, y0); g.arcTo(x + w, y0, x + w, y0 + h, r); g.arcTo(x + w, y0 + h, x, y0 + h, r);
      g.arcTo(x, y0 + h, x, y0, r); g.arcTo(x, y0, x + w, y0, r); g.closePath();
    }

    overlays(cur, hourIdx);
  }

  // ----------------------------------------------------------------- HTML overlays + panel
  function overlays(cur, hourIdx) {
    var chartMin = 600 + cur, utcMin = chartMin + D.utcOffsetH * 60;
    var ck = hm(chartMin);
    if (ck !== lastClock) { clockEl.textContent = ck; utcEl.textContent = hm(utcMin) + " UTC"; lastClock = ck; }
    var dt = NFP_BAR - cur, bt, cls;
    if (dt > 0) { bt = "NFP in " + mins(dt); cls = "pre"; }
    else if (dt > -5) { bt = "NFP NOW"; cls = "now"; }
    else { bt = "NFP +" + (-dt) + " min"; cls = "post"; }
    if (bt !== lastBadge) { badge.textContent = bt; badge.className = "rp-badge " + cls; lastBadge = bt; }
    var hc = H[cur];
    renderPanel(D.panels[Math.min(5, hourIdx)], dt, (hc[1] - hc[2]) / 10);
    var done = barsAt(t) >= 360;
    card.classList.toggle("show", done); root.classList.toggle("rp-done", done);
    bar.style.transform = "scaleX(" + Math.min(1, t / END).toFixed(4) + ")";
  }

  function panelText(P, dt, used) {
    var when = dt >= 0 ? "in " + mins(dt) : "released " + mins(-dt) + " ago";
    var nextH = pad(parseInt(P.t, 10) + 1) + ":00";
    var pct = Math.round(100 * used / P.fc);
    return {
      lu: "This hour: " + f0(used) + " of " + f0(P.fc) + " pips used (" + pct + "%)" + (used > P.fc ? ", range exceeded" : ""),
      l2: "This hour " + P.t + ": expect ~" + f1(P.fc) + " pips   (usual ~" + f1(P.usual) + ", ATR(14) ~" + f1(P.atr) + ")",
      l3: "Next hour " + nextH + ": ~" + f1(P.nextFc) + " pips   (usual ~" + f1(P.nextUsual) + ")",
      l4: "NFP " + when + " - expect ~" + f0(P.xe) + " pips (usual hour: ~" + f0(P.ue) + " pips, ATR(14) says ~" + f0(P.atr) + ")",
      l5: "   hour after: ~" + f0(P.xp) + " pips   (event at 2026.10.02 15:30 chart time)",
      red: P.ue > 0 && P.xe >= 2 * P.ue
    };
  }
  function renderPanel(P, dt, used) {
    var key = P.t + "|" + dt + "|" + f0(used);
    if (key === lastPanelKey) return;
    var T = panelText(P, dt, used);
    if (pl.lu) pl.lu.textContent = T.lu;
    pl.l2.textContent = T.l2; pl.l3.textContent = T.l3; pl.l4.textContent = T.l4; pl.l5.textContent = T.l5;
    pl.l4.className = "pl-4 " + (T.red ? "red" : "amber");
    if (lastPanelKey.split("|")[0] !== P.t) {
      var mx = 0; P.hist.forEach(function (h) { mx = Math.max(mx, h[0]); });
      var bars = pl.hist.children;
      for (var i = 0; i < 24; i++) {
        bars[i].style.height = Math.max(4, Math.round(100 * P.hist[i][0] / mx)) + "%";
        bars[i].className = P.hist[i][1] ? "ev" : "";
        bars[i].title = "~" + f1(P.hist[i][0]) + " pips" + (P.hist[i][1] ? " (event)" : "");
      }
    }
    lastPanelKey = key;
  }
  // reserve the panel's tallest state so text changes never shift the layout
  function sizePanel() {
    if (!D) return;
    pl.panel.style.minHeight = "";
    lastPanelKey = "";
    renderPanel(D.panels[0], 330, 99); // longest strings ("in 5h 30m")
    var h = pl.panel.getBoundingClientRect().height;
    renderPanel(D.panels[5], -30, 99);
    h = Math.max(h, pl.panel.getBoundingClientRect().height);
    pl.panel.style.minHeight = Math.ceil(h) + "px";
    lastPanelKey = "";
  }

  // ----------------------------------------------------------------- loop + controls
  function frame(now) {
    if (!playing) return;
    var dt = last ? Math.min(0.1, (now - last) / 1000) : 0;
    last = now;
    t += dt * speed;
    if (t > END) t = 0;
    draw();
    requestAnimationFrame(frame);
  }
  function play() {
    if (playing || reduced && !root.classList.contains("rp-opted")) return;
    playing = true; last = 0; btnPlay.textContent = "Pause"; btnPlay.setAttribute("aria-pressed", "false");
    requestAnimationFrame(frame);
  }
  function pause() { playing = false; btnPlay.textContent = "Play"; btnPlay.setAttribute("aria-pressed", "true"); }

  btnPlay.addEventListener("click", function () {
    if (playing) { userPaused = true; pause(); }
    else { userPaused = false; root.classList.add("rp-opted"); if (t >= END - 0.01 || barsAt(t) >= 360 && reduced) t = 0; play(); }
  });
  btnReplay.addEventListener("click", function () { t = 0; userPaused = false; root.classList.add("rp-opted"); draw(); play(); });
  btnSpeed.addEventListener("click", function () {
    speed = speed === 1 ? 2 : speed === 2 ? 0.5 : 1;
    btnSpeed.textContent = (speed === 0.5 ? "0.5" : speed) + "x";
  });

  fetch(root.getAttribute("data-src")).then(function (r) { return r.json(); }).then(function (d) {
    prep(d);
    root.classList.add("rp-ready");
    reduced = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    var q = /[?&]rp=([\d.]+)/.exec(location.search); // test hook: freeze at a given second
    if (reduced) { t = END - 1; }
    if (q) { t = parseFloat(q[1]); reduced = true; }
    resize();
    if ("ResizeObserver" in window) new ResizeObserver(function () { resize(); }).observe(stage);
    else window.addEventListener("resize", resize);
    if (reduced) { pause(); return; }
    if ("IntersectionObserver" in window) {
      new IntersectionObserver(function (es) {
        visible = es[0].isIntersecting;
        if (visible && !userPaused) play(); else if (!visible) { if (playing) pause(); }
      }, { threshold: 0.35 }).observe(stage);
    } else play();
  }).catch(function () { root.classList.add("rp-failed"); });
})();
