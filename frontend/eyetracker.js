/*
 * Standalone WebGazer capture.
 *
 * Flow: consent -> load WebGazer -> create session -> 9-point calibration ->
 * poll gaze predictions -> batch-POST to the backend. Coordinates are stored in
 * viewport pixels; because the content fills the viewport, they map 1:1 to the
 * page the viewer will reproduce.
 */
(function () {
  "use strict";

  const DATAPOINTS_PER_SECOND = 10;
  const MAX_CACHE_SIZE = 20;
  const CONSENT_KEY = "gazeConsent:v1";
  const PAGE_NAME = "sample-page";

  const browserWidth = window.innerWidth;
  const browserHeight = window.innerHeight;

  // DOM
  const consentBackdrop = document.getElementById("consentBackdrop");
  const acceptBtn = document.getElementById("acceptBtn");
  const declineBtn = document.getElementById("declineBtn");
  const calib = document.getElementById("calib");
  const grid = document.getElementById("grid");
  const hudDot = document.getElementById("hudDot");
  const hudStatus = document.getElementById("hudStatus");
  const hudPoints = document.getElementById("hudPoints");
  const finishBtn = document.getElementById("finishBtn");
  const gazeDot = document.getElementById("gazeDot");

  // State
  let sessionId = null;
  let dataCache = [];
  let pointsStored = 0;
  let calibrationFinish = false;
  let timeBegin = null;
  let logIntervalId = null;
  let started = false;

  const targets = [];
  const CLICKS_PER_TARGET = 5;

  /* ---------------- consent ---------------- */

  function getConsent() {
    try {
      return (JSON.parse(localStorage.getItem(CONSENT_KEY)) || {}).granted === true;
    } catch {
      return false;
    }
  }

  function setConsent(granted) {
    localStorage.setItem(CONSENT_KEY, JSON.stringify({ granted: !!granted, ts: Date.now() }));
  }

  /* ---------------- webgazer loading ---------------- */

  function loadWebGazer() {
    return new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = "https://cdn.jsdelivr.net/npm/webgazer@3.4.0/dist/webgazer.min.js";
      script.onload = () => resolve(window.webgazer);
      script.onerror = () => reject(new Error("Failed to load WebGazer"));
      document.head.appendChild(script);
    });
  }

  /* ---------------- backend calls ---------------- */

  async function createSession() {
    const res = await fetch("/api/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        page_name: PAGE_NAME,
        browser_width: browserWidth,
        browser_height: browserHeight,
      }),
    });
    const json = await res.json();
    sessionId = json.session_id;
  }

  async function flushCache() {
    if (dataCache.length === 0) return;
    const batch = dataCache;
    dataCache = [];
    try {
      await fetch("/api/points", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ points: batch }),
      });
      pointsStored += batch.length;
      hudPoints.textContent = pointsStored + " points";
    } catch (e) {
      console.error("Failed to store points", e);
    }
  }

  /* ---------------- calibration ---------------- */

  function buildCalibrationGrid() {
    grid.innerHTML = "";
    targets.length = 0;

    for (let i = 0; i < 9; i++) {
      const cell = document.createElement("div");
      cell.className = "target";
      const dot = document.createElement("div");
      cell.appendChild(dot);
      cell.dataset.count = "0";

      dot.addEventListener("click", (e) => {
        e.stopPropagation();
        const c = parseInt(cell.dataset.count, 10) + 1;
        cell.dataset.count = String(c);
        dot.style.transform = "scale(1.25)";
        setTimeout(() => (dot.style.transform = "scale(1)"), 100);
        if (c >= CLICKS_PER_TARGET) cell.classList.add("done");
        if (targets.every((t) => parseInt(t.dataset.count, 10) >= CLICKS_PER_TARGET)) {
          finishCalibration();
        }
      });

      grid.appendChild(cell);
      targets.push(cell);
    }
  }

  function finishCalibration() {
    calib.classList.remove("show");
    calibrationFinish = true;
    hudDot.classList.add("recording");
    hudStatus.textContent = "Recording gaze";
    finishBtn.disabled = false;
    gazeDot.classList.add("show");   // reveal the live gaze dot
  }

  // Move the red dot to the latest prediction. Runs at WebGazer's full
  // prediction rate (~30/s) — smoother than the 10/s storage loop — and only
  // after calibration, so it never appears during setup.
  function moveGazeDot(data) {
    if (!calibrationFinish || !data) return;
    gazeDot.style.transform =
      "translate(" + data.x + "px, " + data.y + "px)";
  }

  /* ---------------- gaze logging ---------------- */

  function inBounds(x, y, threshold = 6) {
    return (
      x > threshold &&
      x < browserWidth - threshold &&
      y > threshold &&
      y < browserHeight - threshold
    );
  }

  async function logPoint() {
    if (!calibrationFinish || sessionId == null) return;
    const data = await window.webgazer.getCurrentPrediction();
    if (!data) return;
    if (!inBounds(data.x, data.y)) return;

    if (!timeBegin) timeBegin = Date.now();
    const timeElapsed = (Date.now() - timeBegin) / 1000;

    dataCache.push({
      session_id: sessionId,
      x: parseInt(data.x, 10),
      y: parseInt(data.y, 10),
      timestamp: timeElapsed,
      element: null,
      subsection: null,
    });

    if (dataCache.length >= MAX_CACHE_SIZE) flushCache();
  }

  /* ---------------- start ---------------- */

  async function startFlow() {
    if (started) return;
    started = true;

    hudStatus.textContent = "Loading eye tracker…";
    try {
      await loadWebGazer();
      await createSession();

      window.webgazer
        .showVideo(false)
        .showFaceOverlay(false)
        .showFaceFeedbackBox(false)
        .showPredictionPoints(false)
        .setGazeListener(function (data) { moveGazeDot(data); })
        .begin();

      hudStatus.textContent = "Calibrating…";
      calib.classList.add("show");
      buildCalibrationGrid();

      logIntervalId = window.setInterval(logPoint, 1000 / DATAPOINTS_PER_SECOND);
    } catch (e) {
      console.error(e);
      hudStatus.textContent = "Error starting eye tracker";
    }
  }

  function endWebgazer() {
    if (logIntervalId) clearInterval(logIntervalId);
    try {
      window.webgazer?.pause?.();
      window.webgazer?.clearData?.();
      window.webgazer?.end?.();
    } catch {
      /* ignore */
    }
  }

  /* ---------------- wiring ---------------- */

  finishBtn.addEventListener("click", async () => {
    finishBtn.disabled = true;
    hudStatus.textContent = "Saving…";
    await flushCache();
    endWebgazer();
    window.location.href = "viewer.html?session_id=" + encodeURIComponent(sessionId);
  });

  window.addEventListener("beforeunload", () => {
    // Best-effort flush of remaining points on tab close.
    if (dataCache.length && sessionId != null && navigator.sendBeacon) {
      navigator.sendBeacon(
        "/api/points",
        new Blob([JSON.stringify({ points: dataCache })], { type: "application/json" })
      );
    }
    endWebgazer();
  });

  acceptBtn.addEventListener("click", () => {
    setConsent(true);
    consentBackdrop.classList.remove("show");
    startFlow();
  });

  declineBtn.addEventListener("click", () => {
    setConsent(false);
    consentBackdrop.classList.remove("show");
    hudStatus.textContent = "Consent declined";
  });

  // On load: skip the modal if consent was already granted.
  if (getConsent()) {
    startFlow();
  } else {
    consentBackdrop.classList.add("show");
  }
})();
