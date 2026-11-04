/* Login autopilot — standalone addon for "Our Discussion Room".
   Owner requests (in order):
   1) "লগইন করার পর অনেকক্ষণ বসে থাকে (401)" → the login POST hangs while the
      Render free-tier server wakes (~30–60 s). This addon cannot make the
      sleeping server faster, but it removes the user-facing symptoms.
   2) "লোডিং ঘুরতে থাকবে" → a small spinner overlays the login form from the
      moment the login POST starts until the user is really in. The reload
      keeps it spinning (the page reloads fast from cache), so there is never
      a bare stuck form.
   3) "এই লেখাগুলো বাদ" → completely text-free: a minimal spinner, nothing else.

   How it works (plain HTTP, no websockets — one-surface rule):
   - Every 1.2 s it probes /api/users/me. Logged out → keep waiting (and the
     probe itself helps wake the sleeping server).
   - It watches for a login attempt (a click on a login/submit button, or
     Enter in a password field) → spinner ON immediately (feels instant).
   - The MOMENT the probe returns 200 with a username (401→200 = the login
     landed): spinner keeps spinning and, if the login form is still visible
     after a short beat, it reloads ONCE — the app enters the chat because
     the session cookie is already set. While mustChangePassword or an addon
     modal is up, the spinner stops and it stands down.
*/
(() => {
  "use strict";
  if (window.__bcaLoginAutopilot) return;
  window.__bcaLoginAutopilot = true;
  console.log("[bca] login-autopilot v3 loaded");

  // ---------- spinner (text-free, tiny, self-managed) ----------
  let spin = null;
  function spinShow() {
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
    document.body.appendChild(spin);
  }
  function spinHide() { if (spin) spin.style.display = "none"; }

  // ---------- login-attempt detection (spinner ON instantly) ----------
  let attemptSeen = false;
  function markAttempt() {
    if (attemptSeen) return;
    const pw = document.querySelector('input[type="password"]');
    if (!pw) return; // not on a credentials screen
    attemptSeen = true;
    spinShow();
  }
  document.addEventListener("click", (e) => {
    if (e.target.closest?.('button[type="submit"], input[type="submit"], .btn-primary')) markAttempt();
  }, true);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && e.target.matches?.('input[type="password"], input[name*="user" i]')) markAttempt();
  }, true);

  // ---------- probe loop ----------
  let lastOk = false;
  let probing = false;
  async function probe() {
    if (probing) return;
    probing = true;
    try {
      const res = await fetch("/api/users/me", { credentials: "same-origin" });
      if (!res.ok) { lastOk = false; return; } // still waiting — spinner keeps spinning
      const me = await res.json().catch(() => null);
      if (!me?.username) { lastOk = false; return; }
      if (me.mustChangePassword) { attemptSeen = false; spinHide(); return; }
      if (lastOk) { spinHide(); return; } // steady logged-in
      lastOk = true; // fresh 401→200 = login just landed
      // give the SPA a beat to navigate by itself; if the form is still
      // there, enter for the user (cookie is set — reload lands in chat)
      setTimeout(() => {
        const pwVisible = !!document.querySelector('input[type="password"]');
        const addonModal = !!document.querySelector(".bca-overlay");
        if (pwVisible && !addonModal) location.reload(); // spinner survives the reload
        else { attemptSeen = false; spinHide(); }
      }, 1800);
    } catch { /* transient — next tick retries */ }
    finally { probing = false; }
  }
  setInterval(probe, 1200);
  probe();
})();
