/* Plus-reaction picker upgrade — standalone addon for "Our Discussion Room".
   Owner request #5: the "+" custom-reaction picker gets the FULL emoji
   catalogue used by the app's chat-box tray (1,849 emojis, 8 categories —
   extracted from the bundle into tray-emoji.json next to this file).
   Owner request #4: custom reactions sometimes failed with
   "রিয়েকশন দেওয়া যায়নি — আবার চেষ্টা করুন" on Render. Root causes fixed here:
     a) the addon used its own second socket for reactions; on slow networks
        (Render cold start) that extra handshake often wasn't ready, and
        timeouts showed the error. The picker now drives the APP'S OWN
        quick-reaction buttons (synthetic click), so the app's own socket —
        the exact path that already works — does the sending.
     b) the virtualized list reuses DOM ids; an id read from a stale bubble
        could miss on the server → invalid_error. We only act on bubbles that
        are actually in the DOM right now, and verify the message id matches
        the newest render by re-reading it at click time.
   Owner request (v13, one-surface rule): reactions go through the SAME http
   path as every other addon call (POST /api/chat/react — REST twin of the
   socket event); the UI updates via the APP'S OWN socket broadcast, exactly
   like the default-emoji buttons. NO background addon websocket is opened
   any more; the legacy socket path below exists only as a fallback for very
   old backends without the REST twin, and connects lazily on first use.
   Pre-warmed in the background: the emoji catalogue only (one static JSON).
   This file is standalone and does not edit the minified app or addon.js.

   v20 (owner task 2026-11-07, "২ নং ১ নং-এর একই প্রসেসে, একই সকেটে পাঠাবে"):
   the addon's SECOND socket is GONE entirely. 1 sends on the app's socket
   (same server process, same handler, same broadcast room); 2 now sends on
   the REST twin in that SAME server process — same handleReactMessage, same
   io.emit reactedMessage room — and, like 1's ack, the server's reply is the
   authoritative merged reactions, applied to the DOM immediately (no wait
   for the broadcast frame; 1's socket applies its ack the same way). Failed
   sends hold silently in the v16 queue (2.5 s retry, max 2 min) instead of
   erroring. No socket.io script load, no handshake, no warm loop, no
   /socket.io/socket.io.js dependency — one HTTP POST per click, like 1.
*/
(() => {
  "use strict";
  if (window.__bcaTrayPicker) return;
  window.__bcaTrayPicker = true;
  console.log("[bca] tray-picker v21 loaded"); // visible proof of the running version

  let catalogue = null; // { categories: [{id, emojis:[{n, e}]}] }
  let catalogueLoading = null;

  function loadCatalogue() {
    if (catalogue) return Promise.resolve(catalogue);
    if (catalogueLoading) return catalogueLoading;
    catalogueLoading = fetch("/addons/tray-emoji.json", { credentials: "same-origin" })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (!data || !Array.isArray(data.categories) || !data.emojis) return null;
        const categories = data.categories
          .map((c) => ({
            id: c.id,
            emojis: (c.emojis || [])
              .map((id) => data.emojis[id])
              .filter(Boolean)
              .map((e) => ({ n: e.name || e.id, e: e.skins?.[0]?.native || e.native || "" }))
              .filter((x) => x.e),
          }))
          .filter((c) => c.emojis.length);
        catalogue = { categories };
        return catalogue;
      })
      .catch(() => null)
      .finally(() => {
        // a failed fetch (502 while the Render server wakes) must not stay
        // cached forever — the next call retries
        if (!catalogue) catalogueLoading = null;
      });
    return catalogueLoading;
  }

  const T = {
    en: {
      search: "Search…", noRes: "No emoji matched", recent: "Frequently used", more: "More reactions",
    },
    bn: {
      search: "খুঁজুন…", noRes: "কোনো ইমোজি মেলেনি", recent: "ঘনঘন ব্যবহৃত", more: "আরও রিয়্যাকশন",
    },
  };

  // ---------- click queue (the "1"-parity buffer — v16) ----------
  // The app's own socket client buffers emits while the link is down and
  // flushes them on reconnect — that's why the default-emoji buttons seem
  // to "always apply by themselves" during server sleep. The REST path now
  // mirrors that: a click made while the server is asleep/waking is HELD
  // here and retried until it lands (max 2 min), instead of giving up with
  // an error. SILENT by design (owner request): no chips, no explanations —
  // the reaction just appears when it lands.
  const reactQueue = []; // { id, emoji, username, reactions, firstAt }
  let reactBusy = false;
  const REACT_QUEUE_MAX_MS = 120000;

  function queueReact(item) {
    if (reactQueue.some((q) => q.id === item.id && q.emoji === item.emoji)) return; // already pending
    reactQueue.push(item);
  }

  async function processReactQueue() {
    if (reactBusy || !reactQueue.length) return;
    reactBusy = true;
    const item = reactQueue[0];
    try {
      // fresh payload from the current DOM (covers toggles while pending);
      // captured payload only if the bubble is gone (e.g. deleted message)
      const bubble = document.getElementById("message-" + item.id);
      const reactions = (bubble && document.contains(bubble))
        ? togglePayload(readReactionsFromDom(bubble), item.emoji, item.username)
        : item.reactions;
      if (reactions[item.emoji] && !reactions[item.emoji].usernames.some((u) => u === item.username))
        reactions[item.emoji].usernames.push(item.username);
      item.reactions = reactions;
      // v20: REST only — the same server-side handler + broadcast room as the
      // app's own socket path ("1"). There is no addon socket any more.
      const ctrl = new AbortController();
      const abortT = setTimeout(() => ctrl.abort(), 5000);
      const res = await fetch("/api/chat/react", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: item.id, reactions }),
        signal: ctrl.signal,
      });
      clearTimeout(abortT);
      if (!res.ok) {
        if (res.status === 401) throw { drop: true }; // logged out — drop silently
        throw { retryable: true };
      }
      const merged = await res.json().catch(() => null);
      if (merged && merged.reactions) {} // v21: React paints via broadcast — no hand-paint
      reactQueue.shift();
    } catch (err) {
      const expired = Date.now() - item.firstAt > REACT_QUEUE_MAX_MS;
      if (err?.drop) {
        reactQueue.shift(); // logged out — silent
      } else if (!(err?.retryable && !expired)) {
        reactQueue.shift(); // truly failed after the hold window — silent
      }
      // retryable & not expired → stay queued; nothing is shown
    } finally {
      reactBusy = false;
    }
  }
  setInterval(processReactQueue, 2500);
  const curLang = () => (localStorage.getItem("langPref") === "en" ? "en" : "bn");

  // ---------- drive the app's own quick-reaction chips ----------
  function quickChipFor(bubble, emoji) {
    // only a chip that ALREADY shows this exact emoji may be clicked —
    // clicking a different emoji's chip would toggle THAT emoji instead
    const chips = [...bubble.querySelectorAll(".reaction-emoji")];
    return chips.find((chip) => (chip.textContent || "").trim().startsWith(emoji)) || null;
  }

  function appReactionClick(bubble, emoji) {
    if (!bubble || !document.contains(bubble)) return false;
    // the app's own quick-reaction row (only ~6 fixed emojis — a custom
    // emoji will never match, which is correct) or an existing chip that
    // already shows this exact emoji; anything else → let the socket path run
    const rowBtns = [...bubble.querySelectorAll("button, .quick-reaction, .reaction-option")]
      .map((el) => ({ el, text: (el.textContent || "").trim() }))
      .filter((x) => x.text === emoji);
    if (rowBtns[0]?.el) { rowBtns[0].el.click(); return true; }
    const chip = quickChipFor(bubble, emoji);
    if (chip) {
      const inner = chip.querySelector("div[onclick], div");
      (inner || chip).click();
      return true;
    }
    return false;
  }

  // ---------- v21: instant visibility WITHOUT double painting ----------
  // v20 painted the ack payload into the DOM by hand. But this server
  // broadcasts reactedMessage to the SENDER too (io.emit, sender included),
  // so React re-rendered the same reaction from its own state a moment
  // later — and a hand-appended node is invisible to React's reconciliation,
  // so BOTH stayed: the reaction showed twice until a reload (owner report).
  // 1 never paints by hand either — its ack updates app state and React
  // renders it. v21 does the same: the ONLY real painter is React via the
  // broadcast. For instant feedback a marked temporary chip is shown, and a
  // MutationObserver removes it the moment React's own chip for the same
  // emoji appears (before paint, so no double is ever visible); a stale
  // sweep covers the case where the broadcast never arrives.
  const mineWatch = new MutationObserver((muts) => {
    for (const m of muts) {
      const wrap = m.target;
      wrap.querySelectorAll(".reaction-emoji[data-bca-mine]").forEach((tmp) => {
        const first = tmp.querySelector("div > div");
        const mm = first && (first.textContent || "").match(/^([\s\S]+?)\s+\d+$/);
        const emoji = mm ? mm[1] : null;
        if (!emoji) return;
        const real = [...wrap.querySelectorAll(".reaction-emoji")].find((c) => {
          if (c === tmp || c.dataset.bcaMine) return false;
          const f = c.querySelector("div > div");
          const t = f ? f.textContent || "" : "";
          return t === emoji || t.startsWith(emoji + " ");
        });
        if (real) tmp.remove(); // React painted the real one — ours steps aside
      });
    }
  });
  const watchedWraps = new WeakSet();
  function ensureWatched(wrap) {
    if (watchedWraps.has(wrap)) return;
    watchedWraps.add(wrap);
    mineWatch.observe(wrap, { childList: true });
  }
  function markChipAsOurs(bubble, emoji) {
    const wrap = bubble.querySelector(".reactions");
    if (!wrap) return;
    ensureWatched(wrap);
    // if a real chip for this emoji already exists, nothing to preview
    for (const chip of wrap.querySelectorAll(".reaction-emoji")) {
      const first = chip.querySelector("div > div");
      const m = first && (first.textContent || "").match(/^([\s\S]+?)\s+(\d+)$/);
      if (m && m[1] === emoji && !chip.dataset.bcaMine) return;
    }
    const chip = document.createElement("div");
    chip.className = "reaction-emoji";
    chip.dataset.bcaMine = "1";
    chip.__bcaMineAt = Date.now();
    const outer = document.createElement("div");
    const inner = document.createElement("div");
    inner.textContent = emoji + " 1";
    inner.addEventListener("click", () => { chip.remove(); window.__bcaRestReact?.(bubble, emoji); });
    const list = document.createElement("div");
    list.className = "reaction-username-list";
    outer.appendChild(inner);
    chip.appendChild(outer);
    chip.appendChild(list);
    wrap.appendChild(chip);
  }
  setInterval(() => {
    // a marked chip older than 6 s means the broadcast never replaced it
    // (message scrolled away / queue still pending) — drop the preview
    document.querySelectorAll(".reaction-emoji[data-bca-mine]").forEach((chip) => {
      if (!chip.__bcaMineAt) chip.__bcaMineAt = Date.now();
      else if (Date.now() - chip.__bcaMineAt > 6000) chip.remove();
    });
  }, 2000);
  function readReactionsFromDom(bubble) {
    const reactions = {};
    bubble.querySelectorAll(".reaction-emoji").forEach((chip) => {
      const first = chip.querySelector("div > div");
      if (!first) return;
      const text = first.textContent || "";
      const m = text.match(/^([\s\S]+?)\s+(\d+)$/);
      if (!m) return;
      const userNames = [...chip.querySelectorAll(".reaction-username")].map((p) => p.textContent.trim());
      reactions[m[1]] = { usernames: userNames };
    });
    return reactions;
  }
  function togglePayload(msgReactions, emoji, username) {
    const reactions = {};
    for (const key of Object.keys(msgReactions || {})) {
      reactions[key] = { usernames: [...(msgReactions[key]?.usernames || [])] };
    }
    const list = reactions[emoji]?.usernames || [];
    reactions[emoji] = { usernames: list.includes(username) ? list.filter((u) => u !== username) : [...list, username] };
    return reactions;
  }
  let meUser = null;
  async function fetchMeOnce() {
    // session from the shared hub (window.__bcaSession) — no extra HTTP call
    if (meUser) return meUser;
    const sess = window.__bcaSession;
    if (sess?.loggedIn && sess.me) meUser = sess.me;
    return meUser;
  }
  // expose the REST-reaction helper for other addons — the addon layer's
  // single shared surface (no per-addon sockets anywhere; owner request)
  window.__bcaRestReact = socketReact;

  async function socketReact(bubble, emoji) {
    if (!bubble || !document.contains(bubble)) return false;
    const me = await fetchMeOnce();
    if (!me?.username) return false;
    const id = parseInt(String(bubble.id || "").replace("message-", ""), 10);
    if (!Number.isFinite(id)) return false;
    const reactions = togglePayload(readReactionsFromDom(bubble), emoji, me.username);
    // ensure the target emoji's entry exists with MY username toggled —
    // for a brand-new custom emoji readReactionsFromDom knows nothing, so
    // the toggle must add the user explicitly
    if (!reactions[emoji] || !Array.isArray(reactions[emoji].usernames))
      reactions[emoji] = { usernames: [] };
    if (!reactions[emoji].usernames.some((u) => u === me.username))
      reactions[emoji].usernames.push(me.username);
    // PRIMARY + ONLY PATH (v20/v21, owner task "same socket as 1"): POST
    // /api/chat/react — the REST twin INSIDE the app's own server process.
    // Same handleReactMessage as the socket event; the reactedMessage
    // broadcast (sender included) makes React paint the real chip. v21:
    // while the POST is in flight, a marked preview chip gives the instant
    // feedback — it steps aside the moment React's own chip appears.
    markChipAsOurs(bubble, emoji);
    try {
      const ctrl = new AbortController();
      const abortT = setTimeout(() => ctrl.abort(), 4000);
      const res = await fetch("/api/chat/react", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, reactions }),
        signal: ctrl.signal,
      });
      clearTimeout(abortT);
      if (res.ok) {
        // v21: NO hand-paint. The server broadcasts reactedMessage to the
        // sender too; React renders from its own state — same as 1's ack
        // path. Our preview chip (markChipAsOurs) covers the visual gap
        // until the broadcast lands, then steps aside automatically.
        return true;
      }
      if (res.status === 401) return false; // logged out — nothing to hold
      console.warn("[bca] reaction REST rejected:", res.status);
      return false;
    } catch (err) {
      // unreachable = server asleep/waking — silent buffer (v16), never an error
      console.warn("[bca] reaction REST unreachable — queued:", err?.message || err);
      queueReact({ id, emoji, username: me.username, reactions, firstAt: Date.now() });
      return true;
    }
  }

  // ---------- the picker UI ----------
  let pop = null;
  let currentBubble = null;

  function closePop() {
    if (pop) { pop.remove(); pop = null; currentBubble = null; }
    document.removeEventListener("mousedown", outside, true);
    document.removeEventListener("keydown", esc, true);
  }
  function outside(e) {
    if (pop && !pop.contains(e.target) && !e.target.closest?.(".bca-react-plus")) closePop();
  }
  function esc(e) { if (e.key === "Escape") closePop(); }

  function renderGrid(q) {
    if (!pop || !catalogue) return;
    const grid = pop.querySelector(".bca-tgrid");
    const catsBar = pop.querySelector(".bca-tcats");
    const lang = T[curLang()];
    grid.textContent = "";
    if (!q) {
      const recent = [...(JSON.parse(localStorage.getItem("bcaRecentEmoji") || "[]"))].slice(0, 24);
      if (recent.length) {
        const head = document.createElement("div");
        head.className = "bca-tcat-head";
        head.textContent = lang.recent;
        grid.appendChild(head);
        for (const e of recent) {
          const b = document.createElement("button");
          b.type = "button";
          b.className = "bca-temoji";
          b.textContent = e;
          b.addEventListener("click", () => pick(e));
          grid.appendChild(b);
        }
      }
    }
    const scan = catalogue.categories;
    let shown = 0;
    for (const cat of scan) {
      const items = q
        ? cat.emojis.filter((x) => x.n.toLowerCase().includes(q) || x.e === q)
        : cat.emojis;
      if (!items.length) continue;
      const head = document.createElement("div");
      head.className = "bca-tcat-head";
      head.textContent = cat.id;
      grid.appendChild(head);
      for (const { n, e } of items) {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "bca-temoji";
        b.textContent = e;
        b.title = n;
        b.addEventListener("click", () => pick(e));
        grid.appendChild(b);
        shown++;
      }
    }
    if (!shown) {
      const none = document.createElement("div");
      none.className = "bca-tnone";
      none.textContent = lang.noRes;
      grid.appendChild(none);
    }
    // category chips (jump links)
    catsBar.textContent = "";
    for (const cat of scan) {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "bca-tcat";
      chip.textContent = cat.id;
      chip.addEventListener("click", () => {
        const heads = [...grid.querySelectorAll(".bca-tcat-head")];
        const target = heads.find((h) => h.textContent === cat.id);
        target?.scrollIntoView({ block: "start" });
      });
      catsBar.appendChild(chip);
    }
  }

  async function pick(emoji) {
    // capture the bubble BEFORE closePop() — closePop nulls currentBubble,
    // and the bubble element must survive the popup closing (owner-reported
    // TypeError: bubble is null)
    const bubble = currentBubble;
    if (!bubble) { closePop(); return; }
    if (!document.contains(bubble)) { closePop(); return; } // stale render
    // remember recents
    try {
      const rec = JSON.parse(localStorage.getItem("bcaRecentEmoji") || "[]");
      const next = [emoji, ...rec.filter((x) => x !== emoji)].slice(0, 24);
      localStorage.setItem("bcaRecentEmoji", JSON.stringify(next));
    } catch { /* ignore */ }
    closePop();
    // v20: same-send-path rule (owner task) — the app's quick-reaction row
    // clicks go through the app's own socket (that IS "1"); everything else
    // goes through the REST twin inside the SAME server process/socket room,
    // with the ack-style reply applied to the DOM instantly.
    if (appReactionClick(bubble, emoji)) return;
    const ok = await socketReact(bubble, emoji);
    if (!ok) {
      console.warn("[bca] reaction not sent — emoji:", emoji, "bubble id:", bubble.id);
    }
  }

  function openPop(anchor, bubble) {
    closePop();
    currentBubble = bubble;
    pop = document.createElement("div");
    pop.className = "bca-tpop";
    pop.innerHTML = `
      <input type="text" class="bca-tsearch" />
      <div class="bca-tcats"></div>
      <div class="bca-tgrid"></div>`;
    document.body.appendChild(pop);
    const search = pop.querySelector(".bca-tsearch");
    search.placeholder = T[curLang()].search;
    search.addEventListener("input", () => renderGrid(search.value.trim().toLowerCase()));
    renderGrid("");
    const r = anchor.getBoundingClientRect();
    const w = Math.min(340, innerWidth - 16);
    pop.style.width = w + "px";
    pop.style.left = Math.max(8, Math.min(r.left, innerWidth - w - 8)) + "px";
    const below = r.bottom + 8 + pop.offsetHeight < innerHeight;
    pop.style.top = (below ? r.bottom + 8 : Math.max(8, r.top - pop.offsetHeight - 8)) + "px";
    t0Focus();
    function t0Focus() { setTimeout(() => search.focus(), 30); }
    setTimeout(() => {
      document.addEventListener("mousedown", outside, true);
      document.addEventListener("keydown", esc, true);
    }, 0);
  }

  // ---------- the "+" button: tray-picker is the SOLE owner ----------
  // It both CREATES the button (far right of the app's quick-reaction row in
  // the message context-menu) and HOOKS it. The main addon's creation is
  // disabled (v12) — without this the picker would have no door (the v12
  // regression: custom emojis seemed "off" entirely).
  function ensurePlusButtons() {
    if (pop) return; // picker already open
    document.querySelectorAll(".dropdown-menu.context-menu.show").forEach((menu) => {
      if (menu.querySelector(".bca-react-plus")) return;
      const msgRoot = menu.closest('[id^="message-"]');
      if (!msgRoot || !document.contains(msgRoot)) return;
      for (const row of menu.querySelectorAll(".dropdown-item, .menu-button")) {
        const emojiBtns = [...row.querySelectorAll(".btn")].filter(
          (b) => (b.textContent || "").trim().length <= 4
        );
        if (emojiBtns.length < 6) continue; // that's the reactions row, not others
        const plus = document.createElement("button");
        plus.type = "button";
        plus.className = "btn btn-outline-secondary btn-sm icon-button bca-react-plus";
        plus.textContent = "＋";
        plus.title = T[curLang()].more;
        plus.setAttribute("aria-label", T[curLang()].more);
        row.appendChild(plus); // far right of the emoji row
        break;
      }
    });
  }

  // ---------- hook the "+" buttons ----------
  function wire() {
    ensurePlusButtons();
    document.querySelectorAll(".bca-react-plus").forEach((btn) => {
      if (btn.__bcaWired) return;
      btn.__bcaWired = true;
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const bubble = btn.closest('div[id^="message-"]');
        if (!bubble || !document.contains(bubble)) return;
        if (pop) { closePop(); return; }
        loadCatalogue().then((cat) => {
          if (!cat) return;
          openPop(btn, bubble);
        });
      }, true);
    });
  }

  const mo = new MutationObserver(() => wire());
  mo.observe(document.documentElement, { childList: true, subtree: true });
  wire();

  // ---------- login watcher + catalogue warm (v20) ----------
  // v20 removed the addon socket — nothing to keep warm any more. The hub
  // (window.__bcaSession) still gates the emoji-catalogue pre-fetch: one
  // static JSON, retried ~every 10 s while it is missing, zero after that.
  // Reactions themselves are a single POST per click (like 1) — no
  // handshake, no reconnection, no warm loop, no /socket.io dependency.
  let catalogueTriedAt = 0;
  // session hub subscriber — no own poll (owner request: এক কল, সবাই শোনে)
  function onSessionChange(loggedIn) {
    if (loggedIn && !catalogue && Date.now() - catalogueTriedAt >= 10000) {
      catalogueTriedAt = Date.now();
      loadCatalogue();
    }
  }
  let hubState = undefined;
  setInterval(() => {
    const sess = window.__bcaSession;
    if (!sess || sess.at === undefined) return;
    const st = sess.loggedIn;
    if (hubState !== st) { hubState = st; onSessionChange(st); }
    if (st && !catalogue && Date.now() - catalogueTriedAt >= 10000) {
      catalogueTriedAt = Date.now();
      loadCatalogue();
    }
  }, 1500);
})();
