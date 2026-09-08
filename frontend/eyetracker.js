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
  const validate = document.getElementById("validate");
  const validateHint = document.getElementById("validateHint");
  const validateDot = document.getElementById("validateDot");
  const validateResult = document.getElementById("validateResult");
  const validateScore = document.getElementById("validateScore");
  const recalibrateBtn = document.getElementById("recalibrateBtn");
  const startRecordingBtn = document.getElementById("startRecordingBtn");

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

  // Validation: sample the prediction while the user stares at a central dot,
  // then report mean error so a bad calibration is caught before recording.
  const VALIDATION_MS = 2500;          // total sampling window
  const VALIDATION_WARMUP_MS = 600;    // ignore the first moments (eye settling)
  const VALIDATION_INTERVAL_MS = 50;   // ~20 samples/s
  // Error thresholds as a fraction of the viewport diagonal.
  const GOOD_FRAC = 0.06;
  const FAIR_FRAC = 0.12;

  // 9 calibration positions as viewport percentages. Corners/edges sit close to
  // the borders (with a small margin) so WebGazer trains where it's weakest.
  const CALIB_POSITIONS = [
    [6, 8],  [50, 8],  [94, 8],
    [6, 50], [50, 50], [94, 50],
    [6, 92], [50, 92], [94, 92],
  ];

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

    for (let i = 0; i < CALIB_POSITIONS.length; i++) {
      const [xPct, yPct] = CALIB_POSITIONS[i];
      const cell = document.createElement("div");
      cell.className = "target";
      cell.style.left = xPct + "%";
      cell.style.top = yPct + "%";
      const dot = document.createElement("div");
      cell.appendChild(dot);
      cell.dataset.count = "0";

      dot.addEventListener("click", (e) => {
        e.stopPropagation();
        // Train WebGazer on the dot's true screen position (not the raw cursor
        // point), so every click is a clean calibration sample.
        const rect = dot.getBoundingClientRect();
        const cx = rect.left + rect.width / 2;
        const cy = rect.top + rect.height / 2;
        try {
          window.webgazer.recordScreenPosition(cx, cy, "click");
        } catch { /* ignore */ }

        const c = parseInt(cell.dataset.count, 10) + 1;
        cell.dataset.count = String(c);
        dot.style.transform = "scale(1.25)";
        setTimeout(() => (dot.style.transform = "scale(1)"), 100);
        if (c >= CLICKS_PER_TARGET) cell.classList.add("done");
        if (targets.every((t) => parseInt(t.dataset.count, 10) >= CLICKS_PER_TARGET)) {
          startValidation();
        }
      });

      grid.appendChild(cell);
      targets.push(cell);
    }
  }

  /* ---------------- validation ---------------- */

  // Show the central dot, sample predictions for a couple of seconds, and report
  // the mean distance from the dot. Lets the user recalibrate before recording.
  function startValidation() {
    calib.classList.remove("show");
    validateResult.classList.remove("show");
    validateHint.style.visibility = "visible";
    validate.classList.add("show");

    const rect = validateDot.getBoundingClientRect();
    const targetX = rect.left + rect.width / 2;
    const targetY = rect.top + rect.height / 2;

    const samples = [];
    const startedAt = Date.now();
    const sampleTimer = window.setInterval(async () => {
      const elapsed = Date.now() - startedAt;
      let data = null;
      try {
        data = await window.webgazer.getCurrentPrediction();
      } catch { /* ignore */ }
      if (elapsed > VALIDATION_WARMUP_MS && data) {
        samples.push(Math.hypot(data.x - targetX, data.y - targetY));
      }
      if (elapsed >= VALIDATION_MS) {
        clearInterval(sampleTimer);
        showValidationResult(samples);
      }
    }, VALIDATION_INTERVAL_MS);
  }

  function showValidationResult(samples) {
    validateHint.style.visibility = "hidden";
    const diag = Math.hypot(browserWidth, browserHeight);

    let grade, cls, detail;
    if (samples.length === 0) {
      grade = "No signal";
      cls = "poor";
      detail = "WebGazer couldn't read your gaze. Check lighting and that your face is visible, then recalibrate.";
    } else {
      const meanPx = samples.reduce((a, b) => a + b, 0) / samples.length;
      const frac = meanPx / diag;
      if (frac <= GOOD_FRAC) { grade = "Good"; cls = "good"; }
      else if (frac <= FAIR_FRAC) { grade = "Fair"; cls = "fair"; }
      else { grade = "Poor"; cls = "poor"; }
      detail = "Average error: ~" + Math.round(meanPx) + " px (" +
        (frac * 100).toFixed(1) + "% of screen). " +
        (cls === "good"
          ? "You're good to go."
          : "Recalibrate for better results — keep your head still and click each dot while looking right at it.");
    }

    validateScore.innerHTML =
      'Calibration accuracy: <span class="grade ' + cls + '">' + grade + "</span><br>" + detail;
    validateResult.classList.add("show");
  }

  function finishCalibration() {
    validate.classList.remove("show");
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
        .applyKalmanFilter(true)   // smooth out prediction jitter
        .setGazeListener(function (data) { moveGazeDot(data); })
        .begin();

      // By default WebGazer trains on every mouse click AND mouse-move, which
      // biases the model toward the cursor. Drop the global listeners so it only
      // learns from our deliberate calibration clicks (via recordScreenPosition).
      try { window.webgazer.removeMouseEventListeners(); } catch { /* ignore */ }

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

  startRecordingBtn.addEventListener("click", () => {
    finishCalibration();
  });

  recalibrateBtn.addEventListener("click", () => {
    validate.classList.remove("show");
    validateResult.classList.remove("show");
    try { window.webgazer.clearData(); } catch { /* ignore */ }
    calib.classList.add("show");
    buildCalibrationGrid();
  });

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
