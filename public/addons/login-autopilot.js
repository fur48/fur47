/* Login autopilot — standalone addon for "Our Discussion Room".
   v5 (owner report: "খালি ঘুরতেই থাকে, অনেকবার reload দিলে পড়ে"): v4 could
   still loop — after a cold enter the chat page has NO message nodes for the
   first seconds, so "no chat content" was true and it reloaded again. v5:
   the auto-reload happens AT MOST ONCE EVER (localStorage counter) — after
   that the app always lands on its own; the spinner is just feedback while
   the login POST/wake-up runs, hard-capped at 90 s.
   Also: visible-password only (hidden DOM shells never count), no reload
   while mustChangePassword or an addon modal is up, fully passive in chat.
*/
(() => {
  "use strict";
  if (window.__bcaLoginAutopilot) return;
  window.__bcaLoginAutopilot = true;
  console.log("[bca] login-autopilot v5 loaded");

  // ---------- spinner (text-free, hard-capped) ----------
  let spin = null;
  let spinShownAt = 0;
  function spinShow() {
    spinShownAt = Date.now();
    if (spin) { spin.style.display = "flex"; return; }
    spin = document.createElement("div");
    spin.id = "bca-login-spin";
    spin.style.cssText =
      "position:fixed;inset:0;z-index:199999;display:flex;align-items:center;justify-content:center;" +
      "background:rgba(0,0,0,.55)";
    const ring = document.createElement("div");
    ring.style.cssText =
      "width:42px;height:42px;border-radius:50%;border:4px solid rgba(255,255,255,.25);" +
      "border-top-color:#fff;animation:bca-spin-rot .8s linear infinite";
    spin.appendChild(ring);
    const st = document.createElement("style");
    st.textContent = "@keyframes bca-spin-rot{to{transform:rotate(360deg)}}";
    document.head.appendChild(st);
    (document.body || document.documentElement).appendChild(spin);
  }
  function spinHide() { if (spin) spin.style.display = "none"; }

  // ---------- page-state helpers ----------
  function visiblePassword() {
    for (const el of document.querySelectorAll('input[type="password"]')) {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.height > 0 && el.offsetParent !== null) return true;
    }
    return false; // hidden/absent shells don't count (v4)
  }
  function chatVisible() {
    return !!document.querySelector('div[id^="message-"]');
  }

  // ---------- login-attempt detection (spinner ON instantly) ----------
  document.addEventListener("click", (e) => {
    if (visiblePassword() && e.target.closest?.('button[type="submit"], input[type="submit"], .btn-primary')) spinShow();
  }, true);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && e.target.matches?.('input[type="password"]') && visiblePassword()) spinShow();
  }, true);

  // ---------- probe loop ----------
  let lastOk = false;
  let probing = false;
  async function probe() {
    if (probing) return;
    probing = true;
    try {
      const res = await fetch("/api/users/me", { credentials: "same-origin" });
      if (!res.ok) { lastOk = false; return; } // waiting — spinner keeps spinning
      const me = await res.json().catch(() => null);
      if (!me?.username) { lastOk = false; return; }
      if (me.mustChangePassword) { spinHide(); return; } // forced-change modal owns the screen
      // in the chat already (or no visible login form) → nothing to do, ever
      if (chatVisible() || !visiblePassword()) { lastOk = true; spinHide(); return; }
      if (lastOk) return; // steady logged-in on the login screen? still wait quietly
      lastOk = true; // fresh 401→200 = login just landed
      setTimeout(() => {
        // v5: reload AT MOST ONCE EVER (localStorage counter). The chat page
        // keeps messages sparse for the first seconds after a cold enter, so
        // the old "no chat content" check could loop. Now: one reload total,
        // then never again — the app always lands on its own.
        let reloads = 0;
        try { reloads = Number(localStorage.getItem("bcaAutoRelN") || 0); } catch { /* private mode */ }
        if (visiblePassword() && !document.querySelector(".bca-overlay") && reloads < 1) {
          try { localStorage.setItem("bcaAutoRelN", String(reloads + 1)); } catch { /* private mode */ }
          location.reload();
        } else {
          spinHide();
        }
      }, 1500);
    } catch { /* transient — next tick retries */ }
    finally { probing = false; }
  }
  setInterval(probe, 1200);
  probe();
  // safety cap: the spinner can never spin for more than 90 s
  setInterval(() => {
    if (spin && spin.style.display !== "none" && Date.now() - spinShownAt > 90000) spinHide();
  }, 5000);
})();
