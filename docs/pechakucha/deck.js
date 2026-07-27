/* ============================================================
   Buscemi Centrality · PechaKucha deck engine
   No dependencies. Everything in one file, on purpose.
   ============================================================ */
(() => {
  "use strict";

  const SECONDS_PER_SLIDE = 20;       // PechaKucha law
  const slides = Array.from(document.querySelectorAll(".slide"));
  const stage = document.getElementById("stage");
  const macwindow = document.getElementById("macwindow");
  const counter = document.getElementById("counter");
  const clock = document.getElementById("clock");
  const countdown = document.getElementById("countdown");
  const pkButton = document.getElementById("pk-toggle");
  const helpPanel = document.getElementById("help");

  let index = 0;
  let pkRunning = false;
  let pkSlideStart = 0;      // ms timestamp when current slide began (PK mode)
  let pkTotalStart = 0;      // ms timestamp when PK mode began
  let rafId = null;

  /* ---------- scaling: fit the window (title bar included) to the screen ---------- */
  function fit() {
    const pad = 28;
    const chromeH = 30 + 46; // title bar above the stage, controls below the window
    const scale = Math.min(
      (window.innerWidth - pad) / 1280,
      (window.innerHeight - pad - chromeH) / 720
    );
    macwindow.style.transform = `scale(${scale})`;
  }
  window.addEventListener("resize", fit);
  fit();

  /* ---------- navigation ---------- */
  function show(i) {
    index = Math.max(0, Math.min(slides.length - 1, i));
    slides.forEach((s, k) => s.classList.toggle("current", k === index));
    counter.textContent = `${index + 1} / ${slides.length}`;
    // Chrome forbids history.replaceState on file:// pages; fall back gracefully
    try {
      history.replaceState(null, "", `#${index + 1}`);
    } catch {
      try { location.replace(`#${index + 1}`); } catch { /* so be it */ }
    }
    restartGifs(slides[index]);
    index === slides.length - 1 ? startConfetti() : stopConfetti();
    if (pkRunning) pkSlideStart = performance.now();
  }

  /* GIFs animate from the moment the page loads, even on hidden slides.
     Resetting src with a cache-busting query forces playback from frame one
     each time the slide is shown. */
  function restartGifs(slide) {
    slide.querySelectorAll("img").forEach((img) => {
      const base = img.dataset.gifSrc || (img.getAttribute("src") || "").split("?")[0];
      if (!base.toLowerCase().endsWith(".gif")) return;
      img.dataset.gifSrc = base;
      img.src = `${base}?restart=${Date.now()}`;
    });
  }

  /* ---------- confetti, for the final slide only ---------- */
  const confettiCanvas = document.getElementById("confetti");
  const confettiCtx = confettiCanvas ? confettiCanvas.getContext("2d") : null;
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  let confettiRaf = null;
  let confettiBits = [];
  let confettiCols = [];
  let confettiStart = 0;
  const CONFETTI_SECONDS = 4; // how long new pieces keep coming

  function confettiColours() {
    const s = getComputedStyle(document.documentElement);
    const fromVars = ["--pink", "--gold", "--teal"]
      .map((v) => s.getPropertyValue(v).trim())
      .filter(Boolean);
    return fromVars.concat("#000");
  }

  function confettiSpawn(fromTop) {
    return {
      x: Math.random() * 1280,
      y: fromTop ? -20 : Math.random() * -720, // stagger the opening volley
      w: 6 + Math.random() * 9,
      h: 4 + Math.random() * 7,
      vx: -0.6 + Math.random() * 1.2,
      vy: 1.4 + Math.random() * 2.4,
      rot: Math.random() * Math.PI,
      vr: -0.09 + Math.random() * 0.18,
      colour: confettiCols[(Math.random() * confettiCols.length) | 0],
    };
  }

  function startConfetti() {
    if (!confettiCtx || reducedMotion || confettiRaf) return;
    confettiCols = confettiColours();
    confettiBits = Array.from({ length: 140 }, () => confettiSpawn(false));
    confettiStart = performance.now();
    confettiTick();
  }

  function stopConfetti() {
    if (!confettiCtx) return;
    if (confettiRaf) cancelAnimationFrame(confettiRaf);
    confettiRaf = null;
    confettiCtx.clearRect(0, 0, 1280, 720);
  }

  function confettiTick() {
    confettiCtx.clearRect(0, 0, 1280, 720);
    const stillSpawning = (performance.now() - confettiStart) / 1000 < CONFETTI_SECONDS;
    confettiBits = confettiBits.filter((p) => {
      p.x += p.vx + Math.sin(p.y / 45) * 0.5; // a little flutter
      p.y += p.vy;
      p.rot += p.vr;
      if (p.y > 740 || p.x < -30 || p.x > 1310) {
        if (!stillSpawning) return false; // fallen and gone; the party winds down
        Object.assign(p, confettiSpawn(true));
      }
      confettiCtx.save();
      confettiCtx.translate(p.x, p.y);
      confettiCtx.rotate(p.rot);
      confettiCtx.fillStyle = p.colour;
      confettiCtx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
      confettiCtx.restore();
      return true;
    });
    if (confettiBits.length === 0) {
      stopConfetti();
      return;
    }
    confettiRaf = requestAnimationFrame(confettiTick);
  }
  const next = () => show(index + 1);
  const prev = () => show(index - 1);

  /* ---------- PechaKucha mode ---------- */
  function pkToggle() {
    pkRunning ? pkStop() : pkStart();
  }

  function pkStart() {
    pkRunning = true;
    pkButton.classList.add("active");
    pkButton.textContent = "Stop \u25A0";
    countdown.classList.add("running");
    pkSlideStart = performance.now();
    pkTotalStart = performance.now();
    tick();
  }

  function pkStop() {
    pkRunning = false;
    pkButton.classList.remove("active");
    pkButton.textContent = "PechaKucha \u25B6";
    countdown.classList.remove("running", "ending");
    countdown.textContent = "";
    clock.textContent = "";
    if (rafId) cancelAnimationFrame(rafId);
  }

  function tick() {
    if (!pkRunning) return;
    const now = performance.now();
    const slideElapsed = (now - pkSlideStart) / 1000;
    const totalElapsed = (now - pkTotalStart) / 1000;

    const remaining = Math.max(0, SECONDS_PER_SLIDE - slideElapsed);
    countdown.textContent = `${remaining.toFixed(3)} s`;
    countdown.classList.toggle("ending", remaining < 3);

    const mm = String(Math.floor(totalElapsed / 60)).padStart(1, "0");
    const ss = String(Math.floor(totalElapsed % 60)).padStart(2, "0");
    clock.textContent = `${mm}:${ss} / 6:40`;
    clock.classList.toggle("overtime", totalElapsed > slides.length * SECONDS_PER_SLIDE);

    if (slideElapsed >= SECONDS_PER_SLIDE) {
      if (index < slides.length - 1) {
        next(); // show() resets pkSlideStart
      } else {
        pkStop(); // final slide has had its twenty seconds; the ordeal is over
        return;
      }
    }
    rafId = requestAnimationFrame(tick);
  }

  /* ---------- keyboard ---------- */
  document.addEventListener("keydown", (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    switch (e.key) {
      case "ArrowRight":
      case "PageDown":
      case " ":
        e.preventDefault(); next(); break;
      case "ArrowLeft":
      case "PageUp":
        e.preventDefault(); prev(); break;
      case "Home": show(0); break;
      case "End": show(slides.length - 1); break;
      case "p": case "P": pkToggle(); break;
      case "f": case "F":
        document.fullscreenElement
          ? document.exitFullscreen()
          : document.documentElement.requestFullscreen();
        break;
      case "?": helpPanel.classList.toggle("open"); break;
      case "Escape": helpPanel.classList.remove("open"); break;
    }
  });

  /* ---------- click zones: left third back, right two-thirds forward ---------- */
  stage.addEventListener("click", (e) => {
    if (e.target.closest("a")) return; // links are links
    const rect = stage.getBoundingClientRect();
    (e.clientX - rect.left) / rect.width < 0.33 ? prev() : next();
  });

  /* ---------- HUD buttons ---------- */
  pkButton.addEventListener("click", (e) => { e.stopPropagation(); pkToggle(); });
  document.getElementById("help-toggle").addEventListener("click", (e) => {
    e.stopPropagation(); helpPanel.classList.toggle("open");
  });
  helpPanel.addEventListener("click", () => helpPanel.classList.remove("open"));

  /* ---------- start on the slide named in the URL hash, if any ---------- */
  const fromHash = parseInt(location.hash.slice(1), 10);
  show(Number.isFinite(fromHash) ? fromHash - 1 : 0);
})();
