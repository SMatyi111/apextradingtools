/* APXTT feedback widget: a one-tap anonymous poll and an optional "ask us / request a tool" box.
 *
 * ---- FILL THESE IN (Google Form > Send > link > open the form, view source or use "Get pre-filled link") ----
 * FORM_ACTION: the form's "formResponse" URL (https://docs.google.com/forms/d/e/<long id>/formResponse).
 * ENTRY_*:     the field names of the form's three short/paragraph questions (entry.123456789).
 * While FORM_ACTION still contains "REPLACE", nothing is sent and the box says "Form not connected yet". */
var FORM_ACTION = 'https://docs.google.com/forms/d/e/1FAIpQLSfAdqrggV_poFy1oESUB8-BfqUUTVXkGrDBhl5KAoPKHi-4YA/formResponse';
var ENTRY_PAGE = 'entry.18593366';
var ENTRY_MESSAGE = 'entry.1148851079';
var ENTRY_EMAIL = 'entry.2083535164';

/* What is sent where:
 * - Poll tap: one GoatCounter event "poll/<page>/<option>" (anonymous, no cookies). Nothing else.
 * - Ask box: only the text typed into it, the optional email and the page name go to the Google Form,
 *   and only when the visitor presses Send. GoatCounter then gets the event "ask/<page>", never the text.
 * Markup: <section class="section fb" data-fb-page="calculator" hidden></section>; this file fills it in
 * and un-hides it, so without JavaScript the section stays hidden. */
(function () {
  "use strict";

  var PAGES = {
    calculator: {
      question: "What would make this more useful for you?",
      options: ["More instruments", "Volatility-based sizing", "Save my settings", "Something else"]
    },
    "edge-check": {
      question: "What would make this more useful for you?",
      options: ["Clearer explanation", "More file formats (broker exports)", "Live tracking of my edge", "Something else"]
    },
    index: {
      heading: "Ask us / request a tool",
      question: "What would make this more useful for you?",
      options: ["A tool I need", "A question about trading stats", "Something else"]
    }
  };
  var MAX_LEN = 1000;

  // GoatCounter custom event; does nothing if GoatCounter is blocked or not loaded. Never pass user input here.
  function gcEvent(name) {
    if (window.goatcounter && window.goatcounter.count) window.goatcounter.count({ path: name, title: name, event: true });
  }
  function slug(s) { return String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, ""); }
  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }
  function getFlag(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function setFlag(k) { try { localStorage.setItem(k, "1"); } catch (e) { /* storage blocked: poll may show again */ } }
  function connected() { return FORM_ACTION.indexOf("REPLACE") < 0; }

  function build(sec) {
    var page = sec.getAttribute("data-fb-page"), cfg = PAGES[page];
    if (!cfg) return;
    var id = "fb-" + page, pollKey = "apxtt-poll-" + page;
    var pollDone = !!getFlag(pollKey);
    var html = '<div class="wrap narrow">' +
      '<h2 id="' + id + '-h">' + esc(cfg.heading || "Help us improve this tool") + "</h2>" +
      '<div class="fb-grid">' +
      (pollDone ? "" :
        '<div class="fb-card fb-poll" role="group" aria-labelledby="' + id + '-q">' +
        '<p class="fb-q" id="' + id + '-q">' + esc(cfg.question) + "</p>" +
        '<p class="fb-sub">One tap, anonymous.</p>' +
        '<div class="fb-opts">' + cfg.options.map(function (o) {
          return '<button type="button" class="fb-opt" data-opt="' + esc(slug(o)) + '">' + esc(o) + "</button>";
        }).join("") + "</div>" +
        '<p class="fb-thanks" role="status" aria-live="polite"></p></div>') +
      '<form class="fb-card fb-ask" novalidate>' +
      '<label class="fb-q" for="' + id + '-msg">Ask a question or request a tool. Easy ones we build or answer for free.</label>' +
      '<textarea id="' + id + '-msg" rows="4" maxlength="' + MAX_LEN + '" required></textarea>' +
      '<p class="fb-count" aria-hidden="true"><span>0</span> / ' + MAX_LEN + "</p>" +
      '<label class="fb-email-label" for="' + id + '-email">Email <span>(optional, only if you want a reply)</span></label>' +
      '<input id="' + id + '-email" type="email" autocomplete="email" maxlength="200">' +
      '<p class="fb-row"><button type="submit" class="btn btn-ghost fb-send">Send</button></p>' +
      '<p class="fb-status" role="status" aria-live="polite"></p>' +
      '<p class="fb-notice">Sent to our Google Form. Only what you write here is sent; add an email only if you want a reply.</p>' +
      "</form></div></div>";
    sec.innerHTML = html;
    sec.setAttribute("aria-labelledby", id + "-h");
    sec.hidden = false;

    var poll = sec.querySelector(".fb-poll");
    if (poll) {
      poll.addEventListener("click", function (e) {
        var b = e.target.closest(".fb-opt");
        if (!b || poll.getAttribute("data-done")) return;
        poll.setAttribute("data-done", "1");
        gcEvent("poll/" + page + "/" + b.getAttribute("data-opt"));
        setFlag(pollKey);
        Array.prototype.forEach.call(poll.querySelectorAll(".fb-opt"), function (x) {
          x.disabled = true;
          x.setAttribute("aria-pressed", x === b ? "true" : "false");
        });
        poll.querySelector(".fb-thanks").textContent = "Thanks!";
      });
    }

    var form = sec.querySelector(".fb-ask"), ta = form.querySelector("textarea"), em = form.querySelector("input[type=email]");
    var status = form.querySelector(".fb-status"), btn = form.querySelector(".fb-send"), cnt = form.querySelector(".fb-count span");
    ta.addEventListener("input", function () { cnt.textContent = String(ta.value.length); });
    form.addEventListener("submit", function (e) {
      e.preventDefault();
      var msg = ta.value.trim().slice(0, MAX_LEN), mail = em.value.trim();
      status.className = "fb-status";
      if (!msg) { status.textContent = "Write a question or a tool idea first."; status.className = "fb-status fb-warn"; ta.focus(); return; }
      if (mail && !em.checkValidity()) { status.textContent = "That email does not look right (or leave it empty)."; status.className = "fb-status fb-warn"; em.focus(); return; }
      if (!connected()) {
        // half-configured deploy: send nothing, say so, keep the text in the box
        status.textContent = "Form not connected yet. Your message was not sent; please email patterntradersltd@gmail.com instead.";
        status.className = "fb-status fb-warn";
        return;
      }
      var body = {};
      body[ENTRY_PAGE] = page;
      body[ENTRY_MESSAGE] = msg;
      body[ENTRY_EMAIL] = mail;
      btn.disabled = true;
      status.textContent = "Sending...";
      // no-cors: Google Forms does not allow reading the response; a network failure still rejects
      fetch(FORM_ACTION, { method: "POST", mode: "no-cors", body: new URLSearchParams(body) }).then(function () {
        status.textContent = "Thanks — we read every message.";
        status.className = "fb-status fb-ok";
        ta.value = ""; em.value = ""; cnt.textContent = "0";
        gcEvent("ask/" + page);
      }, function () {
        status.textContent = "Could not send. Check your connection and try again; your text is still in the box.";
        status.className = "fb-status fb-warn";
      }).then(function () { btn.disabled = false; });
    });
  }

  function init() { Array.prototype.forEach.call(document.querySelectorAll("[data-fb-page]"), build); }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init); else init();
})();
