/* ==========================================================================
   Valkyrie web flasher - behavior
   - sprite frame-cyclers (separate PNG frames, swapped on an <img>)
   - interactive watch-state demo (intro frames once, then loop)
   - fade-in on scroll, version badge from manifest.json
   All flashing is handled by the ESP Web Tools dialog; this file is cosmetic.
   ========================================================================== */

const reduceMotion = window.matchMedia(
  "(prefers-reduced-motion: reduce)"
).matches;

/** Build a frame path list: seq("animations/sleeping", "startSleep", 5). */
function seq(folder, base, count) {
  const out = [];
  for (let i = 1; i <= count; i++) out.push(`${folder}/${base}${i}.png`);
  return out;
}

/* --------------------------------------------------------------------------
   Generic sprite cycler for feature-card icons (data-frames / data-fps)
   Only runs while the element is on screen, and never when reduced motion.
   -------------------------------------------------------------------------- */

function initSpriteCyclers() {
  const sprites = document.querySelectorAll(".js-sprite");
  if (!sprites.length) return;

  const timers = new WeakMap();

  const start = (img) => {
    if (reduceMotion || timers.has(img)) return;
    const frames = (img.dataset.frames || "").split(",").filter(Boolean);
    if (frames.length < 2) return;
    const fps = Number(img.dataset.fps) || 6;
    frames.forEach((src) => {
      const pre = new Image();
      pre.src = src;
    });
    let i = 0;
    const id = setInterval(() => {
      i = (i + 1) % frames.length;
      img.src = frames[i];
    }, 1000 / fps);
    timers.set(img, id);
  };

  const stop = (img) => {
    const id = timers.get(img);
    if (id) {
      clearInterval(id);
      timers.delete(img);
    }
  };

  if (reduceMotion || !("IntersectionObserver" in window)) return;

  const io = new IntersectionObserver(
    (entries) => {
      entries.forEach((e) => (e.isIntersecting ? start(e.target) : stop(e.target)));
    },
    { rootMargin: "80px" }
  );
  sprites.forEach((img) => io.observe(img));
}

/* --------------------------------------------------------------------------
   Interactive watch demo
   -------------------------------------------------------------------------- */

const WATCH_STATES = {
  ble: {
    title: "Valkyrie",
    intro: seq("animations/bleScanning", "startBleScan", 5),
    loop: seq("animations/bleScanning", "scanBleLoop", 3),
    fps: 6,
    status: 'Status: <span class="accent">Scanning BLE</span>',
    hint: "Detection: On · threat goblin active",
    caption: {
      h: "BLE threat scan",
      p: "The watch sniffs nearby BLE gadgets and calls out trackers, skimmers and other suspicious little gremlins.",
    },
  },
  wifi: {
    title: "Valkyrie",
    intro: seq("animations/wifiScanning", "startWifiScan", 5),
    loop: seq("animations/wifiScanning", "scanWifiLoop", 3),
    fps: 6,
    status: 'Status: <span class="accent">Scanning Wi-Fi</span>',
    hint: "Channels 1 / 6 / 11",
    caption: {
      h: "Wi-Fi threat pass",
      p: "Wi-Fi hops the busy channels and looks for spicy traffic like deauth, rogue APs and drone fingerprints.",
    },
  },
  heartbeat: {
    title: "Heartbeat",
    intro: seq("animations/heartbeat", "startHeartbeatScan", 5),
    loop: seq("animations/heartbeat", "heartbeatLoop", 6),
    fps: 7,
    status: 'RSSI: <span class="accent">-88 dBm</span> · Weak',
    hint: "Tap screen to stop",
    caption: {
      h: "Heartbeat tracking",
      p: "Pick a threat and follow the signal like a side quest until you find the thing making noise.",
    },
  },
  wardrive: {
    title: "Wardrive",
    intro: seq("animations/wardriving", "startWardrive", 5),
    loop: seq("animations/wardriving", "wardriveLoop", 3),
    fps: 6,
    status: 'Networks logged: <span class="accent">231</span>',
    hint: "Writing Wigle CSV · GPS: Phone",
    caption: {
      h: "Wardrive mode",
      p: "Cruise around, log Wi-Fi networks with location data and cash out XP when the run is done.",
    },
  },
  sleeping: {
    title: "Valkyrie",
    intro: seq("animations/sleeping", "startSleep", 5),
    loop: seq("animations/sleeping", "startSleepLoop", 3),
    fps: 5,
    status: "Status: Sleeping",
    hint: "Resting between scans",
    caption: {
      h: "Power-aware idle",
      p: "Between scan windows the watch chills out, saves battery and waits for the next round.",
    },
  },
};

const STATE_ORDER = ["ble", "wifi", "heartbeat", "wardrive", "sleeping"];
const AUTO_ADVANCE_MS = 6500;

