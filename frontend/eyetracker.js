/*
 * Standalone WebGazer capture.
 *
 * Flow: consent -> load WebGazer -> start camera -> create session ->
 * face positioning -> 18-point calibration -> 18-point validation ->
 * poll gaze predictions -> batch-POST to the backend. Coordinates are stored in
 * viewport pixels; because the content fills the viewport, they map 1:1 to the
 * page the viewer will reproduce.
 */
(function () {
  "use strict";

  const DATAPOINTS_PER_SECOND = 10;
  const MAX_CACHE_SIZE = 20;
  const FLUSH_INTERVAL_MS = 5000;
  const CONSENT_KEY = "gazeConsent:v1";
  const PAGE_NAME = "sample-page";
  const CAMERA_START_TIMEOUT_MS = 30000;

  const browserWidth = window.innerWidth;
  const browserHeight = window.innerHeight;

  // DOM
  const consentBackdrop = document.getElementById("consentBackdrop");
  const acceptBtn = document.getElementById("acceptBtn");
  const declineBtn = document.getElementById("declineBtn");
  const cameraErrorBackdrop = document.getElementById("cameraErrorBackdrop");
  const cameraErrorText = document.getElementById("cameraErrorText");
  const cameraRetryBtn = document.getElementById("cameraRetryBtn");
  const position = document.getElementById("position");
  const previewSlot = document.getElementById("previewSlot");
  const positionDoneBtn = document.getElementById("positionDoneBtn");
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
  const contentFrame = document.getElementById("contentFrame");

  // State
  let sessionId = null;
  let validationAttempt = 0;   // counts validation runs (recalibration repeats it)
  let dataCache = [];
  let pointsStored = 0;
  let calibrationFinish = false;
  let timeBegin = null;
  let logIntervalId = null;
  let started = false;
  let flushTimerId = null;

  const targets = [];
  // Each click adds one training sample for that screen position; 5 per point
  // is what WebGazer's own calibration uses.
  const CLICKS_PER_TARGET = 5;

  // Validation: show each evaluation point in turn, sample the prediction
  // while the user stares at it, and report the error so a bad calibration is
  // caught before recording. Per-point results are stored with the session.
  const VALIDATION_POINT_MS = 3000;    // how long each evaluation point is shown
  const VALIDATION_WARMUP_MS = 800;    // ignore the eye travelling to the point
  const VALIDATION_INTERVAL_MS = 50;   // ~20 samples/s
  // Error thresholds as a fraction of the viewport diagonal.
  const GOOD_FRAC = 0.06;
  const FAIR_FRAC = 0.12;

  // Edge margin per axis, scaled to the window's actual pixel size so dots
  // stay close to the true edge on large screens (where a flat % margin would
  // leave a big unused pixel gap) without crowding the edge on small ones.
  const MARGIN_MIN_PX = 24;
  const MARGIN_MAX_PX = 120;
  const MARGIN_RATIO = 0.06;

  function marginPercent(dimensionPx) {
    const marginPx = Math.min(
      MARGIN_MAX_PX,
      Math.max(MARGIN_MIN_PX, dimensionPx * MARGIN_RATIO)
    );
    return (marginPx / dimensionPx) * 100;
  }

  // 18 calibration/evaluation positions (6 x 3 grid) as viewport percentages,
  // following Psarra et al. (J. Eye Mov. Res. 2026, 19, 99), where the 18-18
  // fixed layout gave the lowest error. Recomputed against the current window
  // size so corners/edges sit close to the true border (where WebGazer trains
  // weakest) regardless of screen size or aspect ratio. The 6 columns are
  // evenly spaced between the left and right margins.
  const GRID_COLUMNS = 6;

  function calibPositions() {
    const mx = marginPercent(window.innerWidth);
    const my = marginPercent(window.innerHeight);
    const columns = [];
    for (let c = 0; c < GRID_COLUMNS; c++) {
      columns.push(mx + (c * (100 - 2 * mx)) / (GRID_COLUMNS - 1));
    }
    const rows = [my, 50, 100 - my];
    return rows.flatMap((y) => columns.map((x) => [x, y]));
  }

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

  // Block the page with a plain-language reason when the webcam can't start
  // (error names are the standard getUserMedia ones).
  function showCameraError(e) {
    const name = e && e.name;
    let msg;
    if (name === "NotAllowedError") {
      msg = "Camera access is blocked for this site. Allow the camera in your browser's address bar, then try again.";
    } else if (name === "NotFoundError") {
      msg = "No camera was found on this device.";
    } else if (name === "NotReadableError") {
      msg = "The camera is being used by another app or browser tab. Close it, then try again.";
    } else {
      msg = "The camera did not start. Allow camera access if asked, close other apps using the camera, then try again.";
    }
    hudStatus.textContent = "Camera unavailable";
    cameraErrorText.textContent = msg;
    cameraErrorBackdrop.classList.add("show");
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

    function flushCache(useBeacon = false) {
		if (dataCache.length === 0 || sessionId == null) return;
		const batch = dataCache;
		dataCache = [];

		if  (useBeacon && navigator.sendBeacon) {
			const blob = new Blob([JSON.stringify({ points: batch })], { type: "application/json" });
			const queued = navigator.sendBeacon("/api/points", blob);
			if (!queued) dataCache = batch.concat(dataCache);	// Put back into cache if refused
			return;
		}

		return fetch("/api/points", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ points: batch }),
		}).then(() => {
			pointsStored += batch.length;
			hudPoints.textContent = pointsStored + " points";
		}).catch((e) => console.error("Failed to store points", e));
    }

  // Save the per-point accuracy of one validation run. Best-effort: a failed
  // save must not stop the participant from starting.
  async function storeValidation(points) {
    if (sessionId == null) return;
    try {
      await fetch("/api/validation", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session_id: sessionId, attempt: validationAttempt, points }),
      });
    } catch (e) {
      console.error("Failed to store validation", e);
    }
  }

  /* ---------------- face positioning ---------------- */

  // Before calibrating, show WebGazer's live camera preview with its face
  // feedback box (green once both eyes are inside it), so the participant can
  // fix their position/lighting first. The preview is hidden again afterwards.
  function setCameraPreview(visible) {
    try {
      window.webgazer
        .showVideo(visible)
        .showFaceOverlay(visible)
        .showFaceFeedbackBox(visible);
    } catch { /* ignore */ }
  }

  function startPositioning() {
    hudStatus.textContent = "Checking camera…";
    position.classList.add("show");
    // WebGazer pins its preview to the top-left corner; move it into the
    // slot in our overlay and lift it above the overlay.
    const container = document.getElementById("webgazerVideoContainer");
    if (container) {
      const rect = previewSlot.getBoundingClientRect();
      container.style.left = rect.left + "px";
      container.style.top = rect.top + "px";
      container.style.zIndex = "125";
    }
    setCameraPreview(true);
  }

  function finishPositioning() {
    setCameraPreview(false);
    position.classList.remove("show");
    hudStatus.textContent = "Calibrating…";
    calib.classList.add("show");
    buildCalibrationGrid();
  }

  /* ---------------- calibration ---------------- */

  function buildCalibrationGrid() {
    grid.innerHTML = "";
    targets.length = 0;

    const positions = calibPositions();
    for (let i = 0; i < positions.length; i++) {
      const [xPct, yPct] = positions[i];
      const cell = document.createElement("div");
      cell.className = "target";
      cell.style.left = xPct + "%";
      cell.style.top = yPct + "%";
      const dot = document.createElement("div");
      cell.appendChild(dot);
      cell.dataset.count = "0";

      // The click target is the padded cell, not the 12px dot, so the small
      // dot is still easy to hit.
      cell.addEventListener("click", (e) => {
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
        dot.style.transform = "scale(1.5)";
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

  // Show each evaluation point (the same positions as calibration) in turn,
  // sample predictions while it is visible, and report the mean distance from
  // the points. Lets the user recalibrate before recording.
  function startValidation() {
    calib.classList.remove("show");
    validateResult.classList.remove("show");
    validateHint.style.visibility = "visible";
    validateDot.style.display = "block";
    validate.classList.add("show");
    validationAttempt += 1;

    const positions = calibPositions();
    const points = [];
    const allErrors = [];

    function runPoint(index) {
      const [xPct, yPct] = positions[index];
      validateDot.style.left = xPct + "%";
      validateDot.style.top = yPct + "%";
      const rect = validateDot.getBoundingClientRect();
      const targetX = rect.left + rect.width / 2;
      const targetY = rect.top + rect.height / 2;

      const errors = [];
      const startAt = Date.now();
      let finished = false;
      const sampleTimer = window.setInterval(async () => {
        let data = null;
        try {
          data = await window.webgazer.getCurrentPrediction();
        } catch { /* ignore */ }
        // The await above lets ticks overlap, so a late one may land after
        // this point has already been closed.
        if (finished) return;
        const elapsed = Date.now() - startAt;
        if (elapsed > VALIDATION_WARMUP_MS && data) {
          errors.push(Math.hypot(data.x - targetX, data.y - targetY));
        }
        if (elapsed >= VALIDATION_POINT_MS) {
          finished = true;
          clearInterval(sampleTimer);
          points.push({
            point_index: index,
            target_x: Math.round(targetX),
            target_y: Math.round(targetY),
            mean_error_px: errors.length
              ? errors.reduce((a, b) => a + b, 0) / errors.length
              : null,
            sample_count: errors.length,
          });
          allErrors.push(...errors);
          if (index + 1 < positions.length) {
            runPoint(index + 1);
          } else {
            validateDot.style.display = "none";
            storeValidation(points);
            showValidationResult(allErrors, positions.length);
          }
        }
      }, VALIDATION_INTERVAL_MS);
    }

    runPoint(0);
  }

  function showValidationResult(samples, pointCount) {
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
      detail = "Average error over " + pointCount + " points: ~" +
        Math.round(meanPx) + " px (" +
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
  /* ---------------- HTML id ---------------- */
  
  function getPointElementId(x, y) {
    // x/y are viewport-relative. The tracked content lives inside an iframe,
    // so elementFromPoint on the parent document would only ever resolve to
    // the iframe itself — translate into the iframe's local coordinates and
    // query its own document instead.
    const frameRect = contentFrame.getBoundingClientRect();
    const doc = contentFrame.contentDocument;
    if (!doc ||
        x < frameRect.left || x > frameRect.right ||
        y < frameRect.top || y > frameRect.bottom) {
      return "No_element_id";
    }
    const el = doc.elementFromPoint(x - frameRect.left, y - frameRect.top);
    return el ? (el.id || "No_element_id") : "No_element_id";
  }
  function getFrameScroll() {
    const win = contentFrame.contentWindow;
    const doc = contentFrame.contentDocument;
    if (!win || !doc) return { x: 0, y: 0 };

    let x = win.scrollX || doc.documentElement.scrollLeft || doc.body.scrollLeft || 0;
    let y = win.scrollY || doc.documentElement.scrollTop || doc.body.scrollTop || 0;

    // fallback: the page might scroll inside an inner container
    if (y === 0) {
      for (const el of doc.body.querySelectorAll("*")) {
        if (el.scrollTop > 0) { x = el.scrollLeft; y = el.scrollTop; break; }
      }
    }
    return { x, y };
  }

  async function logPoint() {
    if (!calibrationFinish || sessionId == null) return;
    const data = await window.webgazer.getCurrentPrediction();
    if (!data) return;
    if (!inBounds(data.x, data.y)) return;

    if (!timeBegin) timeBegin = Date.now();
    const timeElapsed = (Date.now() - timeBegin) / 1000;

    // scroll offset at the moment of this reading
    const { x: scrollX, y: scrollY } = getFrameScroll();

    // convert screen-relative gaze point into full-page (document-absolute) position
    const frameRect = contentFrame.getBoundingClientRect();
    const x_point = parseInt(data.x - frameRect.left + scrollX, 10);
    const y_point = parseInt(data.y - frameRect.top + scrollY, 10);
    console.log("scrollY:", scrollY, "y_point:", y_point);

    dataCache.push({
      session_id: sessionId,
      x: x_point,
      y: y_point,
      timestamp: timeElapsed,
      element: getPointElementId(data.x, data.y),
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

      // begin() resolves once the webcam is delivering frames and rejects if
      // the camera is blocked/busy. Wait for it (with a timeout, in case no
      // frame ever arrives) so a dead camera is reported here instead of
      // surfacing later as "No signal" after a full calibration.
      let cameraTimeoutId = null;
      try {
        await Promise.race([
          window.webgazer
            .showVideo(false)
            .showFaceOverlay(false)
            .showFaceFeedbackBox(false)
            .showPredictionPoints(false)
            .applyKalmanFilter(true)   // smooth out prediction jitter
            // WebGazer otherwise reloads calibration samples saved by earlier
            // visits in this browser — a different sitting position, or a
            // different person — and mixes them into the new model.
            .saveDataAcrossSessions(false)
            .setGazeListener(function (data) { moveGazeDot(data); })
            .begin(),
          new Promise((_, reject) => {
            cameraTimeoutId = setTimeout(
              () => reject(new Error("Camera start timed out")),
              CAMERA_START_TIMEOUT_MS
            );
          }),
        ]);
      } catch (e) {
        console.error(e);
        showCameraError(e);
        return;
      } finally {
        clearTimeout(cameraTimeoutId);
      }

      // By default WebGazer trains on every mouse click AND mouse-move, which
      // biases the model toward the cursor. Drop the global listeners so it only
      // learns from our deliberate calibration clicks (via recordScreenPosition).
      // (begin() adds them, so this must run after it has finished.)
      try { window.webgazer.removeMouseEventListeners(); } catch { /* ignore */ }

      // Wipe any samples an earlier visit left in this browser's storage.
      try { await window.webgazer.clearData(); } catch { /* ignore */ }

      // Only create the session once the camera works, so failed starts don't
      // leave empty sessions behind.
      await createSession();

      startPositioning();

      logIntervalId = window.setInterval(logPoint, 1000 / DATAPOINTS_PER_SECOND);
	  flushTimerId = window.setInterval(() => flushCache(), FLUSH_INTERVAL_MS);
    } catch (e) {
      console.error(e);
      hudStatus.textContent = "Error starting eye tracker";
    }
  }

  function endWebgazer() {
    if (logIntervalId) clearInterval(logIntervalId);
	if (flushTimerId) clearInterval(flushTimerId);
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
    // A poor result is most often a badly placed face, so check that first.
    startPositioning();
  });

  positionDoneBtn.addEventListener("click", finishPositioning);

  cameraRetryBtn.addEventListener("click", () => window.location.reload());

  finishBtn.addEventListener("click", async () => {
    finishBtn.disabled = true;
    hudStatus.textContent = "Saving…";
    await flushCache();
    endWebgazer();
    window.location.href = "viewer.html?session_id=" + encodeURIComponent(sessionId);
  });

  window.addEventListener("pagehide", () => {
	flushCache(true);
	endWebgazer();
  });

  document.addEventListener("visibilitychange", () => {
	if (document.hidden) flushCache(true);
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
