/* APXTT Lot Size Calculator - runs entirely in the browser: nothing typed into it is sent anywhere.
 * The page also loads GoatCounter (anonymous visit counts, no cookies); this file sends it one event name,
 * "calc-result", never a number or any other input. The only other network request this file makes is one GET
 * for ECB reference exchange rates
 * (api.frankfurter.dev, no key, CORS-enabled). The rates are kept in this browser's local storage
 * for 12 hours. If the request fails, every conversion rate can be typed in by hand.
 *
 * Part 1 (LS core) is pure computation and also runs under Node for the Python cross-check
 * (tools/lot_size_run_js.js vs tools/lot_size_ref.py). Part 2 is the page UI.
 */
(function (root) {
  "use strict";
  var LS = {};

  /* ------------------------------------------------------------------ instrument table
   * contract: units of the base per 1 standard lot (FX: currency units; metals: troy ounces;
   *           indices: index units, i.e. 1 lot moves 1 quote-currency unit per index point; crypto: coins)
   * pip:      the price step this page calls a "pip" (FX, metals) or a "point" (indices, crypto)
   * quote:    the currency the price is quoted in (the profit/loss currency)
   * Conventions: FX pip = 0.0001, or 0.01 when the quote is JPY or HUF. Gold pip = 0.10 (the broker tick is 0.01).
   * Silver pip = 0.01 (tick 0.001). Index and crypto point = 1.0 of the price. Broker contract sizes for indices
   * and crypto vary, so the page lets the user override the contract size. */
  var CCY = ["USD", "EUR", "GBP", "JPY", "CHF", "AUD", "CAD", "NZD", "HUF"];
  var FX = ["EURUSD", "GBPUSD", "AUDUSD", "NZDUSD", "USDJPY", "USDCHF", "USDCAD",
    "EURGBP", "EURJPY", "GBPJPY", "AUDJPY", "NZDJPY", "CADJPY", "CHFJPY",
    "EURCHF", "EURAUD", "EURCAD", "EURNZD", "GBPCHF", "GBPAUD", "GBPCAD", "GBPNZD",
    "AUDCAD", "AUDCHF", "AUDNZD", "NZDCAD", "NZDCHF", "CADCHF", "EURHUF", "USDHUF"];
  var INSTR = {};
  FX.forEach(function (s) {
    var q = s.slice(3);
    INSTR[s] = { cls: "fx", base: s.slice(0, 3), quote: q, contract: 100000, pip: (q === "JPY" || q === "HUF") ? 0.01 : 0.0001,
      unit: "pip", label: s.slice(0, 3) + "/" + q };
  });
  INSTR.XAUUSD = { cls: "metal", base: "XAU", quote: "USD", contract: 100, pip: 0.1, tick: 0.01, unit: "pip", label: "Gold (XAU/USD)" };
  INSTR.XAGUSD = { cls: "metal", base: "XAG", quote: "USD", contract: 5000, pip: 0.01, tick: 0.001, unit: "pip", label: "Silver (XAG/USD)" };
  [["US30", "USD", "Dow Jones (US30)"], ["NAS100", "USD", "Nasdaq 100 (NAS100)"], ["SPX500", "USD", "S&P 500 (SPX500)"],
   ["GER40", "EUR", "DAX (GER40)"], ["UK100", "GBP", "FTSE 100 (UK100)"], ["JP225", "JPY", "Nikkei 225 (JP225)"]].forEach(function (a) {
    INSTR[a[0]] = { cls: "index", base: a[0], quote: a[1], contract: 1, pip: 1, unit: "point", label: a[2] };
  });
  INSTR.BTCUSD = { cls: "crypto", base: "BTC", quote: "USD", contract: 1, pip: 1, unit: "point", label: "Bitcoin (BTC/USD)" };
  INSTR.ETHUSD = { cls: "crypto", base: "ETH", quote: "USD", contract: 1, pip: 1, unit: "point", label: "Ethereum (ETH/USD)" };
  LS.CCY = CCY;
  LS.INSTR = INSTR;
  LS.ROUND_WARN = 0.10;  // warn when the rounded size risks more than 10% less than the target

  /* ------------------------------------------------------------------ exchange rates
   * rates: ECB reference rates with EUR as base, { USD: 1.1133, JPY: 175.86, ... } (EUR itself is 1).
   * cross(rates, from, to) = how many `to` one unit of `from` buys. */
  function cross(rates, from, to) {
    if (from === to) return 1;
    if (!rates) return null;
    var f = from === "EUR" ? 1 : rates[from], t = to === "EUR" ? 1 : rates[to];
    if (!(f > 0) || !(t > 0)) return null;
    return t / f;
  }
  LS.cross = cross;

  /* A typed rate is shown the way the market quotes the pair, so traders can copy it from their platform:
   * "1 USD = 150 JPY", "1 GBP = 438 HUF", "1 EUR = 1.11 USD". The currency earlier in PRIO is the base. */
  var PRIO = ["EUR", "GBP", "AUD", "NZD", "USD", "CAD", "CHF", "JPY", "HUF"];
  // "q2a": the field means 1 quote = x account; "a2q": 1 account = x quote
  LS.rateDir = function (quote, account) { return PRIO.indexOf(quote) <= PRIO.indexOf(account) ? "q2a" : "a2q"; };

  function stepDecimals(step) {
    var s = String(step);
    if (s.indexOf("e-") >= 0) return parseInt(s.split("e-")[1], 10);
    var i = s.indexOf(".");
    return i < 0 ? 0 : s.length - i - 1;
  }
  // Round DOWN to a whole number of broker steps. The 1e-9 guards against 0.4999999999 from binary floating point.
  function floorStep(x, step) {
    var n = Math.floor(x / step + 1e-9);
    var d = stepDecimals(step);
    return { n: n, v: Number((n * step).toFixed(Math.min(d, 12))) };
  }
  LS.floorStep = floorStep;

  function num(x) { return (x === null || x === undefined || x === "") ? NaN : Number(x); }

  /* ------------------------------------------------------------------ the calculation
   * inp: { symbol, account, balance, riskMode: "pct"|"amount", risk, stopMode: "pips"|"price", stopPips, entry, stop,
   *        contract (optional override), lotStep (default 0.01), minLot (default = lotStep), rates (EUR base), rate (optional manual
   *        override) and rateDir ("q2a": 1 quote = rate account, the default; "a2q": 1 account = rate quote) }
   * Returns { ok, errors[], ... } with every number the page shows. */
  LS.calc = function (inp) {
    var errors = [];
    var spec = INSTR[inp.symbol];
    if (!spec) return { ok: false, errors: ["Unknown instrument."] };
    var account = inp.account;
    var balance = num(inp.balance), risk = num(inp.risk);
    var contract = num(inp.contract) > 0 ? num(inp.contract) : spec.contract;
    var step = num(inp.lotStep) > 0 ? num(inp.lotStep) : 0.01;
    var minLot = num(inp.minLot) > 0 ? num(inp.minLot) : step;
    var riskMode = inp.riskMode === "amount" ? "amount" : "pct";
    if (!(balance > 0) && riskMode === "pct") errors.push("Enter your account balance.");
    if (!(risk > 0)) errors.push(riskMode === "pct" ? "Enter the risk per trade in %." : "Enter the amount you want to risk.");
    var riskMoney = riskMode === "pct" ? balance * risk / 100 : risk;

    var stopDist, entry = num(inp.entry), stop = num(inp.stop), stopPips;
    if (inp.stopMode === "price") {
      if (!(entry > 0) || !(stop > 0)) errors.push("Enter both the entry and the stop-loss price.");
      else if (entry === stop) errors.push("Entry and stop loss are the same price.");
      stopDist = Math.abs(entry - stop);
      stopPips = stopDist / spec.pip;
    } else {
      stopPips = num(inp.stopPips);
      if (!(stopPips > 0)) errors.push("Enter the stop-loss distance in " + spec.unit + "s.");
      stopDist = stopPips * spec.pip;
    }

    // quote currency -> account currency
    var rate = null, rateSrc = null, manual = num(inp.rate);
    if (spec.quote === account) { rate = 1; rateSrc = "same"; }
    else if (manual > 0) { rate = inp.rateDir === "a2q" ? 1 / manual : manual; rateSrc = "manual"; }
    else if (inp.stopMode === "price" && spec.cls === "fx" && spec.base === account && entry > 0) { rate = 1 / entry; rateSrc = "entry"; }
    else { rate = cross(inp.rates, spec.quote, account); rateSrc = rate ? "ecb" : null; }
    if (!(rate > 0)) errors.push("Enter the " + spec.quote + " to " + account + " exchange rate.");

    if (errors.length) return { ok: false, errors: errors, spec: spec, rateSrc: rateSrc };

    var lossPerLot = contract * stopDist * rate;          // account currency lost by 1 lot at the stop
    var lotsRaw = riskMoney / lossPerLot;
    var fl = floorStep(lotsRaw, step);
    var lots = fl.v, belowMin = false;
    if (lots < minLot - 1e-12) { belowMin = true; lots = 0; }
    var riskAtLots = lots * lossPerLot;
    var minLotRisk = minLot * lossPerLot;
    var res = {
      ok: true, errors: [], spec: spec, symbol: inp.symbol, account: account,
      contract: contract, lotStep: step, minLot: minLot,
      riskMoney: riskMoney, stopDist: stopDist, stopPips: stopPips,
      rate: rate, rateSrc: rateSrc,
      pipValuePerLot: contract * spec.pip * rate,
      lossPerLot: lossPerLot,
      lotsRaw: lotsRaw, lots: lots, units: lots * contract,
      riskAtLots: riskAtLots,
      riskPctAtLots: balance > 0 ? riskAtLots / balance * 100 : null,
      belowMin: belowMin, minLotRisk: minLotRisk,
      minLotRiskPct: balance > 0 ? minLotRisk / balance * 100 : null,
      roundingShortfall: riskMoney > 0 ? (riskMoney - riskAtLots) / riskMoney : 0
    };
    res.roundingWarn = !belowMin && res.roundingShortfall > LS.ROUND_WARN;
    return res;
  };

  if (typeof module !== "undefined" && module.exports) module.exports = LS;
  root.APXTT_LS = LS;

  /* ================================================================== Part 2: page UI */
  if (typeof document === "undefined") return;

  var FX_URL_V2 = "https://api.frankfurter.dev/v2/rates?base=EUR&quotes=" + CCY.filter(function (c) { return c !== "EUR"; }).join(",") + "&providers=ECB";
  var FX_URL_V1 = "https://api.frankfurter.dev/v1/latest?base=EUR&symbols=" + CCY.filter(function (c) { return c !== "EUR"; }).join(",");
  var CACHE_KEY = "apxtt-ecb-rates-v1", CACHE_MS = 12 * 3600 * 1000;
  var fx = { rates: null, date: null, state: "loading" };

  function $(id) { return document.getElementById(id); }
  // GoatCounter custom event; safe when GoatCounter is blocked. Only fixed names, never user input.
  function gcEvent(name) {
    if (window.goatcounter && window.goatcounter.count) window.goatcounter.count({ path: name, title: name, event: true });
  }
  var userTouched = false, resultCounted = false, lastOutHtml = "";  // count the first result the visitor produced, once per page view
  function val(id) { var e = $(id); return e ? e.value : ""; }

  function fmt(x, d) {
    if (!isFinite(x)) return "-";
    return x.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
  }
  function money(x, ccy) {
    var d = (ccy === "JPY" || ccy === "HUF") ? 0 : 2;
    if (Math.abs(x) < 1 && d === 0) d = 2;
    return fmt(x, d) + " " + ccy;
  }
  function sig(x) {  // a rate with ~6 significant digits
    if (!isFinite(x) || x <= 0) return "";
    var d = Math.max(0, 5 - Math.floor(Math.log10(x)));
    return String(Number(x.toFixed(Math.min(d, 10))));
  }
  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }

  function readCache() {
    try {
      var c = JSON.parse(localStorage.getItem(CACHE_KEY) || "null");
      if (c && c.rates && c.date && Date.now() - c.t < CACHE_MS) return c;
    } catch (e) { /* storage blocked: just fetch */ }
    return null;
  }
  function writeCache(rates, date) {
    try { localStorage.setItem(CACHE_KEY, JSON.stringify({ rates: rates, date: date, t: Date.now() })); } catch (e) { /* ignore */ }
  }
  function getJSON(url) {
    var ctl = typeof AbortController !== "undefined" ? new AbortController() : null;
    var timer = ctl ? setTimeout(function () { ctl.abort(); }, 8000) : null;
    return fetch(url, ctl ? { signal: ctl.signal } : {}).then(function (r) {
      if (timer) clearTimeout(timer);
      if (!r.ok) throw new Error("HTTP " + r.status);
      return r.json();
    }, function (e) { if (timer) clearTimeout(timer); throw e; });
  }
  function parseV2(j) {
    if (!Array.isArray(j) || !j.length) throw new Error("bad v2");
    var rates = {}, date = "";
    j.forEach(function (row) { if (row && row.quote && row.rate > 0) { rates[row.quote] = row.rate; if (row.date > date) date = row.date; } });
    if (!rates.USD) throw new Error("bad v2");
    return { rates: rates, date: date };
  }
  function parseV1(j) {
    if (!j || !j.rates || !j.rates.USD) throw new Error("bad v1");
    return { rates: j.rates, date: j.date };
  }
  function loadRates() {
    var c = readCache();
    if (c) { fx.rates = c.rates; fx.date = c.date; fx.state = "ok"; render(); return; }
    getJSON(FX_URL_V2).then(parseV2).catch(function () { return getJSON(FX_URL_V1).then(parseV1); }).then(function (r) {
      fx.rates = r.rates; fx.date = r.date; fx.state = "ok";
      writeCache(r.rates, r.date);
      render();
    }).catch(function () {
      fx.state = "failed";
      render();
    });
  }

  var manualRate = false;  // true once the user has typed into the rate field

  function inputs() {
    var stopMode = document.querySelector("input[name=ls-stopmode]:checked").value;
    var riskMode = document.querySelector("input[name=ls-riskmode]:checked").value;
    return {
      symbol: val("ls-instr"), account: val("ls-ccy"), balance: val("ls-balance"),
      riskMode: riskMode, risk: val("ls-risk"),
      stopMode: stopMode, stopPips: val("ls-pips"), entry: val("ls-entry"), stop: val("ls-stop"),
      contract: val("ls-contract"), lotStep: val("ls-step"), minLot: val("ls-minlot"),
      rates: fx.rates, rate: manualRate ? val("ls-rate") : "",
      rateDir: LS.rateDir(INSTR[val("ls-instr")].quote, val("ls-ccy"))
    };
  }

  function updateLabels(spec, account) {
    var u = spec.unit;
    var pipTxt = u === "pip"
      ? "1 pip = " + spec.pip + " in price" + (spec.tick ? " (the broker tick is " + spec.tick + ")" : "")
      : "1 point = " + spec.pip.toFixed(1) + " in price";
    $("ls-pips-label").textContent = "Stop-loss distance (" + u + "s)";
    $("ls-pip-def").textContent = pipTxt;
    $("ls-contract").placeholder = String(spec.contract);
    $("ls-contract-def").textContent = "Default " + fmt(spec.contract, 0) + " " +
      (spec.cls === "fx" ? spec.base + " per lot" : spec.cls === "metal" ? "oz per lot" : spec.cls === "crypto" ? spec.base + " per lot" : "x index per lot") +
      (spec.cls === "index" || spec.cls === "crypto" ? ". Brokers differ: check the contract size in your platform's symbol specification." : ".");
    $("ls-riskunit").textContent = $("ls-risk-pct").checked ? "%" : account;
    var dir = LS.rateDir(spec.quote, account);
    $("ls-rate-pre").textContent = "1 " + (dir === "q2a" ? spec.quote : account) + " =";
    $("ls-rate-post").textContent = dir === "q2a" ? account : spec.quote;
  }

  function render() {
    var inp = inputs();
    var spec = INSTR[inp.symbol];
    updateLabels(spec, inp.account);
    $("ls-pips-row").hidden = inp.stopMode !== "pips";
    $("ls-price-row").hidden = inp.stopMode !== "price";

    // FX status line
    var st = $("ls-fx-status");
    if (fx.state === "ok") { st.textContent = "Exchange rates: ECB reference rates of " + fx.date + " (via frankfurter.dev). You can overwrite the rate."; st.className = "fine ls-fx ok"; }
    else if (fx.state === "failed") { st.textContent = "Could not load exchange rates. The calculator still works: type the conversion rate below when it asks for one."; st.className = "fine ls-fx ls-warn-text"; }
    else { st.textContent = "Loading ECB exchange rates..."; st.className = "fine ls-fx"; }

    var R = LS.calc(inp);
    // conversion rate field: show the rate in use unless the user typed their own
    var rateRow = $("ls-rate-row"), rateField = $("ls-rate"), rateSrc = $("ls-rate-src");
    var needRate = spec.quote !== inp.account;
    rateRow.hidden = !needRate;
    if (needRate) {
      if (!manualRate) {
        var r0 = LS.calc(Object.assign({}, inp, { rate: "" }));
        rateField.value = r0.rate > 0 && r0.rateSrc !== "same" ? sig(inp.rateDir === "a2q" ? 1 / r0.rate : r0.rate) : "";
        rateSrc.textContent = r0.rateSrc === "entry" ? "from your entry price (1 / " + inp.entry + ")"
          : r0.rateSrc === "ecb" ? "ECB rate of " + fx.date : "enter the rate by hand";
      } else {
        rateSrc.innerHTML = "your rate &middot; <button type=\"button\" id=\"ls-rate-reset\" class=\"ls-link\">use the automatic rate</button>";
        $("ls-rate-reset").onclick = function () { manualRate = false; render(); };
      }
      rateField.classList.toggle("ls-need", !(R.rate > 0));
    }

    var out = $("ls-out");
    if (!R.ok) {
      out.innerHTML = "<p class=\"ls-big ls-big-empty\">&ndash;</p><ul class=\"ls-errors\">" +
        R.errors.map(function (e) { return "<li>" + esc(e) + "</li>"; }).join("") + "</ul>";
      out.setAttribute("data-lots", "");
      lastOutHtml = "";
      return;
    }
    var unitWord = spec.cls === "fx" ? spec.base : spec.cls === "metal" ? "oz" : spec.cls === "crypto" ? spec.base : "contracts";
    var lotsTxt = fmt(R.lots, stepDecimals(R.lotStep));
    var html = "<p class=\"ls-label\">Position size</p>" +
      "<p class=\"ls-big\" id=\"ls-lots\">" + lotsTxt + " <span>lots</span></p>" +
      "<div class=\"table-wrap\"><table class=\"compare ls-table\"><tbody>" +
      "<tr><th scope=\"row\">Units</th><td>" + fmt(R.units, R.units % 1 ? 2 : 0) + " " + esc(unitWord) + "</td></tr>" +
      "<tr><th scope=\"row\">Money at risk at " + lotsTxt + " lots</th><td id=\"ls-riskat\">" + money(R.riskAtLots, inp.account) +
        (R.riskPctAtLots !== null ? " <span class=\"ls-sub\">(" + fmt(R.riskPctAtLots, 2) + "%)</span>" : "") + "</td></tr>" +
      "<tr><th scope=\"row\">Target risk</th><td>" + money(R.riskMoney, inp.account) + "</td></tr>" +
      "<tr><th scope=\"row\">" + (spec.unit === "pip" ? "Pip" : "Point") + " value per 1.00 lot</th><td id=\"ls-pipval\">" + money(R.pipValuePerLot, inp.account) + "</td></tr>" +
      "<tr><th scope=\"row\">Stop distance</th><td>" + fmt(R.stopPips, R.stopPips % 1 ? 1 : 0) + " " + spec.unit + "s &middot; " + sig(R.stopDist) + " in price</td></tr>" +
      "<tr><th scope=\"row\">Exact size before rounding</th><td>" + fmt(R.lotsRaw, 4) + " lots</td></tr>" +
      (R.rateSrc !== "same" ? "<tr><th scope=\"row\">Conversion used</th><td>" + (inp.rateDir === "a2q"
        ? "1 " + inp.account + " = " + sig(1 / R.rate) + " " + spec.quote : "1 " + spec.quote + " = " + sig(R.rate) + " " + inp.account) + "</td></tr>" : "") +
      "</tbody></table></div>";
    if (R.belowMin) {
      html += "<p class=\"ls-alert\" id=\"ls-warn\"><strong>Below the minimum lot.</strong> Your risk allows " + fmt(R.lotsRaw, 4) +
        " lots, less than the broker minimum of " + R.minLot + ". The smallest trade (" + R.minLot + " lots) would risk " +
        money(R.minLotRisk, inp.account) + (R.minLotRiskPct !== null ? " (" + fmt(R.minLotRiskPct, 2) + "% of the account)" : "") +
        ". Do not move the stop closer just to make the size fit: skip the trade, or take the larger risk knowingly.</p>";
    } else if (R.roundingWarn) {
      html += "<p class=\"ls-alert\" id=\"ls-warn\"><strong>Rounding cuts your risk by " + fmt(R.roundingShortfall * 100, 0) + "%.</strong> " +
        "The exact size is " + fmt(R.lotsRaw, 4) + " lots; the broker step of " + R.lotStep + " rounds it down to " + lotsTxt +
        ", so this trade risks " + money(R.riskAtLots, inp.account) + " instead of " + money(R.riskMoney, inp.account) + ".</p>";
    }
    html += "<p class=\"ls-next\"><strong>Next: log this trade.</strong> " +
      "<a class=\"ls-next-link\" href=\"https://stvert.gumroad.com/l/apxtt-free-demo\" rel=\"noopener\">Get the free Excel journal demo &rarr;</a>" +
      "<span class=\"ls-sub\">Excel runs on your computer: Gumroad emails you the download link, so you can grab it on your phone now and open it later.</span></p>";
    // Redraw only when the result changed: a blur re-render under the finger would swallow a tap on the link.
    if (html !== lastOutHtml) { out.innerHTML = html; lastOutHtml = html; }
    out.setAttribute("data-lots", String(R.lots));
    if (userTouched && !resultCounted) { resultCounted = true; gcEvent("calc-result"); }
  }

  function init() {
    // The result is re-rendered on every input, so the demo link inside it is counted by delegation.
    $("ls-out").addEventListener("click", function (e) {
      if (e.target.closest && e.target.closest(".ls-next-link")) gcEvent("gumroad-demo-result");
    });
    var sel = $("ls-instr");
    var groups = [["fx", "Forex"], ["metal", "Metals"], ["index", "Indices (CFD)"], ["crypto", "Crypto (CFD)"]];
    groups.forEach(function (g) {
      var og = document.createElement("optgroup");
      og.label = g[1];
      Object.keys(INSTR).forEach(function (k) {
        if (INSTR[k].cls !== g[0]) return;
        var o = document.createElement("option");
        o.value = k; o.textContent = INSTR[k].cls === "fx" ? k : INSTR[k].label;
        og.appendChild(o);
      });
      sel.appendChild(og);
    });
    sel.value = "EURUSD";
    var ccy = $("ls-ccy");
    CCY.forEach(function (c) { var o = document.createElement("option"); o.value = c; o.textContent = c; ccy.appendChild(o); });
    ccy.value = "USD";

    var form = $("ls-form");
    form.addEventListener("input", function (e) {
      userTouched = true;
      if (e.target && e.target.id === "ls-rate") manualRate = e.target.value.trim() !== "";
      if (e.target && (e.target.id === "ls-instr" || e.target.id === "ls-ccy")) manualRate = false;
      render();
    });
    form.addEventListener("change", function (e) {
      userTouched = true;
      if (e.target && (e.target.id === "ls-instr" || e.target.id === "ls-ccy")) { manualRate = false; $("ls-contract").value = ""; }
      render();
    });
    form.addEventListener("submit", function (e) { e.preventDefault(); });
    render();
    loadRates();
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init); else init();
})(typeof window !== "undefined" ? window : globalThis);
