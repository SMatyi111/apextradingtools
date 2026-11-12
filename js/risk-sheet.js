/* Free prop-challenge risk sheet (lead capture test, 2026-11-12, marketing/TEST_LEADS_2026-11-12.md).
   Same rule as the Drawdown Rulebook and tools/risk_plan: max risk per trade = min(daily / (N + 1), max loss / 11).
   The email and the four numbers go to the existing Google Form only when the button is pressed. */
(function () {
  var FORM = "https://docs.google.com/forms/d/e/1FAIpQLSfAdqrggV_poFy1oESUB8-BfqUUTVXkGrDBhl5KAoPKHi-4YA/formResponse";
  var K = 10;
  function $(id) { return document.getElementById(id); }
  var form = $("rs-form"); if (!form) return;
  var ig = /[?&]src=ig\b/.test(location.search) || /instagram\./.test(document.referrer);
  function gc(n) { if (window.goatcounter && window.goatcounter.count) window.goatcounter.count({ path: n + (ig ? "-ig" : ""), title: n, event: true }); }
  function money(x) { return "$" + Math.round(x).toLocaleString("en-US"); }
  function pct(x) { return (Math.round(x * 100) / 100).toString() + "%"; }
  var started = false;
  form.addEventListener("input", function () { if (!started) { started = true; gc("sheet-start"); } });
  form.addEventListener("keydown", function (e) { if (e.key === "Enter") { e.preventDefault(); go(); } });
  $("rs-go").addEventListener("click", go);
  function go() {
    var bal = Number($("rs-bal").value), d = Number($("rs-daily").value), m = Number($("rs-max").value),
        n = Math.round(Number($("rs-n").value)), email = $("rs-email").value.trim(), msg = $("rs-msg");
    if (!(bal > 0 && d > 0 && m > 0 && n >= 1 && d <= 50 && m <= 50)) { msg.textContent = "Check the four numbers (limits in % of the account)."; return; }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { msg.textContent = "Enter a valid email so we can send your copy."; return; }
    var rDaily = d / (n + 1), rMax = m / (K + 1), r = Math.min(rDaily, rMax);
    var lossesDay = Math.floor(d / r + 1e-9), lossesMax = Math.floor(m / r + 1e-9);
    var rows = [
      ["Daily loss limit", pct(d) + " = " + money(bal * d / 100)],
      ["Maximum loss", pct(m) + " = " + money(bal * m / 100)],
      ["Max risk per trade", "<strong>" + pct(r) + " = " + money(bal * r / 100) + "</strong>"],
      ["Losing trades before the daily limit", lossesDay],
      ["Losing trades before the maximum loss", lossesMax]
    ];
    var html = "<h3>Your risk sheet</h3><table class=\"rs-table\">" + rows.map(function (x) {
      return "<tr><th>" + x[0] + "</th><td>" + x[1] + "</td></tr>"; }).join("") + "</table>" +
      "<p class=\"rs-why\">Why: " + pct(d) + " / (" + n + " + 1) = " + pct(rDaily) + " for the daily limit, " + pct(m) + " / 11 = " + pct(rMax) +
      " for the maximum loss; the smaller one wins. Use " + money(bal * r / 100) + " as the risk in the calculator above to get your lot size.</p>" +
      "<p class=\"rs-why\">Assumes every loss is a full stop-out and limits measured on the starting balance; trailing drawdowns are stricter. " +
      "Education, not financial advice; no results promised.</p>";
    var body = new URLSearchParams();
    body.append("entry.18593366", "risk-sheet" + (ig ? "-ig" : ""));
    body.append("entry.1148851079", "Risk sheet: balance " + bal + ", daily " + d + "%, max " + m + "%, trades/day " + n + " -> " + pct(r));
    body.append("entry.2083535164", email);
    $("rs-go").disabled = true;
    fetch(FORM, { method: "POST", mode: "no-cors", body: body }).catch(function () {}).then(function () {
      gc("sheet-signup");
      form.hidden = true;
      var out = $("rs-out"); out.innerHTML = html; out.hidden = false;
      msg.textContent = "Done. A copy is on its way to " + email + " within a day (check spam).";
      out.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  }
})();
