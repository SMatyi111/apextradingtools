/* APXTT Edge Check - runs entirely in the browser. No uploads, no analytics, no tracking.
 * The only network request this file can make is the optional license-key check against Gumroad
 * (product id + license key only; never any trade data).
 *
 * Part 1 (EC core) is pure computation and also runs under Node for the Python cross-check
 * (tools/edge_check_run_js.js vs tools/edge_check_ref.py). Part 2 is the page UI.
 */
(function (root) {
  "use strict";
  var EC = {};

  /* ------------------------------------------------------------------ seeded random numbers
   * Counter-based mulberry32: draw k of stream id is hash32(base(seed,id) + (k+1)*0x6D2B79F5).
   * Every draw is addressable by index, so the Python reference reproduces the same numbers. */
  var TWO32 = 4294967296;
  function hash32(s) {
    var t = s | 0;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (t ^ (t >>> 14)) >>> 0;
  }
  function Stream(seed, id) { this.base = ((seed >>> 0) + Math.imul(id, 0x9E3779B9)) >>> 0; }
  Stream.prototype.u32 = function (k) { return hash32((this.base + Math.imul(k + 1, 0x6D2B79F5)) >>> 0); };
  EC.hash32 = hash32;
  EC.Stream = Stream;

  /* ------------------------------------------------------------------ special functions */
  var LG = [0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313,
    -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
  function lgamma(x) {
    if (x < 0.5) return Math.log(Math.PI / Math.abs(Math.sin(Math.PI * x))) - lgamma(1 - x);
    x -= 1;
    var a = LG[0], t = x + 7.5;
    for (var i = 1; i < 9; i++) a += LG[i] / (x + i);
    return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
  }
  function betacf(x, a, b) {
    var FPMIN = 1e-300, EPS = 1e-16, qab = a + b, qap = a + 1, qam = a - 1, c = 1, d = 1 - qab * x / qap;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    d = 1 / d;
    var h = d;
    for (var m = 1; m <= 10000; m++) {
      var m2 = 2 * m, aa = m * (b - m) * x / ((qam + m2) * (a + m2));
      d = 1 + aa * d; if (Math.abs(d) < FPMIN) d = FPMIN;
      c = 1 + aa / c; if (Math.abs(c) < FPMIN) c = FPMIN;
      d = 1 / d; h *= d * c;
      aa = -(a + m) * (qab + m) * x / ((a + m2) * (qap + m2));
      d = 1 + aa * d; if (Math.abs(d) < FPMIN) d = FPMIN;
      c = 1 + aa / c; if (Math.abs(c) < FPMIN) c = FPMIN;
      d = 1 / d;
      var del = d * c; h *= del;
      if (Math.abs(del - 1) < EPS) break;
    }
    return h;
  }
  // regularized incomplete beta I_x(a,b), with y = 1-x passed in exactly
  function ibeta(x, y, a, b) {
    if (x <= 0) return 0;
    if (y <= 0) return 1;
    var bt = Math.exp(lgamma(a + b) - lgamma(a) - lgamma(b) + a * Math.log(x) + b * Math.log(y));
    if (x < (a + 1) / (a + b + 2)) return bt * betacf(x, a, b) / a;
    return 1 - bt * betacf(y, b, a) / b;
  }
  // upper tail of Student t: P(T > t)
  function tsf(t, df) {
    if (t === Infinity) return 0;
    if (t === 0) return 0.5;
    var t2 = t * t, x = df / (df + t2), y = t2 / (df + t2);
    var half = 0.5 * ibeta(x, y, df / 2, 0.5);
    return t > 0 ? half : 1 - half;
  }
  function tisf(a, df) { // t with P(T > t) = a, a < 0.5; bisection to machine precision
    var lo = 0, hi = 1;
    while (tsf(hi, df) > a) hi *= 2;
    for (var i = 0; i < 300; i++) {
      var mid = 0.5 * (lo + hi);
      if (mid <= lo || mid >= hi) break;
      if (tsf(mid, df) > a) lo = mid; else hi = mid;
    }
    return 0.5 * (lo + hi);
  }
  // regularized upper incomplete gamma Q(a,x)
  function gammq(a, x) {
    if (x <= 0) return 1;
    var gln = lgamma(a), i, del, sum;
    if (x < a + 1) {
      var ap = a; sum = 1 / a; del = sum;
      for (i = 0; i < 10000; i++) { ap += 1; del *= x / ap; sum += del; if (Math.abs(del) < Math.abs(sum) * 1e-17) break; }
      return 1 - sum * Math.exp(-x + a * Math.log(x) - gln);
    }
    var b = x + 1 - a, c = 1 / 1e-300, d = 1 / b, h = d;
    for (i = 1; i < 10000; i++) {
      var an = -i * (i - a); b += 2;
      d = an * d + b; if (Math.abs(d) < 1e-300) d = 1e-300;
      c = b + an / c; if (Math.abs(c) < 1e-300) c = 1e-300;
      d = 1 / d; del = d * c; h *= del;
      if (Math.abs(del - 1) < 1e-17) break;
    }
    return Math.exp(-x + a * Math.log(x) - gln) * h;
  }
  function normsf(z) { return z >= 0 ? 0.5 * gammq(0.5, z * z / 2) : 1 - 0.5 * gammq(0.5, z * z / 2); }
  function normisf(q) { // z with P(Z > z) = q
    var lo = -40, hi = 40;
    for (var i = 0; i < 300; i++) {
      var mid = 0.5 * (lo + hi);
      if (mid <= lo || mid >= hi) break;
      if (normsf(mid) > q) lo = mid; else hi = mid;
    }
    return 0.5 * (lo + hi);
  }
  EC.tsf = tsf; EC.tisf = tisf; EC.normsf = normsf; EC.normisf = normisf;

  /* ------------------------------------------------------------------ small helpers */
  function sum(a, from, to) { var s = 0; for (var i = from || 0, e = to === undefined ? a.length : to; i < e; i++) s += a[i]; return s; }
  function meanOf(a) { return a.length ? sum(a) / a.length : null; }
  function sdOf(a) {
    var n = a.length; if (n < 2) return null;
    var m = sum(a) / n, ss = 0;
    for (var i = 0; i < n; i++) { var d = a[i] - m; ss += d * d; }
    return Math.sqrt(ss / (n - 1));
  }
  // linear interpolation quantile (= numpy "linear" / Excel PERCENTILE.INC) on a sorted array
  function quant(s, q) {
    var m = s.length; if (!m) return null;
    var pos = q * (m - 1), lo = Math.floor(pos), fr = pos - lo;
    if (lo + 1 >= m) return s[m - 1];
    return s[lo] + fr * (s[lo + 1] - s[lo]);
  }
  function sorted(a) { return Array.prototype.slice.call(a).sort(function (x, y) { return x - y; }); }
  EC.quant = quant;

  /* ------------------------------------------------------------------ analysis (the free part)
   * trades: [{date:"YYYY-MM-DD HH:MM:SS" or "", symbol, result, cost (number or null)}]
   * opts: {includesCost, defaultCost, nTried, alpha, oosStart, seed, unit} */
  EC.NULL_SIMS = 2000; EC.BOOT = 2000; EC.BAND_SIMS = 200; EC.BAND_DRAW = 60;
  EC.VERDICTS = {
    NO_DATA: "NO DATA", NO_EVIDENCE: "NO EVIDENCE", WEAK: "WEAK",
    CHECK: "LOOKS SIGNIFICANT - CHECK STABILITY & COSTS", STABLE: "SIGNIFICANT AND STABLE"
  };

  EC.analyze = function (tradesIn, opts) {
    var o = {
      includesCost: !!opts.includesCost, defaultCost: +opts.defaultCost || 0, nTried: Math.max(1, Math.floor(+opts.nTried || 1)),
      alpha: +opts.alpha || 0.05, oosStart: opts.oosStart || "", seed: (+opts.seed >>> 0)
    };
    var allDated = tradesIn.length > 0 && tradesIn.every(function (t) { return !!t.date; });
    var idx = tradesIn.map(function (_, i) { return i; });
    if (allDated) idx.sort(function (a, b) { var da = tradesIn[a].date, db = tradesIn[b].date; return da < db ? -1 : da > db ? 1 : a - b; });
    var tr = idx.map(function (i) { return tradesIn[i]; });
    var n = tr.length, net = new Array(n), gross = new Array(n), cost = new Array(n), costEntered = false;
    for (var i = 0; i < n; i++) {
      var c = (tr[i].cost === null || tr[i].cost === undefined || tr[i].cost === "" || !isFinite(tr[i].cost)) ? o.defaultCost : +tr[i].cost;
      cost[i] = c; if (c !== 0) costEntered = true;
      if (o.includesCost) { net[i] = +tr[i].result; gross[i] = +tr[i].result + c; }
      else { gross[i] = +tr[i].result; net[i] = +tr[i].result - c; }
    }
    var R = { opts: o, n: n, trades: tr, net: net, gross: gross, cost: cost, allDated: allDated };
    if (!n) { R.verdict = EC.VERDICTS.NO_DATA; R.reason = "no_data"; R.checks = []; return R; }

    var st = {};
    st.n = n; st.sum = sum(net); st.mean = st.sum / n; st.sd = sdOf(net);
    st.meanGross = sum(gross) / n; st.meanCost = sum(cost) / n;
    var sn = sorted(net); st.median = quant(sn, 0.5);
    var wins = net.filter(function (x) { return x > 0; }), losses = net.filter(function (x) { return x < 0; });
    st.nWin = wins.length; st.nLoss = losses.length;
    st.winRate = wins.length / n;
    st.avgWin = wins.length ? sum(wins) / wins.length : null;
    st.avgLoss = losses.length ? -sum(losses) / losses.length : null;
    st.breakevenWinRate = (st.avgWin !== null && st.avgLoss !== null) ? st.avgLoss / (st.avgWin + st.avgLoss) : null;
    if (st.sd !== null && st.sd > 0) {
      st.se = st.sd / Math.sqrt(n); st.t = st.mean / st.se; st.df = n - 1;
      st.p = tsf(st.t, n - 1); st.pBonf = Math.min(1, st.p * o.nTried);
    } else { st.se = null; st.t = null; st.df = n - 1; st.p = null; st.pBonf = null; }
    R.stats = st;

    // random-sign null (stream 1): sign of trade i in sim s = top bit of draw s*n+i
    var S1 = new Stream(o.seed, 1), NS = EC.NULL_SIMS, BS = EC.BAND_SIMS;
    var tol = 1e-12 * Math.max(1, Math.abs(st.mean)), ge = 0, band = new Float64Array(BS * n), simMeans = new Float64Array(NS);
    for (var s = 0; s < NS; s++) {
      var cum = 0, k0 = s * n;
      for (i = 0; i < n; i++) {
        cum += (S1.u32(k0 + i) >>> 31) ? net[i] : -net[i];
        if (s < BS) band[s * n + i] = cum;
      }
      var sm = cum / n; simMeans[s] = sm;
      if (sm >= st.mean - tol) ge++;
    }
    var nullP = (1 + ge) / (NS + 1);
    var lo = new Float64Array(n), hi = new Float64Array(n), col = new Float64Array(BS);
    for (i = 0; i < n; i++) {
      for (s = 0; s < BS; s++) col[s] = band[s * n + i];
      var cs = sorted(col); lo[i] = quant(cs, 0.025); hi[i] = quant(cs, 0.975);
    }
    var paths = [];
    for (s = 0; s < Math.min(EC.BAND_DRAW, BS); s++) paths.push(band.subarray(s * n, (s + 1) * n));
    var realCum = new Float64Array(n), cc = 0;
    for (i = 0; i < n; i++) { cc += net[i]; realCum[i] = cc; }
    var sms = sorted(simMeans);
    R.nullSim = { sims: NS, p: nullP, countGE: ge, mean95: quant(sms, 0.95), bandLoEnd: lo[n - 1], bandHiEnd: hi[n - 1],
      bandLoMid: lo[Math.floor((n - 1) / 2)], bandHiMid: hi[Math.floor((n - 1) / 2)] };
    R.band = { lo: lo, hi: hi, paths: paths, real: realCum };

    // bootstrap of the mean (stream 2)
    var S2 = new Stream(o.seed, 2), B = EC.BOOT, bm = new Float64Array(B), le0 = 0;
    for (var b = 0; b < B; b++) {
      var acc = 0, kb = b * n;
      for (i = 0; i < n; i++) acc += net[Math.floor(S2.u32(kb + i) / TWO32 * n)];
      bm[b] = acc / n; if (bm[b] <= 0) le0++;
    }
    var bs = sorted(bm);
    R.boot = { reps: B, lo: quant(bs, 0.025), hi: quant(bs, 0.975), median: quant(bs, 0.5), pLE0: le0 / B,
      totalLo: quant(bs, 0.025) * n, totalHi: quant(bs, 0.975) * n };

    // analytic sample size (one-sided test at alpha / N tried)
    var aAdj = o.alpha / o.nTried, za = normisf(aAdj);
    R.analytic = { alphaAdj: aAdj, zAlpha: za, nNeeded: {} };
    [0.8, 0.9, 0.95].forEach(function (pw) {
      if (st.mean > 0 && st.sd > 0) {
        var zb = normisf(1 - pw), v = (za + zb) * st.sd / st.mean;
        R.analytic.nNeeded[pw] = Math.ceil(v * v);
      } else R.analytic.nNeeded[pw] = null;
    });

    // checks
    var checks = [];
    function add(id, label, status, detail, value) { checks.push({ id: id, label: label, status: status, detail: detail, value: value === undefined ? null : value }); }
    // 1 halves
    if (n >= 20) {
      var h = Math.floor(n / 2), m1 = sum(net, 0, h) / h, m2 = sum(net, h, n) / (n - h);
      add("halves", "Both halves of the record are positive", (m1 > 0 && m2 > 0) ? "pass" : "fail",
        "first half " + h + " trades, mean " + fmt(m1) + "; second half " + (n - h) + " trades, mean " + fmt(m2), [m1, m2]);
    } else add("halves", "Both halves of the record are positive", "na", "needs at least 20 trades");
    // years
    var years = {}, yorder = [];
    if (allDated) {
      for (i = 0; i < n; i++) {
        var y = tr[i].date.slice(0, 4);
        if (!years[y]) { years[y] = { n: 0, sum: 0 }; yorder.push(y); }
        years[y].n++; years[y].sum += net[i];
      }
    }
    R.years = yorder.map(function (y) { return { year: y, n: years[y].n, sum: years[y].sum, mean: years[y].sum / years[y].n }; });
    var big = R.years.filter(function (y) { return y.n >= 10; });
    if (big.length) {
      var bad = big.filter(function (y) { return y.mean <= 0; });
      add("years", "No calendar year (with 10+ trades) lost money", bad.length ? "fail" : "pass",
        big.map(function (y) { return y.year + ": " + y.n + " trades, mean " + fmt(y.mean); }).join("; "), bad.length);
    } else add("years", "No calendar year (with 10+ trades) lost money", "na", allDated ? "no year has 10 or more trades" : "needs dates");
    if (R.years.length >= 2) {
      var best = R.years[0];
      R.years.forEach(function (y) { if (y.sum > best.sum) best = y; });
      var restN = n - best.n, restSum = 0;
      for (i = 0; i < n; i++) if (tr[i].date.slice(0, 4) !== best.year) restSum += net[i];
      var rm = restSum / restN;
      add("bestyear", "Still positive without the best year", rm > 0 ? "pass" : "fail",
        "without " + best.year + " (" + best.n + " trades): mean " + fmt(rm) + " over " + restN + " trades", rm);
    } else add("bestyear", "Still positive without the best year", "na", "needs trades in at least 2 calendar years");
    // top 5 trades
    if (n > 5) {
      var sd5 = sorted(net), cut = sum(sd5, 0, n - 5) / (n - 5);
      add("top5", "Still positive without the 5 best trades", cut > 0 ? "pass" : "fail", "mean of the other " + (n - 5) + " trades " + fmt(cut), cut);
    } else add("top5", "Still positive without the 5 best trades", "na", "needs more than 5 trades");
    // costs
    if (costEntered) {
      var m2x = 0; for (i = 0; i < n; i++) m2x += net[i] - cost[i];
      m2x /= n;
      add("cost2x", "Still positive if costs were twice as high", m2x > 0 ? "pass" : "fail", "mean at 2x cost " + fmt(m2x) + " (average cost per trade " + fmt(st.meanCost) + ")", m2x);
    } else add("cost2x", "Still positive if costs were twice as high", "na", "no cost data entered");
    add("costs", "Costs are included (spread, commission, swap)", (o.includesCost || costEntered) ? "pass" : "fail",
      o.includesCost ? "you marked the results as already net of costs" : costEntered ? "cost column or default cost used" : "no costs entered and results not marked as net - the test may be judging gross results");
    // out of sample
    if (o.oosStart && allDated) {
      var os = [], is = [];
      for (i = 0; i < n; i++) (tr[i].date >= o.oosStart ? os : is).push(net[i]);
      R.oos = { n: os.length, mean: meanOf(os), nIn: is.length, meanIn: meanOf(is) };
      if (os.length >= 10) add("oos", "Positive after your out-of-sample date", R.oos.mean > 0 ? "pass" : "fail",
        "from " + o.oosStart.slice(0, 10) + ": " + os.length + " trades, mean " + fmt(R.oos.mean) + " (before: " + is.length + " trades, mean " + (is.length ? fmt(R.oos.meanIn) : "-") + ")", R.oos.mean);
      else add("oos", "Positive after your out-of-sample date", "na", "fewer than 10 trades after " + o.oosStart.slice(0, 10));
    } else add("oos", "Positive after your out-of-sample date", "na", "no out-of-sample date set");
    add("randsign", "Beats the random-sign test", nullP < o.alpha ? "pass" : "fail",
      "p = " + fmtP(nullP) + " from " + NS + " random-sign versions of your trades", nullP);
    R.checks = checks;

    // verdict (order fixed by the design)
    var V = EC.VERDICTS, failed = checks.filter(function (c) { return c.status === "fail"; });
    if (st.mean <= 0) { R.verdict = V.NO_EVIDENCE; R.reason = "mean_le_0"; }
    else if (n < 30 || !(st.sd > 0)) { R.verdict = V.WEAK; R.reason = n < 30 ? "n_lt_30" : "sd_0"; }
    else if (st.p >= 0.25) { R.verdict = V.NO_EVIDENCE; R.reason = "p_ge_025"; }
    else if (st.pBonf >= o.alpha) { R.verdict = V.WEAK; R.reason = "bonf_ge_alpha"; }
    else if (failed.length) { R.verdict = V.CHECK; R.reason = "failed_checks"; }
    else { R.verdict = V.STABLE; R.reason = "all_pass"; }
    R.failed = failed.map(function (c) { return c.id; });
    return R;
  };

  /* ------------------------------------------------------------------ forward Monte Carlo (the full report)
   * Assume the measured edge is the true one (and, separately, that the edge is zero), simulate fwdSims
   * future trade sequences for each N in GRID, test each one like the verdict does (one-sided t at
   * alpha / N tried), and also price account drawdowns at a fixed risk per trade. */
  EC.GRID = [25, 50, 75, 100, 150, 200, 250, 300, 400, 500, 750, 1000, 1500, 2000];
  EC.FWD_SIMS = 1000; EC.KEEP = [100, 250]; EC.RISK_STEPS = 200; // risk grid k/2000 = 0.05% .. 10%
  EC.MODELS = ["normal", "winloss", "empirical"];

  EC.rScale = function (R, unit) {
    var st = R.stats;
    if (unit === "R") return { scale: 1, how: "results are in R" };
    if (st.avgLoss && st.avgLoss > 0) return { scale: st.avgLoss, how: "1R = your average losing trade (" + fmt(st.avgLoss) + ")" };
    if (st.sd && st.sd > 0) return { scale: st.sd, how: "no losing trades: 1R = the spread of your results (" + fmt(st.sd) + ")" };
    return { scale: 1, how: "1R = 1 unit" };
  };

  EC.forward = function (R, opts) {
    var model = opts.model || "empirical", mi = EC.MODELS.indexOf(model);
    var M = opts.fwdSims || EC.FWD_SIMS, seed = R.opts.seed, st = R.stats, net = R.net, n = R.n;
    var out = { model: model, sims: M, grid: EC.GRID.slice(), available: true };
    if (n < 5) { out.available = false; out.why = "needs at least 5 trades"; return out; }
    var mu = st.mean, sd = st.sd, W = st.avgWin, L = st.avgLoss, pw = st.winRate;
    if (model === "normal" && !(sd > 0)) { out.available = false; out.why = "all results are identical (no spread)"; return out; }
    if (model === "winloss" && !(W !== null && L !== null)) { out.available = false; out.why = "needs both winning and losing trades"; return out; }
    var p0 = (model === "winloss") ? L / (W + L) : null;
    var aAdj = R.opts.alpha / R.opts.nTried;
    var tcrit = EC.GRID.map(function (N) { return tisf(aAdj, N - 1); });
    out.alphaAdj = aAdj; out.tcrit = tcrit; out.p0 = p0;
    var rs = EC.rScale(R, opts.unit); out.rScale = rs.scale; out.rHow = rs.how;
    out.worlds = [];
    for (var w = 0; w < 2; w++) {
      var S = new Stream(seed, 10 + 2 * mi + w), shift = w ? mu : 0, muW = w ? 0 : mu, pW = w ? p0 : pw;
      var draw;
      if (model === "normal") draw = function (k) {
        var u1 = (S.u32(2 * k) + 0.5) / TWO32, u2 = S.u32(2 * k + 1) / TWO32;
        return muW + sd * (Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2));
      };
      else if (model === "winloss") draw = function (k) { return S.u32(k) / TWO32 < pW ? W : -L; };
      else draw = function (k) { return net[Math.floor(S.u32(k) / TWO32 * n)] - shift; };
      var res = { power: [], kept: {} }, base = 0;
      for (var gi = 0; gi < EC.GRID.length; gi++) {
        var N = EC.GRID[gi], rej = 0, totals = new Float64Array(M), buf = new Float64Array(N);
        var keep = EC.KEEP.indexOf(N) >= 0 ? new Float64Array(M * N) : null, sqN = Math.sqrt(N);
        for (var p = 0; p < M; p++) {
          var s = 0, k0 = base + p * N, j;
          for (j = 0; j < N; j++) { var x = draw(k0 + j); buf[j] = x; s += x; }
          var m = s / N, ss = 0;
          for (j = 0; j < N; j++) { var d = buf[j] - m; ss += d * d; }
          var sdp = Math.sqrt(ss / (N - 1));
          if (sdp > 0 ? (m / (sdp / sqN) > tcrit[gi]) : (m > 0)) rej++;
          totals[p] = s;
          if (keep) keep.set(buf, p * N);
        }
        base += M * N;
        res.power.push(rej / M);
        if (keep) {
          var ts = sorted(totals), neg = 0, good = 0;
          for (p = 0; p < M; p++) { if (totals[p] < 0) neg++; if (totals[p] / N >= mu) good++; }
          res.kept[N] = { q05: quant(ts, 0.05), q25: quant(ts, 0.25), q50: quant(ts, 0.5), q75: quant(ts, 0.75), q95: quant(ts, 0.95),
            pNeg: neg / M, pAtLeastObserved: good / M, paths: keep };
        }
      }
      // N needed (edge world only meaningful, computed for both)
      res.nNeeded = {};
      [0.8, 0.9, 0.95].forEach(function (target) {
        var P = res.power, G = EC.GRID, v = null;
        for (var g = 0; g < G.length; g++) {
          if (P[g] >= target) {
            v = g === 0 ? G[0] : Math.ceil(G[g - 1] + (target - P[g - 1]) / (P[g] - P[g - 1]) * (G[g] - G[g - 1]));
            break;
          }
        }
        res.nNeeded[target] = v;
      });
      out.worlds.push(res);
    }
    out.risk = EC.risk(out, opts.riskPct === undefined ? 1 : +opts.riskPct);
    return out;
  };

  // drawdowns of fixed-fractional sizing on the kept paths (each trade risks f of current equity per 1R)
  function maxDD(paths, M, N, f, rs) {
    var dd = new Float64Array(M);
    for (var p = 0; p < M; p++) {
      var e = 1, peak = 1, worst = 0, o = p * N;
      for (var j = 0; j < N; j++) {
        e = e * (1 + f * (paths[o + j] / rs));
        if (!(e > 0)) { worst = 1; break; }
        if (e > peak) peak = e;
        else { var d = 1 - e / peak; if (d > worst) worst = d; }
      }
      dd[p] = worst;
    }
    return dd;
  }
  function countGE(a, x) { var c = 0; for (var i = 0; i < a.length; i++) if (a[i] >= x) c++; return c; }
  EC.risk = function (F, riskPct) {
    var M = F.sims, rs = F.rScale, f0 = riskPct / 100, out = { riskPct: riskPct, worlds: [] };
    F.worlds.forEach(function (W) {
      var wr = { at: {} };
      EC.KEEP.forEach(function (N) {
        var dd = maxDD(W.kept[N].paths, M, N, f0, rs), s = sorted(dd);
        wr.at[N] = { ddMedian: quant(s, 0.5), dd90: quant(s, 0.9), dd95: quant(s, 0.95),
          p20: countGE(dd, 0.2) / M, p50: countGE(dd, 0.5) / M };
      });
      // largest risk k/2000 (k = 1..RISK_STEPS) with P(DD >= 20% within 250 trades) < 5%; bisection, assumes monotone
      var paths = W.kept[250].paths, lo = 0, hi = EC.RISK_STEPS + 1;
      while (hi - lo > 1) {
        var mid = (lo + hi) >> 1, c = countGE(maxDD(paths, M, 250, mid / 2000, rs), 0.2);
        if (c * 20 < M) lo = mid; else hi = mid;
      }
      wr.safeRiskPct = lo / 20; // percent; 0 = even 0.05% breaches, 10 = cap of the grid
      wr.safeK = lo;
      out.worlds.push(wr);
    });
    return out;
  };

  /* ------------------------------------------------------------------ number formatting */
  function fmt(x, d) {
    if (x === null || x === undefined || !isFinite(x)) return "-";
    d = d === undefined ? (Math.abs(x) >= 100 ? 1 : Math.abs(x) >= 10 ? 2 : 3) : d;
    return (x < 0 ? "-" : "") + Math.abs(x).toFixed(d);
  }
  function fmtP(p) {
    if (p === null || p === undefined) return "-";
    if (p < 0.0001) return "< 0.0001";
    return p.toFixed(4);
  }
  EC.fmt = fmt; EC.fmtP = fmtP;

  /* ------------------------------------------------------------------ input parsing */
  function normDate(s) {
    s = String(s || "").trim().replace(/^"|"$/g, "");
    if (!s) return null;
    var m = s.match(/^(\d{4})[-.\/](\d{1,2})[-.\/](\d{1,2})(?:[ T]+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
    var Y, Mo, D, warn = false;
    if (m) { Y = +m[1]; Mo = +m[2]; D = +m[3]; }
    else {
      m = s.match(/^(\d{1,2})[-.\/](\d{1,2})[-.\/](\d{4})(?:[ T]+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
      if (!m) return null;
      var a = +m[1], b = +m[2]; Y = +m[3];
      if (s.charAt(m[1].length) === "." || a > 12) { D = a; Mo = b; }
      else if (b > 12) { Mo = a; D = b; }
      else { D = a; Mo = b; warn = true; }
    }
    if (Mo < 1 || Mo > 12 || D < 1 || D > 31) return null;
    function p2(x) { return (x < 10 ? "0" : "") + x; }
    var out = Y + "-" + p2(Mo) + "-" + p2(D) + " " + p2(+(m[4] || 0)) + ":" + p2(+(m[5] || 0)) + ":" + p2(+(m[6] || 0));
    return { v: out, ambiguous: warn };
  }
  EC.normDate = normDate;
  function num(s) {
    if (s === null || s === undefined) return NaN;
    if (typeof s === "number") return s;
    s = String(s).replace(/[\s   ]/g, "").replace(/^"|"$/g, "");
    if (s === "") return NaN;
    if (/^-?\d+,\d+$/.test(s)) s = s.replace(",", ".");
    return /^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(s) ? parseFloat(s) : NaN;
  }
  EC.num = num;

  function splitLine(line, delim) {
    var out = [], cur = "", q = false;
    for (var i = 0; i < line.length; i++) {
      var ch = line[i];
      if (q) { if (ch === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += ch; }
      else if (ch === '"') q = true;
      else if (ch === delim) { out.push(cur); cur = ""; }
      else cur += ch;
    }
    out.push(cur);
    return out.map(function (x) { return x.trim(); });
  }
  var ALIAS = {
    date: ["date", "time", "close time", "close_time", "closetime", "datetime", "exit time", "exit_time", "close date", "closed", "exit date"],
    symbol: ["symbol", "instrument", "pair", "item", "market", "ticker", "asset"],
    result: ["result", "r", "r multiple", "r_multiple", "rmultiple", "pnl", "p&l", "p/l", "profit", "net", "net profit", "pips", "return", "gain", "result_r", "result_pips"],
    cost: ["cost", "costs", "fee", "fees", "cost_r", "cost_pips"]
  };
  function findCol(head, names) { for (var i = 0; i < head.length; i++) if (names.indexOf(head[i]) >= 0) return i; return -1; }

  EC.parseCSV = function (text) {
    var lines = text.replace(/^﻿/, "").split(/\r\n|\n|\r/), info = { format: "CSV", warnings: [], trades: [] }, meta = [];
    var li = 0;
    while (li < lines.length && (/^\s*#/.test(lines[li]) || !lines[li].trim())) { if (/^\s*#/.test(lines[li])) meta.push(lines[li]); li++; }
    if (li >= lines.length) { info.error = "No header row found."; return info; }
    if (meta.some(function (m) { return /APXTT trade export/i.test(m); })) { info.format = "APXTT MT5 export"; info.unit = "money"; info.includesCost = false; }
    var hl = lines[li], counts = { ",": 0, ";": 0, "\t": 0 };
    for (var c = 0; c < hl.length; c++) if (counts[hl[c]] !== undefined) counts[hl[c]]++;
    var delim = counts["\t"] > counts[";"] && counts["\t"] > counts[","] ? "\t" : counts[";"] > counts[","] ? ";" : ",";
    var head = splitLine(hl, delim).map(function (h) { return h.toLowerCase().replace(/\s+/g, " ").trim(); });
    var ci = { date: findCol(head, ALIAS.date), symbol: findCol(head, ALIAS.symbol), result: findCol(head, ALIAS.result), cost: findCol(head, ALIAS.cost) };
    if (ci.result < 0) {
      // no header? accept a single column of numbers
      var single = lines.slice(li).filter(function (l) { return l.trim(); });
      if (single.length && single.every(function (l) { return !isNaN(num(splitLine(l, delim)[0])); })) {
        single.forEach(function (l) { info.trades.push({ date: "", symbol: "", result: num(splitLine(l, delim)[0]), cost: null }); });
        info.format = "list of results"; info.warnings.push("No header: read one result per line, no dates.");
        return info;
      }
      info.error = "Could not find a result column. Name it result, R, profit, pnl or pips.";
      return info;
    }
    var rh = head[ci.result];
    if (!info.unit) info.unit = /pip/.test(rh) ? "pips" : (rh === "r" || /r_?multiple|result_r/.test(rh)) ? "R" : /profit|pnl|p&l|p\/l|net/.test(rh) ? "money" : null;
    var bad = 0, amb = 0, noDate = 0;
    for (li = li + 1; li < lines.length; li++) {
      var L = lines[li];
      if (!L.trim() || /^\s*#/.test(L)) continue;
      var cells = splitLine(L, delim), r = num(cells[ci.result]);
      if (!isFinite(r)) { bad++; continue; }
      var d = ci.date >= 0 ? normDate(cells[ci.date]) : null;
      if (d && d.ambiguous) amb++;
      if (!d) noDate++;
      var cv = ci.cost >= 0 ? num(cells[ci.cost]) : NaN;
      info.trades.push({ date: d ? d.v : "", symbol: ci.symbol >= 0 ? cells[ci.symbol] : "", result: r, cost: isFinite(cv) ? cv : null });
    }
    if (!info.trades.length && info.format === "APXTT MT5 export") info.error = "The export file has no trades: MT5 found no closed trades in the chosen date range. Run the script again with an earlier 'Closed from' date, or check that the right account is logged in.";
    if (bad) info.warnings.push(bad + " row(s) skipped: the result was not a number.");
    if (amb) info.warnings.push(amb + " date(s) like 03/04/2025 were read as day/month.");
    if (noDate && info.trades.length) info.warnings.push(noDate + " trade(s) without a readable date: year and out-of-sample checks are skipped and the file order is used.");
    info.hasCost = ci.cost >= 0;
    return info;
  };

  // ---- HTML table -> rows of cell strings (regex based; MetaTrader reports are machine-generated HTML)
  function decodeEntities(s) {
    return s.replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">")
      .replace(/&quot;/gi, '"').replace(/&#(\d+);/g, function (_, d) { return String.fromCharCode(+d); });
  }
  EC.htmlRows = function (html) {
    var rows = [], trRe = /<tr\b[^>]*>([\s\S]*?)(?=<tr\b|<\/table>|$)/gi, m;
    html = html.replace(/<!--[\s\S]*?-->/g, "").replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, "");
    while ((m = trRe.exec(html))) {
      var cells = [], cRe = /<t([dh])\b([^>]*)>([\s\S]*?)(?=<t[dh]\b|<\/tr>|$)/gi, c;
      while ((c = cRe.exec(m[1]))) {
        var attrs = c[2];
        if (/class\s*=\s*["']?hidden/i.test(attrs)) continue;
        var txt = decodeEntities(c[3].replace(/<\/t[dh]>[\s\S]*$/i, "").replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim();
        cells.push(txt);
        var span = attrs.match(/colspan\s*=\s*["']?(\d+)/i);
        for (var k = 1; span && k < +span[1]; k++) cells.push("");
      }
      rows.push(cells);
    }
    return rows;
  };

  // ---- rows (from HTML or XLSX) -> trades; MT5 Positions, MT5 Deals, MT4 Closed Transactions
  EC.parseReportRows = function (rows, sourceLabel) {
    var info = { format: sourceLabel, warnings: [], trades: [], unit: "money", includesCost: false, hasCost: true };
    function low(r) { return r.map(function (x) { return String(x || "").trim().toLowerCase(); }); }
    function isDate(x) { return !!normDate(x) && /^\d{4}[.\-\/]\d{2}[.\-\/]\d{2}/.test(String(x).trim()); }
    var hp = -1, hd = -1, h4 = -1;
    for (var i = 0; i < rows.length; i++) {
      var r = low(rows[i]);
      if (hp < 0 && r[0] === "time" && r[1] === "position" && r.indexOf("profit") >= 0) hp = i;
      if (hd < 0 && r[0] === "time" && r[1] === "deal" && r.indexOf("direction") >= 0) hd = i;
      if (h4 < 0 && r[0] === "ticket" && r.indexOf("item") >= 0 && r.indexOf("profit") >= 0) h4 = i;
    }
    var j, H, row;
    if (hp >= 0) {
      H = low(rows[hp]);
      var tIdx = []; H.forEach(function (x, k) { if (x === "time") tIdx.push(k); });
      var cSym = H.indexOf("symbol"), cType = H.indexOf("type"), cCom = H.indexOf("commission"), cSw = H.indexOf("swap"), cPr = H.indexOf("profit"), cFee = H.indexOf("fee");
      var cClose = tIdx.length > 1 ? tIdx[1] : tIdx[0];
      for (j = hp + 1; j < rows.length; j++) {
        row = rows[j];
        if (!row.length || !isDate(row[0])) { if (row.length && String(row[0]).trim()) break; else continue; }
        var ty = String(row[cType] || "").toLowerCase();
        if (ty !== "buy" && ty !== "sell") continue;
        var pr = num(row[cPr]); if (!isFinite(pr)) continue;
        var cost = -((num(row[cCom]) || 0) + (num(row[cSw]) || 0) + (cFee >= 0 ? (num(row[cFee]) || 0) : 0));
        var dd = normDate(row[cClose]) || normDate(row[0]);
        info.trades.push({ date: dd ? dd.v : "", symbol: row[cSym] || "", result: pr, cost: cost });
      }
      info.format = sourceLabel + " (MT5 Positions table)";
      return info;
    }
    if (hd >= 0) {
      H = low(rows[hd]);
      var dSym = H.indexOf("symbol"), dType = H.indexOf("type"), dDir = H.indexOf("direction"), dCom = H.indexOf("commission"),
        dSw = H.indexOf("swap"), dPr = H.indexOf("profit"), dFee = H.indexOf("fee"), pend = {}, unattributed = 0;
      for (j = hd + 1; j < rows.length; j++) {
        row = rows[j];
        if (!row.length || !isDate(row[0])) { if (row.length && String(row[0]).trim()) break; else continue; }
        var t = String(row[dType] || "").toLowerCase(), dir = String(row[dDir] || "").toLowerCase(), sym = row[dSym] || "";
        if (t !== "buy" && t !== "sell") continue;
        var c = -((num(row[dCom]) || 0) + (num(row[dSw]) || 0) + (dFee >= 0 ? (num(row[dFee]) || 0) : 0));
        if (dir === "in") { pend[sym] = (pend[sym] || 0) + c; continue; }
        var p = num(row[dPr]); if (!isFinite(p)) continue;
        c += pend[sym] || 0; pend[sym] = 0;
        var d2 = normDate(row[0]);
        info.trades.push({ date: d2 ? d2.v : "", symbol: sym, result: p, cost: c });
      }
      for (var s in pend) if (pend[s]) unattributed++;
      info.format = sourceLabel + " (MT5 Deals table)";
      info.warnings.push("Read from the Deals table: each closing deal is one trade; entry-deal costs were added to the next close on the same symbol (approximate if positions overlap).");
      if (unattributed) info.warnings.push("Some entry costs had no closing deal (open positions) and were ignored.");
      return info;
    }
    if (h4 >= 0) {
      H = low(rows[h4]);
      var times = []; H.forEach(function (x, k) { if (x === "close time") times.push(k); });
      var eType = H.indexOf("type"), eItem = H.indexOf("item"), eCom = H.indexOf("commission"), eTax = H.indexOf("taxes"), eSw = H.indexOf("swap"), ePr = H.indexOf("profit");
      for (j = h4 + 1; j < rows.length; j++) {
        row = rows[j];
        var first = String(row[0] || "").toLowerCase();
        if (/open trades|working orders|summary/.test(first)) break;
        var ty4 = String(row[eType] || "").toLowerCase();
        if (ty4 !== "buy" && ty4 !== "sell") continue;
        var p4 = num(row[ePr]); if (!isFinite(p4)) continue;
        var c4 = -((num(row[eCom]) || 0) + (eTax >= 0 ? (num(row[eTax]) || 0) : 0) + (num(row[eSw]) || 0));
        var d4 = normDate(row[times[0]]);
        info.trades.push({ date: d4 ? d4.v : "", symbol: row[eItem] || "", result: p4, cost: c4 });
      }
      info.format = sourceLabel + " (MT4 Closed Transactions)";
      info.warnings.push("MT4 statement reading is UNVERIFIED: it was written from the MT4 template, not tested on a real statement. Check the trade count and total below against your statement.");
      return info;
    }
    info.error = "No MT5 Positions / Deals table or MT4 Closed Transactions table was found (English report headers are expected).";
    return info;
  };

  // ---- XLSX (MT5 "Open XML" report): minimal ZIP reader + DecompressionStream("deflate-raw")
  function u16(b, o) { return b[o] | (b[o + 1] << 8); }
  function u32(b, o) { return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0; }
  function decodeText(bytes) {
    if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder("utf-16le").decode(bytes.subarray(2));
    if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder("utf-16be").decode(bytes.subarray(2));
    if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return new TextDecoder("utf-8").decode(bytes.subarray(3));
    // UTF-16LE without BOM: every second byte zero in the first characters
    if (bytes.length > 3 && bytes[1] === 0 && bytes[3] === 0) return new TextDecoder("utf-16le").decode(bytes);
    return new TextDecoder("utf-8").decode(bytes);
  }
  EC.decodeText = decodeText;
  function inflateRaw(data) {
    var ds = new DecompressionStream("deflate-raw");
    var stream = new Blob([data]).stream().pipeThrough(ds);
    return new Response(stream).arrayBuffer().then(function (ab) { return new Uint8Array(ab); });
  }
  EC.unzip = function (buf) {
    var b = new Uint8Array(buf), eocd = -1;
    for (var i = b.length - 22; i >= Math.max(0, b.length - 65557); i--) if (u32(b, i) === 0x06054b50) { eocd = i; break; }
    if (eocd < 0) return Promise.reject(new Error("not a zip file"));
    var cnt = u16(b, eocd + 10), off = u32(b, eocd + 16), files = {}, jobs = [];
    for (var k = 0; k < cnt; k++) {
      if (u32(b, off) !== 0x02014b50) break;
      var method = u16(b, off + 10), csize = u32(b, off + 20), nlen = u16(b, off + 28), xlen = u16(b, off + 30), clen = u16(b, off + 32), lho = u32(b, off + 42);
      var name = new TextDecoder().decode(b.subarray(off + 46, off + 46 + nlen));
      var dataStart = lho + 30 + u16(b, lho + 26) + u16(b, lho + 28), raw = b.subarray(dataStart, dataStart + csize);
      (function (name, method, raw) {
        if (method === 0) files[name] = raw;
        else if (method === 8) jobs.push(inflateRaw(raw).then(function (x) { files[name] = x; }));
      })(name, method, raw);
      off += 46 + nlen + xlen + clen;
    }
    return Promise.all(jobs).then(function () { return files; });
  };
  function xmlUnescape(s) { return s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&"); }
  function colIndex(ref) { var m = ref.match(/^[A-Z]+/), c = 0; if (!m) return -1; for (var i = 0; i < m[0].length; i++) c = c * 26 + (m[0].charCodeAt(i) - 64); return c - 1; }
  EC.xlsxRows = function (buf) {
    return EC.unzip(buf).then(function (files) {
      var sst = [], sheetName = Object.keys(files).filter(function (n) { return /^xl\/worksheets\/sheet\d*\.xml$/.test(n); }).sort()[0];
      if (!sheetName) throw new Error("no worksheet in the file");
      if (files["xl/sharedStrings.xml"]) {
        var sx = decodeText(files["xl/sharedStrings.xml"]), siRe = /<si>([\s\S]*?)<\/si>/g, m;
        while ((m = siRe.exec(sx))) { var parts = [], tRe = /<t[^>]*>([\s\S]*?)<\/t>/g, t; while ((t = tRe.exec(m[1]))) parts.push(xmlUnescape(t[1])); sst.push(parts.join("")); }
      }
      var x = decodeText(files[sheetName]), rows = [], rRe = /<row\b[^>]*>([\s\S]*?)<\/row>/g, r;
      while ((r = rRe.exec(x))) {
        var row = [], cRe = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g, c;
        while ((c = cRe.exec(r[1]))) {
          var attrs = c[1], ref = (attrs.match(/\br="([A-Z]+\d+)"/) || [])[1], type = (attrs.match(/\bt="(\w+)"/) || [])[1], body = c[2] || "";
          var v = (body.match(/<v>([\s\S]*?)<\/v>/) || [])[1], val = "";
          if (type === "s") val = sst[+v] || "";
          else if (type === "inlineStr") val = xmlUnescape((body.match(/<t[^>]*>([\s\S]*?)<\/t>/) || [])[1] || "");
          else if (v !== undefined) val = xmlUnescape(v);
          var ci = ref ? colIndex(ref) : row.length;
          while (row.length < ci) row.push("");
          row[ci] = val;
        }
        rows.push(row);
      }
      return rows;
    });
  };

  // ---- one entry point: bytes + file name -> Promise(info)
  EC.parseFile = function (buf, name) {
    var b = new Uint8Array(buf);
    if (b[0] === 0x50 && b[1] === 0x4b) {
      return EC.xlsxRows(buf).then(function (rows) { return EC.parseReportRows(rows, "Excel report"); },
        function (e) { return { error: "Could not read the Excel file (" + e.message + "). Save the report as HTML or use the MT5 export script.", warnings: [], trades: [] }; });
    }
    var text = decodeText(b);
    return Promise.resolve(EC.parseText(text, name));
  };
  EC.parseText = function (text, name) {
    if (/<table|<html|<tr\b/i.test(text.slice(0, 200000))) {
      var info = EC.parseReportRows(EC.htmlRows(text), "HTML report");
      if (/MT5 Positions/.test(info.format || "")) info.warnings.push("MT5 history HTML reading is UNVERIFIED on a real HTML export (it was verified on the same report saved as Excel, and on an MT5 Strategy Tester HTML report). Check the trade count and total against your report.");
      return info;
    }
    return EC.parseCSV(text);
  };

  // stable identity of a trade list (FNV-1a), used only for the local report counter
  EC.dataKey = function (trades) {
    var h = 0x811c9dc5, s = trades.map(function (t) { return t.date + "|" + t.symbol + "|" + t.result + "|" + t.cost; }).join("\n");
    for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
    return (h >>> 0).toString(16) + ":" + trades.length;
  };

  if (typeof module !== "undefined" && module.exports) module.exports = EC;
  root.EdgeCheck = EC;
})(typeof window !== "undefined" ? window : globalThis);

/* ==================================================================== Part 2: page UI (browser only) */
(function () {
  "use strict";
  if (typeof document === "undefined") return;
  var EC = window.EdgeCheck, EXAMPLES = window.APXTT_EDGE_EXAMPLES || [];

  /* Access model (owner decision 2026-10-18). Everything below is checked in this browser only.
   * Free always: verdict, checks, luck band, bootstrap. Full report (forward simulation + drawdowns):
   * free for the 5 examples and for the first FREE_OWN_REPORTS files; then EMAIL_REPORTS more with the
   * code from the free Gumroad product; then paid license keys (LICENSE_USES reports per key), checked
   * against Gumroad's public license endpoint. Only the key and product id are sent, never trade data. */
  var GATE = {
    FREE_OWN_REPORTS: 2,
    EMAIL_REPORTS: 3,
    LICENSE_USES: 10,
    CREDITS_ENABLED: false,  // launch phase (Jev 091a4f54b9, 91%): free + email only until the traction bar
    UNLOCK_SHA256: "45c171c418dfd142f315803f74262fc4bd476b0274f370ecf3dd4e8dd095001c",
    EMAIL_URL: "https://stvert.gumroad.com/l/apxtt-edge-check",
    CREDITS_URL: "https://stvert.gumroad.com/l/apxtt-edge-credits",      // placeholder: set to the paid product
    GUMROAD_PRODUCT_ID: "REPLACE_WITH_GUMROAD_PRODUCT_ID",               // placeholder: paid product's id
    CREDITS_PRICE: ""                                                    // e.g. "USD 9"; empty = shown on Gumroad
  };
  var LS_KEY = "apxtt_edge_check_v1";

  function $(id) { return document.getElementById(id); }
  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }
  var fmt = EC.fmt, fmtP = EC.fmtP;
  function pct(x, d) { return x === null || x === undefined ? "-" : (100 * x).toFixed(d === undefined ? 0 : d) + "%"; }
  function pctP(x) { return x < 0.001 ? (x === 0 ? "0%" : "< 0.1%") : (100 * x).toFixed(1) + "%"; }

  var state = { trades: null, source: null, exampleId: null, info: null, R: null, key: null };

  /* ---------------------------------------------------------------- local storage (report counter only) */
  function loadLS() {
    var x;
    try { x = JSON.parse(localStorage.getItem(LS_KEY) || "{}"); } catch (e) { x = {}; }
    x.free = x.free || []; x.email = x.email || { unlocked: false, used: [] }; x.license = x.license || { key: "", used: [], uses: null };
    return x;
  }
  function saveLS(x) { try { localStorage.setItem(LS_KEY, JSON.stringify(x)); } catch (e) { /* private mode: nothing kept */ } }
  function granted(key) {
    var s = loadLS();
    return s.free.indexOf(key) >= 0 || s.email.used.indexOf(key) >= 0 || s.license.used.indexOf(key) >= 0;
  }
  // "full" when the full report may be shown for this dataset now (consumes a free/email report if needed)
  function access() {
    if (state.exampleId) return "full";
    var k = state.key, s = loadLS();
    if (granted(k)) return "full";
    if (s.free.length < GATE.FREE_OWN_REPORTS) { s.free.push(k); saveLS(s); return "full"; }
    if (s.email.unlocked && (!GATE.CREDITS_ENABLED || s.email.used.length < GATE.EMAIL_REPORTS)) { s.email.used.push(k); saveLS(s); return "full"; }
    return s.email.unlocked ? "credits" : "email";
  }

  /* ---------------------------------------------------------------- settings */
  function opts() {
    var oos = $("ec-oos").value;
    return {
      unit: $("ec-unit").value, includesCost: $("ec-incl").checked, defaultCost: +$("ec-defcost").value || 0,
      nTried: Math.max(1, Math.floor(+$("ec-ntried").value || 1)), alpha: +$("ec-alpha").value,
      oosStart: oos ? oos + " 00:00:00" : "", seed: (+$("ec-seed").value >>> 0),
      model: $("ec-model").value, riskPct: Math.min(10, Math.max(0.05, +$("ec-risk").value || 1))
    };
  }
  function setOpts(o) {
    if (o.unit) $("ec-unit").value = o.unit;
    $("ec-incl").checked = !!o.includesCost;
    $("ec-defcost").value = o.defaultCost || 0;
    $("ec-ntried").value = o.nTried || 1;
    $("ec-oos").value = o.oosStart ? o.oosStart.slice(0, 10) : "";
    $("ec-seed").value = o.seed === undefined ? 20261018 : o.seed;
  }

  /* ---------------------------------------------------------------- loading data */
  function useInfo(info, label, exampleId) {
    var msg = $("ec-load-msg");
    if (info.error || !info.trades.length) {
      msg.innerHTML = '<strong class="ec-bad">Could not read trades.</strong> ' + esc(info.error || "No trades found.");
      return;
    }
    state.trades = info.trades; state.info = info; state.exampleId = exampleId || null; state.source = label;
    state.key = EC.dataKey(info.trades);
    if (!exampleId) {
      setOpts({ unit: info.unit || "money", includesCost: !!info.includesCost, defaultCost: 0, nTried: $("ec-ntried").value, seed: $("ec-seed").value });
      Array.prototype.forEach.call(document.querySelectorAll(".ec-ex"), function (b) { b.setAttribute("aria-pressed", "false"); });
    }
    var tot = 0, tc = 0, dates = info.trades.map(function (t) { return t.date; }).filter(Boolean).sort();
    info.trades.forEach(function (t) { tot += t.result; tc += (t.cost || 0); });
    msg.innerHTML = "<strong>" + esc(label) + "</strong>: " + info.trades.length + " trades read" +
      (info.format ? " (" + esc(info.format) + ")" : "") + ". Total result " + fmt(tot, 2) + (info.hasCost ? ", total cost " + fmt(tc, 2) : ", no cost column") +
      (dates.length ? ", " + dates[0].slice(0, 10) + " to " + dates[dates.length - 1].slice(0, 10) : "") + "." +
      (info.warnings && info.warnings.length ? '<br><span class="ec-warn">' + info.warnings.map(esc).join("<br>") + "</span>" : "") +
      (exampleId ? "" : '<br><span class="live-sub">Check that the count and total match your statement before reading the result.</span>');
    run();
  }
  function loadFile(file) {
    $("ec-load-msg").textContent = "Reading " + file.name + " (in your browser) ...";
    var fr = new FileReader();
    fr.onload = function () {
      EC.parseFile(fr.result, file.name).then(function (info) { useInfo(info, file.name); },
        function (e) { useInfo({ error: String(e && e.message || e), trades: [] }, file.name); });
    };
    fr.readAsArrayBuffer(file);
  }
  function loadExample(id) {
    var ex = EXAMPLES.filter(function (e) { return e.id === id; })[0];
    if (!ex) return;
    setOpts(ex.opts);
    $("ec-unit").value = "R";
    var trades = ex.trades.map(function (t) { return { date: t.date, symbol: t.symbol, result: t.result, cost: t.cost }; });
    useInfo({ trades: trades, format: "built-in example, constructed data", warnings: [], hasCost: true, unit: "R" }, "Example: " + ex.title, ex.id);
    Array.prototype.forEach.call(document.querySelectorAll(".ec-ex"), function (b) { b.setAttribute("aria-pressed", b.getAttribute("data-ex") === id ? "true" : "false"); });
  }

  /* ---------------------------------------------------------------- canvas helpers */
  function canvasCtx(cv, hCss) {
    var w = cv.parentNode.clientWidth, dpr = window.devicePixelRatio || 1;
    cv.style.width = w + "px"; cv.style.height = hCss + "px";
    cv.width = Math.round(w * dpr); cv.height = Math.round(hCss * dpr);
    var c = cv.getContext("2d"); c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.clearRect(0, 0, w, hCss);
    return { c: c, w: w, h: hCss };
  }
  var COL = { text: "#e8eef3", muted: "#9fb3c3", line: "#1e3a50", green: "#22c435", red: "#ff5a4f", amber: "#f5a623", band: "rgba(159,179,195,0.16)", path: "rgba(159,179,195,0.22)" };
  function niceTicks(lo, hi, k) {
    var span = hi - lo || 1, step = Math.pow(10, Math.floor(Math.log10(span / k))), err = span / k / step;
    step *= err >= 7.5 ? 10 : err >= 3.5 ? 5 : err >= 1.5 ? 2 : 1;
    var out = []; for (var v = Math.ceil(lo / step) * step; v <= hi + 1e-9 * step; v += step) out.push(Math.abs(v) < step / 1e6 ? 0 : v);
    return out;
  }
  function tickLabel(v, span) { return span < 10 ? v.toFixed(1) : String(Math.round(v)); }

  function drawBand(R) {
    var cv = $("ec-band"), g = canvasCtx(cv, cv.parentNode.clientWidth < 500 ? 240 : 320), c = g.c, B = R.band, n = R.n;
    var L = 48, Rr = 10, T = 12, Bm = 30, W = g.w - L - Rr, H = g.h - T - Bm;
    var lo = 0, hi = 0, i;
    for (i = 0; i < n; i++) { lo = Math.min(lo, B.lo[i], B.real[i]); hi = Math.max(hi, B.hi[i], B.real[i]); }
    B.paths.forEach(function (pa) { for (var j = 0; j < n; j++) { if (pa[j] < lo) lo = pa[j]; if (pa[j] > hi) hi = pa[j]; } });
    var pad = (hi - lo) * 0.05 || 1; lo -= pad; hi += pad;
    function X(k) { return L + (n > 1 ? k / (n - 1) : 0.5) * W; }
    function Y(v) { return T + (hi - v) / (hi - lo) * H; }
    c.font = "11px Segoe UI, system-ui, sans-serif"; c.fillStyle = COL.muted; c.strokeStyle = COL.line; c.lineWidth = 1;
    niceTicks(lo, hi, 5).forEach(function (v) { c.beginPath(); c.moveTo(L, Y(v)); c.lineTo(L + W, Y(v)); c.stroke(); c.textAlign = "right"; c.fillText(tickLabel(v, hi - lo), L - 6, Y(v) + 4); });
    c.textAlign = "center";
    niceTicks(1, n, 5).forEach(function (v) { if (v >= 1) c.fillText(String(v), X(v - 1), T + H + 16); });
    c.fillText("trade number", L + W / 2, g.h - 2);
    c.fillStyle = COL.band; c.beginPath();
    for (i = 0; i < n; i++) c.lineTo(X(i), Y(B.hi[i]));
    for (i = n - 1; i >= 0; i--) c.lineTo(X(i), Y(B.lo[i]));
    c.closePath(); c.fill();
    c.strokeStyle = COL.path; c.lineWidth = 1;
    B.paths.forEach(function (pa) { c.beginPath(); for (var j = 0; j < n; j++) c.lineTo(X(j), Y(pa[j])); c.stroke(); });
    c.strokeStyle = COL.muted; c.setLineDash([4, 4]); c.beginPath(); c.moveTo(L, Y(0)); c.lineTo(L + W, Y(0)); c.stroke(); c.setLineDash([]);
    c.strokeStyle = B.real[n - 1] >= 0 ? COL.green : COL.red; c.lineWidth = 2.2; c.beginPath();
    for (i = 0; i < n; i++) c.lineTo(X(i), Y(B.real[i]));
    c.stroke();
  }

  function drawPower(F) {
    var cv = $("ec-power"), g = canvasCtx(cv, cv.parentNode.clientWidth < 500 ? 220 : 280), c = g.c, G = F.grid;
    var L = 40, Rr = 12, T = 12, Bm = 32, W = g.w - L - Rr, H = g.h - T - Bm, lmin = Math.log(G[0]), lmax = Math.log(G[G.length - 1]);
    function X(N) { return L + (Math.log(N) - lmin) / (lmax - lmin) * W; }
    function Y(v) { return T + (1 - v) * H; }
    c.font = "11px Segoe UI, system-ui, sans-serif"; c.lineWidth = 1;
    [0, 0.25, 0.5, 0.75, 1].forEach(function (v) { c.strokeStyle = COL.line; c.beginPath(); c.moveTo(L, Y(v)); c.lineTo(L + W, Y(v)); c.stroke(); c.fillStyle = COL.muted; c.textAlign = "right"; c.fillText(pct(v), L - 5, Y(v) + 4); });
    [0.8, 0.9, 0.95].forEach(function (v) { c.strokeStyle = "rgba(245,166,35,0.55)"; c.setLineDash([3, 4]); c.beginPath(); c.moveTo(L, Y(v)); c.lineTo(L + W, Y(v)); c.stroke(); });
    c.setLineDash([]); c.textAlign = "center"; c.fillStyle = COL.muted;
    (g.w < 500 ? [25, 100, 250, 1000, 2000] : [25, 50, 100, 250, 500, 1000, 2000]).forEach(function (N) { c.fillText(String(N), X(N), T + H + 15); });
    c.fillText("number of future trades (log scale)", L + W / 2, g.h - 2);
    [[F.worlds[1].power, COL.muted], [F.worlds[0].power, COL.green]].forEach(function (s) {
      c.strokeStyle = s[1]; c.lineWidth = 2.2; c.beginPath();
      s[0].forEach(function (p, i) { c.lineTo(X(G[i]), Y(p)); }); c.stroke();
      c.fillStyle = s[1]; s[0].forEach(function (p, i) { c.beginPath(); c.arc(X(G[i]), Y(p), 2.5, 0, 7); c.fill(); });
    });
  }

  function drawRange(F, unit) {
    var cv = $("ec-range"), g = canvasCtx(cv, 200), c = g.c, rows = [];
    EC.KEEP.forEach(function (N) { rows.push([N, "measured edge", F.worlds[0].kept[N], COL.green]); rows.push([N, "zero edge", F.worlds[1].kept[N], COL.muted]); });
    var lo = 0, hi = 0; rows.forEach(function (r) { lo = Math.min(lo, r[2].q05); hi = Math.max(hi, r[2].q95); });
    var pad = (hi - lo) * 0.06 || 1; lo -= pad; hi += pad;
    var narrow = g.w < 500, L = narrow ? 92 : 160, Rr = 12, T = 8, Bm = 30, W = g.w - L - Rr, rowH = (g.h - T - Bm) / rows.length;
    function X(v) { return L + (v - lo) / (hi - lo) * W; }
    c.font = "11px Segoe UI, system-ui, sans-serif";
    niceTicks(lo, hi, narrow ? 4 : 6).forEach(function (v) { c.strokeStyle = COL.line; c.beginPath(); c.moveTo(X(v), T); c.lineTo(X(v), T + rows.length * rowH); c.stroke(); c.fillStyle = COL.muted; c.textAlign = "center"; c.fillText(tickLabel(v, hi - lo), X(v), g.h - 15); });
    c.fillText("total after N trades (" + unit + ")", L + W / 2, g.h - 2);
    c.strokeStyle = COL.text; c.setLineDash([4, 4]); c.beginPath(); c.moveTo(X(0), T); c.lineTo(X(0), T + rows.length * rowH); c.stroke(); c.setLineDash([]);
    rows.forEach(function (r, i) {
      var y = T + i * rowH + rowH / 2, k = r[2];
      c.fillStyle = COL.text; c.textAlign = "right"; c.fillText((narrow ? "" : "next ") + r[0] + ", " + (narrow ? r[1].replace("measured ", "") : r[1]), L - 8, y + 4);
      c.strokeStyle = r[3]; c.lineWidth = 1.5; c.beginPath(); c.moveTo(X(k.q05), y); c.lineTo(X(k.q95), y); c.stroke();
      c.fillStyle = r[3]; c.globalAlpha = 0.45; c.fillRect(X(k.q25), y - rowH * 0.28, X(k.q75) - X(k.q25), rowH * 0.56); c.globalAlpha = 1;
      c.fillRect(X(k.q50) - 1.2, y - rowH * 0.34, 2.4, rowH * 0.68);
    });
  }

  /* ---------------------------------------------------------------- render: free part */
  var VERDICT_TEXT = {
    "NO DATA": ["", "Load a file or try an example."],
    "NO EVIDENCE": ["ec-v-no", "These trades cannot be told apart from a strategy with no edge after costs. That does not prove there is no edge; it means this record gives no evidence of one."],
    "WEAK": ["ec-v-weak", "The average is positive, but the evidence is weak: too few trades, or too many strategies tried, for it to stand out from luck."],
    "LOOKS SIGNIFICANT - CHECK STABILITY & COSTS": ["ec-v-check", "The average would be unusual for pure luck under the test's assumptions, but at least one stability or cost check failed (see the list). Results that rest on one period, a few trades or low costs often do not repeat."],
    "SIGNIFICANT AND STABLE": ["ec-v-ok", "The average would be unusual for pure luck under the test's assumptions, and it passed the stability and cost checks below. This describes your past trades only; it is not a forecast."]
  };
  var REASON = {
    mean_le_0: "Why: the average result after costs is zero or negative.",
    n_lt_30: "Why: fewer than 30 trades.",
    sd_0: "Why: every result is identical, so the spread cannot be measured.",
    p_ge_025: "Why: a result this good would happen by luck alone more than 1 time in 4 (p of 0.25 or more).",
    bonf_ge_alpha: "Why: after correcting for the number of strategies you tried, p is not below your significance level.",
    failed_checks: "Why: the failed checks are marked below.",
    all_pass: "Why: p is below your significance level after the correction for strategies tried, and every applicable check passed."
  };

  function run() {
    if (!state.trades) return;
    var o = opts(), unit = o.unit, R = EC.analyze(state.trades, o);
    state.R = R; state.opts = o;
    $("ec-results").hidden = false;
    var vt = VERDICT_TEXT[R.verdict] || ["", ""], st = R.stats;
    $("ec-verdict").className = "ec-verdict " + vt[0];
    $("ec-verdict").setAttribute("data-verdict", R.verdict);
    $("ec-verdict").innerHTML = '<p class="ec-v-label">Verdict</p><p class="ec-v-word">' + esc(R.verdict) + "</p><p>" + vt[1] + '</p><p class="ec-v-reason">' + (REASON[R.reason] || "") + "</p>";
    if (!R.n) return;
    var u = esc(unit);
    var rows = [
      ["Trades", st.n],
      ["Average result after costs", fmt(st.mean) + " " + u + " per trade"],
      ["Average before costs / average cost", fmt(st.meanGross) + " / " + fmt(st.meanCost) + " " + u],
      ["Median trade", fmt(st.median) + " " + u],
      ["Spread of results (standard deviation)", fmt(st.sd) + " " + u],
      ["Win rate / break-even win rate", pct(st.winRate, 1) + " / " + (st.breakevenWinRate === null ? "-" : pct(st.breakevenWinRate, 1)) +
        (st.avgWin !== null && st.avgLoss !== null ? ' <span class="live-sub">(avg win ' + fmt(st.avgWin) + ", avg loss " + fmt(st.avgLoss) + ")</span>" : "")],
      ["t-statistic", st.t === null ? "-" : st.t.toFixed(2)],
      ["p, one-sided (chance of an average this good with zero edge)", fmtP(st.p)],
      ["p corrected for " + R.opts.nTried + " strateg" + (R.opts.nTried === 1 ? "y" : "ies") + " tried (Bonferroni)", fmtP(st.pBonf)],
      ["Bootstrap 95% range of the average", fmt(R.boot.lo) + " to " + fmt(R.boot.hi) + " " + u],
      ["Bootstrap samples with an average at or below zero", pctP(R.boot.pLE0)]
    ];
    $("ec-stats").innerHTML = rows.map(function (r) { return '<tr><th scope="row">' + r[0] + "</th><td>" + r[1] + "</td></tr>"; }).join("");
    var icon = { pass: ["ec-pass", "PASS"], fail: ["ec-fail", "FAIL"], na: ["ec-na", "n/a"] };
    $("ec-checks").innerHTML = R.checks.map(function (k) {
      var ic = icon[k.status];
      return '<li class="' + ic[0] + '"><span class="ec-tag">' + ic[1] + "</span><span><strong>" + esc(k.label) + '</strong><br><span class="live-sub">' + esc(k.detail) + "</span></span></li>";
    }).join("");
    $("ec-band-note").innerHTML = "Grey: " + EC.BAND_DRAW + " versions of your own trades with each trade's sign flipped at random (same trade sizes, no edge); the shaded area holds 95% of " +
      EC.BAND_SIMS + " such curves. " + '<span style="color:' + (R.band.real[R.n - 1] >= 0 ? COL.green : COL.red) + '">Coloured</span>: your real running total after costs, ' +
      fmt(R.band.real[R.n - 1], 2) + " " + u + ". Random-sign test: " + R.nullSim.countGE + " of " + EC.NULL_SIMS + " random versions did at least as well (p = " + fmtP(R.nullSim.p) + ").";
    $("ec-seed-out").textContent = "Seed " + R.opts.seed + ": the same seed and the same data always give the same numbers.";
    drawBand(R);
    renderFull();
  }

  /* ---------------------------------------------------------------- render: full report (gated) */
  function renderFull() {
    var a = access(), box = $("ec-full"), lock = $("ec-lock");
    if (a !== "full") { box.hidden = true; lock.hidden = false; renderLock(a); return; }
    lock.hidden = true; box.hidden = false;
    $("ec-fwd").innerHTML = '<p class="live-status">Simulating ' + EC.FWD_SIMS.toLocaleString("en-US") + " futures for each trade count ...</p>";
    $("ec-risk-out").innerHTML = "";
    var token = {}; state.token = token;
    setTimeout(function () {
      if (state.token !== token) return;
      var o = state.opts, F = EC.forward(state.R, { model: o.model, unit: o.unit, riskPct: o.riskPct });
      state.F = F;
      renderForward(F, o);
      $("ec-full").setAttribute("data-ready", "1");
    }, 30);
    $("ec-full").removeAttribute("data-ready");
    var s = loadLS(), left = [];
    if (!state.exampleId) {
      left.push(Math.max(0, GATE.FREE_OWN_REPORTS - s.free.length) + " of " + GATE.FREE_OWN_REPORTS + " free full reports left");
      if (s.email.unlocked) left.push(GATE.CREDITS_ENABLED ? Math.max(0, GATE.EMAIL_REPORTS - s.email.used.length) + " of " + GATE.EMAIL_REPORTS + " email reports left" : "email code: unlimited full reports during the launch");
      if (s.license.key && s.license.uses !== null) left.push("key: " + Math.max(0, GATE.LICENSE_USES - s.license.uses) + " of " + GATE.LICENSE_USES + " reports left");
    }
    $("ec-quota").textContent = state.exampleId ? "Built-in example: the full report is always free." :
      "The full report for this file is unlocked; re-running it with other settings is free. " + left.join("; ") + ".";
  }

  function renderForward(F, o) {
    var R = state.R, st = R.stats, u = esc(o.unit), el = $("ec-fwd");
    if (!F.available) { el.innerHTML = '<p class="live-status">The forward simulation is not available for this data: ' + esc(F.why) + ". Try another model.</p>"; $("ec-risk-out").innerHTML = ""; return; }
    var E = F.worlds[0], Z = F.worlds[1], an = R.analytic.nNeeded, html = "";
    var modelName = { normal: "a normal distribution with your average and spread", winloss: "fixed wins and losses at your win rate, average win and average loss", empirical: "your own trades, resampled" }[F.model];
    function nfmt(v) { return v === null ? "more than 2,000" : v.toLocaleString("en-US"); }
    var aTxt = F.alphaAdj < 0.001 ? F.alphaAdj.toExponential(1) : String(+F.alphaAdj.toFixed(4));
    if (st.mean > 0) {
      var n80 = E.nNeeded[0.8];
      html += '<p class="ec-big">' + (n80 === null ? "More than 2,000 trades" : "You need about " + n80.toLocaleString("en-US") + " trades") + "</p>" +
        "<p>If your measured average of " + fmt(st.mean) + " " + u + " per trade were the true edge, a record of " + (n80 === null ? "more than 2,000" : "about " + n80.toLocaleString("en-US")) +
        " trades would pass the same one-sided test (at " + aTxt + ") in 80% of simulated futures. You have " + R.n + ". The true edge may well be smaller than measured, which would need more.</p>";
    } else {
      html += '<p class="ec-big">No edge to detect</p><p>Your measured average after costs is ' + fmt(st.mean) + " " + u +
        " per trade. If that were the true edge, more trades would not turn it into evidence of a positive edge: the green line below stays near the bottom.</p>";
    }
    html += '<div class="table-wrap"><table class="compare live-table"><thead><tr><th scope="col">Chance the test shows the edge</th><th scope="col">Trades needed (simulated)</th><th scope="col">Formula</th></tr></thead><tbody>' +
      [0.8, 0.9, 0.95].map(function (p) { return '<tr><th scope="row">' + pct(p) + "</th><td>" + (st.mean > 0 ? nfmt(E.nNeeded[p]) : "-") + "</td><td>" + (an[p] === null || an[p] === undefined ? "-" : an[p].toLocaleString("en-US")) + "</td></tr>"; }).join("") +
      "</tbody></table></div>" +
      '<p class="fine">Simulated: ' + F.sims.toLocaleString("en-US") + " futures per trade count, drawn from " + modelName + ", each tested like the verdict (one-sided t-test at your significance level divided by strategies tried); interpolated between the trade counts on the chart. Formula: n = ((z<sub>&alpha;</sub> + z<sub>power</sub>) &times; spread / average)&sup2;.</p>";
    html += '<h3>Chance the test shows the edge, by number of trades</h3><div class="ec-canvas"><canvas id="ec-power" role="img" aria-label="Chance that the test shows the edge, by number of future trades"></canvas></div>' +
      '<p class="fine"><span style="color:' + COL.green + '">Green</span>: if your measured edge is real. <span style="color:' + COL.muted + '">Grey</span>: the same test with zero edge (false alarms; should stay near your significance level). Dashed: 80 / 90 / 95%.</p>';
    html += '<h3>The range of your next 100 and 250 trades</h3><div class="ec-canvas"><canvas id="ec-range" role="img" aria-label="Range of total results after the next 100 and 250 trades, measured edge versus zero edge"></canvas></div>' +
      '<p class="fine">Thin line: 90% of simulated futures (5th to 95th percentile). Box: the middle 50%. Tick: the median. Where the green and grey rows overlap, a real edge and pure luck look the same.</p>';
    html += '<div class="table-wrap"><table class="compare live-table"><thead><tr><th scope="col"></th><th scope="col">Next 100</th><th scope="col">Next 250</th></tr></thead><tbody>' +
      '<tr><th scope="row">Measured edge: middle 90% of totals</th><td>' + fmt(E.kept[100].q05, 1) + " to " + fmt(E.kept[100].q95, 1) + "</td><td>" + fmt(E.kept[250].q05, 1) + " to " + fmt(E.kept[250].q95, 1) + "</td></tr>" +
      '<tr><th scope="row">Measured edge: chance of a net loss anyway</th><td>' + pctP(E.kept[100].pNeg) + "</td><td>" + pctP(E.kept[250].pNeg) + "</td></tr>" +
      '<tr><th scope="row">Zero edge: middle 90% of totals</th><td>' + fmt(Z.kept[100].q05, 1) + " to " + fmt(Z.kept[100].q95, 1) + "</td><td>" + fmt(Z.kept[250].q05, 1) + " to " + fmt(Z.kept[250].q95, 1) + "</td></tr>" +
      '<tr><th scope="row">Zero edge: chance to average at least your ' + fmt(st.mean) + " anyway</th><td>" + pctP(Z.kept[100].pAtLeastObserved) + "</td><td>" + pctP(Z.kept[250].pAtLeastObserved) + "</td></tr>" +
      '</tbody></table></div><p class="fine">Totals in ' + u + ", after costs. These are simulations of what the measured numbers imply, not a forecast of your results.</p>";
    el.innerHTML = html;
    drawPower(F); drawRange(F, o.unit);
    renderRisk(F);
  }

  function renderRisk(F) {
    var K = F.risk, html = "", names = ["If your measured edge is real", "If there is no edge"];
    var Zs = K.worlds[1], Es = K.worlds[0];
    function safe(w) { return w.safeK === 0 ? "below 0.05%" : w.safeK >= EC.RISK_STEPS ? "10% or more" : String(+w.safeRiskPct.toFixed(2)) + "%"; }
    html += '<p class="ec-big">Up to ' + safe(Zs) + ' <span class="ec-big-sub">risk per trade, with no edge</span></p>' +
      "<p>Edge or no edge, sizing decides whether you survive. In the zero-edge simulation, risking up to <strong>" + safe(Zs) + "</strong> of the account per trade kept the chance of a 20% drawdown within the next 250 trades under 5%." +
      (state.R.stats.mean > 0 ? " Taking your measured edge at face value the limit is " + safe(Es) + (Es.safeK >= EC.RISK_STEPS ? " (the top of the range tested)" : "") + "; the true edge may be smaller than measured, so the zero-edge number is the cautious one." :
        " With your measured (not positive) average the limit is " + safe(Es) + ".") + "</p>";
    html += '<div class="table-wrap"><table class="compare live-table"><thead><tr><th scope="col">At ' + K.riskPct + '% risk per trade</th><th scope="col">Typical worst drawdown</th><th scope="col">1 in 10 futures worse than</th><th scope="col">Chance of -20%</th><th scope="col">Chance of -50%</th></tr></thead><tbody>';
    [1, 0].forEach(function (wi) {
      EC.KEEP.forEach(function (N) {
        var a = K.worlds[wi].at[N];
        html += '<tr><th scope="row">' + names[wi] + ", next " + N + "</th><td>-" + pct(a.ddMedian, 1) + "</td><td>-" + pct(a.dd90, 1) + "</td><td>" + pctP(a.p20) + "</td><td>" + pctP(a.p50) + "</td></tr>";
      });
    });
    html += '</tbody></table></div><p class="fine">Drawdown = the largest fall from a previous high of the account. Each simulated trade risks the chosen percentage of the current balance per 1R (' + esc(F.rHow) +
      "). Same simulated futures as above. Slippage, gaps through the stop, several open trades at once and changing position sizes are not modelled, so real drawdowns can be deeper. This is risk-sizing education, not a promise of returns.</p>";
    $("ec-risk-out").innerHTML = html;
  }

  /* ---------------------------------------------------------------- lock screens */
  function renderLock(kind) {
    var s = loadLS(), el = $("ec-lock"), html;
    var value = '<p class="ec-lock-value">See how many trades you need, and the risk per trade that keeps you from blowing up.</p>' +
      "<p>The full report adds the forward simulation (how many trades before your result means something; the range of your next 100 and 250 trades) and the drawdown simulation (risk per trade vs the chance of a -20% or -50% drawdown). The verdict and checks above stay free, and the 5 examples always show the full report.</p>";
    if (kind === "email") {
      html = value + "<p>You have used the " + GATE.FREE_OWN_REPORTS + " free full reports in this browser. Get " + (GATE.CREDITS_ENABLED ? GATE.EMAIL_REPORTS + " more" : "unlimited full reports during the launch") + " with a free code by email:</p>" +
        '<p><a class="btn btn-green" href="' + GATE.EMAIL_URL + '" rel="noopener" target="_blank">Get the free unlock code by email</a></p>' +
        '<p class="fine">The code comes from our Gumroad page (price $0). Your email is used for APXTT product news (new tools and launches); you can unsubscribe at any time. Your trades are not sent anywhere.</p>' +
        '<form id="ec-code-form" class="ec-inline"><label for="ec-code">Unlock code</label><input id="ec-code" autocomplete="off" spellcheck="false" placeholder="XXXX-XXXX-XXXX"><button class="btn btn-ghost" type="submit">Unlock</button></form><p id="ec-code-msg" class="fine" role="status"></p>';
    } else {
      html = value + "<p>You have used the free and email reports in this browser. More full reports need a report key:</p>" +
        "<p><strong>" + GATE.LICENSE_USES + " full reports per key" + (GATE.CREDITS_PRICE ? " for " + esc(GATE.CREDITS_PRICE) : "") + ".</strong> " + (GATE.CREDITS_PRICE ? "" : "The price is shown on the Gumroad page before you pay. ") +
        "One report is used per new trade file; re-running the same file with other settings is free.</p>" +
        '<p><a class="btn btn-green" href="' + GATE.CREDITS_URL + '" rel="noopener" target="_blank">Get a report key on Gumroad</a></p>' +
        '<form id="ec-key-form" class="ec-inline"><label for="ec-key">Report key</label><input id="ec-key" autocomplete="off" spellcheck="false" value="' + esc(s.license.key || "") + '" placeholder="XXXXXXXX-XXXXXXXX-XXXXXXXX-XXXXXXXX"><button class="btn btn-ghost" type="submit">Use 1 report</button></form><p id="ec-key-msg" class="fine" role="status"></p>' +
        '<p class="fine">When you press the button, only the key and our product id are sent to Gumroad, to check the key and count one use. Your trades are never sent. Gumroad sees your IP address, as with any web request.</p>';
    }
    el.innerHTML = html;
    var cf = $("ec-code-form");
    if (cf) cf.onsubmit = function (e) { e.preventDefault(); tryCode($("ec-code").value); };
    var kf = $("ec-key-form");
    if (kf) kf.onsubmit = function (e) { e.preventDefault(); tryKey($("ec-key").value); };
  }
  function sha256hex(text) {
    if (!(window.crypto && crypto.subtle)) return Promise.reject(new Error("this browser cannot check the code on this page (it needs https)"));
    return crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)).then(function (b) {
      return Array.prototype.map.call(new Uint8Array(b), function (x) { return (x < 16 ? "0" : "") + x.toString(16); }).join("");
    });
  }
  function tryCode(code) {
    var c = String(code || "").trim().toUpperCase();
    sha256hex(c).then(function (h) {
      if (h !== GATE.UNLOCK_SHA256) { $("ec-code-msg").textContent = "That code is not right. Check the email from Gumroad."; return; }
      var s = loadLS(); s.email.unlocked = true; saveLS(s); renderFull();
    }, function (e) { $("ec-code-msg").textContent = "Could not check the code: " + e.message; });
  }
  function tryKey(key) {
    var k = String(key || "").trim(), msg = $("ec-key-msg");
    if (!k) { msg.textContent = "Enter the key from your Gumroad receipt."; return; }
    msg.textContent = "Checking the key with Gumroad ...";
    var body = "product_id=" + encodeURIComponent(GATE.GUMROAD_PRODUCT_ID) + "&license_key=" + encodeURIComponent(k) + "&increment_uses_count=true";
    fetch("https://api.gumroad.com/v2/licenses/verify", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: body, credentials: "omit", referrerPolicy: "no-referrer" })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        var p = d.purchase || {};
        if (!d.success) { msg.textContent = "Gumroad did not accept this key: " + (d.message || "unknown key"); return; }
        if (p.refunded || p.chargebacked || p.disputed) { msg.textContent = "This key's purchase was refunded or disputed, so it no longer unlocks reports."; return; }
        var s = loadLS(); s.license.key = k; s.license.uses = d.uses;
        if (d.uses > GATE.LICENSE_USES) { saveLS(s); msg.textContent = "All " + GATE.LICENSE_USES + " reports on this key have been used."; return; }
        s.license.used.push(state.key); saveLS(s); renderFull();
      })
      .catch(function () { msg.textContent = "Could not reach Gumroad. Check your connection and try again; no report was used."; });
  }

  /* ---------------------------------------------------------------- wiring */
  function init() {
    var drop = $("ec-drop"), file = $("ec-file");
    file.addEventListener("change", function () { if (file.files[0]) loadFile(file.files[0]); });
    ["dragenter", "dragover"].forEach(function (ev) { drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.add("ec-over"); }); });
    ["dragleave", "drop"].forEach(function (ev) { drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.remove("ec-over"); }); });
    drop.addEventListener("drop", function (e) { var f = e.dataTransfer.files[0]; if (f) loadFile(f); });
    $("ec-paste-go").addEventListener("click", function () {
      var t = $("ec-paste").value;
      if (!t.trim()) { $("ec-load-msg").textContent = "Paste some rows first."; return; }
      useInfo(EC.parseText(t, "pasted"), "Pasted data");
    });
    var exRow = $("ec-examples");
    exRow.innerHTML = EXAMPLES.map(function (e) { return '<button type="button" class="ec-ex" data-ex="' + e.id + '" aria-pressed="false" title="' + esc(e.blurb) + '">' + esc(e.title) + "</button>"; }).join("");
    exRow.addEventListener("click", function (e) {
      var b = e.target.closest(".ec-ex"); if (!b) return;
      loadExample(b.getAttribute("data-ex"));
      var ex = EXAMPLES.filter(function (x) { return x.id === b.getAttribute("data-ex"); })[0];
      $("ec-ex-blurb").textContent = ex ? ex.blurb : "";
    });
    var t;
    ["ec-unit", "ec-incl", "ec-defcost", "ec-ntried", "ec-alpha", "ec-oos", "ec-seed", "ec-model", "ec-risk"].forEach(function (id) {
      $(id).addEventListener("change", function () { clearTimeout(t); t = setTimeout(run, 60); });
    });
    var rt, lastW = window.innerWidth;
    window.addEventListener("resize", function () {
      if (window.innerWidth === lastW) return;
      lastW = window.innerWidth;
      clearTimeout(rt);
      rt = setTimeout(function () { if (state.R && state.R.n) { drawBand(state.R); if (state.F && state.F.available && $("ec-power")) { drawPower(state.F); drawRange(state.F, state.opts.unit); } } }, 250);
    });
    var q = /[?&]example=([a-z]+)/.exec(location.search);
    if (q) loadExample(q[1]);
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init); else init();
})();