function initWatchDemo() {
  const root = document.querySelector("[data-watch-demo]");
  if (!root) return;

  const spriteEl = root.querySelector("[data-watch-sprite]");
  const titleEl = root.querySelector("[data-watch-title]");
  const statusEl = root.querySelector("[data-watch-status]");
  const hintEl = root.querySelector("[data-watch-hint]");
  const capH = root.querySelector("[data-watch-caption] h3");
  const capP = root.querySelector("[data-watch-caption] p");
  const chips = Array.from(root.querySelectorAll(".chip"));

  let current = "ble";
  let frames = [];
  let loopStart = 0;
  let frameIndex = 0;
  let frameTimer = null;
  let autoTimer = null;

  const stopFrames = () => {
    if (frameTimer) {
      clearInterval(frameTimer);
      frameTimer = null;
    }
  };

  const playFrames = (state) => {
    stopFrames();
    const cfg = WATCH_STATES[state];
    frames = cfg.intro.concat(cfg.loop);
    loopStart = cfg.intro.length;
    frameIndex = 0;
    frames.forEach((src) => {
      const pre = new Image();
      pre.src = src;
    });

    if (reduceMotion) {
      spriteEl.src = cfg.loop[0];
      return;
    }
    spriteEl.src = frames[0];
    frameTimer = setInterval(() => {
      frameIndex = frameIndex + 1 >= frames.length ? loopStart : frameIndex + 1;
      spriteEl.src = frames[frameIndex];
    }, 1000 / cfg.fps);
  };

  const setState = (state, fromUser) => {
    if (!WATCH_STATES[state]) return;
    current = state;
    const cfg = WATCH_STATES[state];

    titleEl.textContent = cfg.title;
    statusEl.innerHTML = cfg.status;
    hintEl.textContent = cfg.hint;
    capH.textContent = cfg.caption.h;
    capP.textContent = cfg.caption.p;

    chips.forEach((c) =>
      c.setAttribute("aria-pressed", String(c.dataset.state === state))
    );

    playFrames(state);
    if (fromUser) restartAuto();
  };

  const advance = () => {
    const next = STATE_ORDER[(STATE_ORDER.indexOf(current) + 1) % STATE_ORDER.length];
    setState(next, false);
  };

  const restartAuto = () => {
    if (autoTimer) clearInterval(autoTimer);
    if (reduceMotion) return;
    autoTimer = setInterval(advance, AUTO_ADVANCE_MS);
  };

  chips.forEach((chip) => {
    chip.addEventListener("click", () => setState(chip.dataset.state, true));
  });

  // pause rotation while the user is hovering / focused on the demo
  root.addEventListener("pointerenter", () => autoTimer && clearInterval(autoTimer));
  root.addEventListener("pointerleave", restartAuto);
  root.addEventListener("focusin", () => autoTimer && clearInterval(autoTimer));
  root.addEventListener("focusout", restartAuto);

  setState("ble", false);
  restartAuto();
}

/* --------------------------------------------------------------------------
   Fade-in on scroll
   -------------------------------------------------------------------------- */

function initFadeIn() {
  const items = document.querySelectorAll(".fade-in");
  if (!items.length) return;

  if (reduceMotion || !("IntersectionObserver" in window)) {
    items.forEach((el) => el.classList.add("is-visible"));
    return;
  }

  const io = new IntersectionObserver(
    (entries, obs) => {
      entries.forEach((e) => {
        if (e.isIntersecting) {
          e.target.classList.add("is-visible");
          obs.unobserve(e.target);
        }
      });
    },
    { rootMargin: "0px 0px -8% 0px" }
  );
  items.forEach((el) => io.observe(el));

  // Safety net: if the observer never fires (edge cases), reveal everything.
  setTimeout(() => {
    items.forEach((el) => el.classList.add("is-visible"));
  }, 2500);
}

/* --------------------------------------------------------------------------
   Version badge + watch clock from manifest.json / current time
   -------------------------------------------------------------------------- */

async function initVersion() {
  try {
    const res = await fetch("manifest.json", { cache: "no-cache" });
    if (!res.ok) return;
    const data = await res.json();
    const v = data.version ? `v${data.version}` : "";
    const name = data.name || "Valkyrie";

    const badge = document.querySelector("[data-version]");
    if (badge && v) badge.textContent = v;

    const full = document.querySelector("[data-version-full]");
    if (full) full.textContent = [name, v].filter(Boolean).join(" ");
  } catch (_) {
    /* offline / file:// - leave defaults */
  }
}

function initClock() {
  const el = document.querySelector("[data-watch-clock]");
  if (!el) return;
  const now = new Date();
  let h = now.getHours();
  const ap = h >= 12 ? "p" : "a";
  h = h % 12 || 12;
  const m = String(now.getMinutes()).padStart(2, "0");
  el.textContent = `${h}:${m}${ap}`;
}

/* --------------------------------------------------------------------------
   Boot
   -------------------------------------------------------------------------- */

function boot() {
  initSpriteCyclers();
  initWatchDemo();
  initFadeIn();
  initVersion();
  initClock();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", boot);
} else {
  boot();
}
