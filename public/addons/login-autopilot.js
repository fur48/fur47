/* Login autopilot — standalone addon for "Our Discussion Room".
   v4 (owner-reported regression fix): v3 reloaded whenever a password input
   EXISTED in the DOM — but the app keeps the login form (hidden) mounted on
   the chat page too, so it reloaded in a LOOP after entering the chat:
   tab loading-bar spun forever, and every reload re-handshaked the app's
   socket (which made even the "1" default-emoji reactions feel slow).
   v4 rules:
   - "visible" password field only (rect + offsetParent — hidden DOM shells
     no longer count),
   - reload ONLY if: visible login form AND no chat content AND no addon
     modal AND ≥15 s since the last auto-reload (loop impossible),
   - as soon as chat content exists → spinner off, fully passive,
   - spinner hard-cap 90 s — it can never trap the user.
*/
(() => {
  "use strict";
  if (window.__bcaLoginAutopilot) return;
  window.__bcaLoginAutopilot = true;
  console.log("[bca] login-autopilot v4 loaded");

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
  const RELOAD_COOLDOWN_MS = 15000;
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
        // reload ONCE only if genuinely stuck on a visible login form with no
        // chat content, no addon modal, and outside the cooldown window
        const last = Number(sessionStorage.getItem("bcaAutoRel") || 0);
        const cooldownOk = Date.now() - last > RELOAD_COOLDOWN_MS;
        if (visiblePassword() && !chatVisible() && !document.querySelector(".bca-overlay") && cooldownOk) {
          try { sessionStorage.setItem("bcaAutoRel", String(Date.now())); } catch { /* private mode */ }
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
