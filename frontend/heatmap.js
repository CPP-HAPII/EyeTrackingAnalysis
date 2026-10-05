/*
 * Heatmap viewer.
 *
 * Loads a captured session, reproduces the page it was captured on inside a
 * native-sized (browser_width x browser_height) stage, and overlays either the
 * raw gaze heatmap or the processed fixations. The stage is CSS-scaled to fit
 * the panel, so overlay coordinates stay in native capture pixels.
 */
(function () {
  "use strict";

  const sessionSelect = document.getElementById("sessionSelect");
  const showHeatmapBtn = document.getElementById("showHeatmapBtn");
  const processBtn = document.getElementById("processBtn");
  const showFixationsBtn = document.getElementById("showFixationsBtn");
  const showElementsBtn = document.getElementById("showElementsBtn");
  const statusEl = document.getElementById("status");
  const placeholder = document.getElementById("placeholder");
  const stage = document.getElementById("stage");
  const stagePanel = document.getElementById("stagePanel");
  const contentFrame = document.getElementById("contentFrame");
  const overlay = document.getElementById("overlay");

  let heatmap = null;
  let sessions = [];
  let currentSession = null;
  let stageHeight = 0; // full document height of the currently reproduced page
  let stageReady = Promise.resolve();

  function setStatus(msg) { statusEl.textContent = msg || ""; }

  function loadHeatmapScript() {
    return new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = "https://cdnjs.cloudflare.com/ajax/libs/heatmap.js/2.0.0/heatmap.min.js";
      script.onload = resolve;
      script.onerror = () => reject(new Error("Failed to load heatmap.js"));
      document.head.appendChild(script);
    });
  }

  async function fetchJSON(url, opts) {
    const res = await fetch(url, opts);
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json.detail || res.statusText);
    return json;
  }

  function sessionLabel(s) {
    const when = s.created_at ? new Date(s.created_at).toLocaleString() : "unknown time";
    return `#${s.id} · ${s.point_count} pts · ${s.fixation_count} fix · ${when}`;
  }

  async function loadSessions(preselectId) {
    const json = await fetchJSON("/api/sessions");
    sessions = json.data || [];
    sessionSelect.innerHTML = "";
    if (sessions.length === 0) {
      const opt = document.createElement("option");
      opt.textContent = "No sessions yet — capture one first";
      opt.value = "";
      sessionSelect.appendChild(opt);
      return;
    }
    for (const s of sessions) {
      const opt = document.createElement("option");
      opt.value = String(s.id);
      opt.textContent = sessionLabel(s);
      sessionSelect.appendChild(opt);
    }
    if (preselectId && sessions.some((s) => String(s.id) === String(preselectId))) {
      sessionSelect.value = String(preselectId);
    }
    onSessionChange();
  }

  function onSessionChange() {
    const id = sessionSelect.value;
    currentSession = sessions.find((s) => String(s.id) === String(id)) || null;
    resetOverlay();
    const hasSession = !!currentSession;
    showHeatmapBtn.disabled = !hasSession || currentSession.point_count === 0;
    processBtn.disabled = !hasSession || currentSession.point_count === 0;
    showFixationsBtn.disabled = !hasSession || currentSession.fixation_count === 0;
    showElementsBtn.disabled = !hasSession || currentSession.fixation_count === 0;
    if (hasSession) setupStage(currentSession);
  }

  // Size the native stage to the capture viewport and scale it to fit the panel.
  function setupStage(session) {
    const w = session.browser_width || 1280;
    const h = session.browser_height || 720;
    stage.style.width = w + "px";
    stage.style.height = h + "px";
    stageHeight = h;
    stageReady = new Promise((resolve) =>{
      contentFrame.onload = () => {
        const doc = contentFrame.contentDocument;
        stageHeight = doc ? Math.max(doc.documentElement.scrollHeight, h) : h;
        stage.style.height = stageHeight + "px";
        fitStage(w, stageHeight);
        resolve();
      };
    });
    contentFrame.src = "sample-page.html";
    placeholder.style.display = "none";
    stage.classList.add("show");
    fitStage(w, h);
  }

  function fitStage(w, h) {
    const panelW = stagePanel.clientWidth - 56;
    const panelH = stagePanel.clientHeight - 56;
    const scale = Math.min(panelW / w, panelH / h, 1);
    stage.style.transform = "scale(" + scale + ")";
    // Reserve scaled space so the panel scrolls/centres correctly.
    stage.style.marginBottom = h * scale - h + "px";
    stage.style.marginRight = w * scale - w + "px";
  }

  function resetOverlay() {
    if (heatmap) {
      const canvas = heatmap._renderer && heatmap._renderer.canvas;
      if (canvas && canvas.parentNode) canvas.parentNode.removeChild(canvas);
      heatmap = null;
    }
    overlay.innerHTML = "";
  }

  function createHeatmap() {
    resetOverlay();
    const w = parseInt(stage.style.width, 10) || currentSession.browser_width || 1280;
    const doc = contentFrame.contentDocument;
    const pageH = doc ? Math.max(doc.documentElement.scrollHeight, doc.body.scrollHeight) : 0;
    const h = Math.max(stageHeight, pageH, parseInt(stage.style.height, 10) || 0);
    stage.style.height = h + "px";
      heatmap = window.h337.create({
        container: stage,
        radius: 70,
        maxOpacity: 0.6,
        minOpacity: 0,
        blur: 0.8,
      });
      heatmap._renderer.setDimensions(w, h);   // resize the canvas itself
  }

  async function showHeatmap() {
    if (!currentSession) return;
    setStatus("Loading gaze points…");
    try {
      const json = await fetchJSON("/api/points?session_id=" + currentSession.id);
      const points = json.data || [];
      if (points.length === 0) { setStatus("No gaze points for this session."); return; }
      createHeatmap();
      const data = points.map((p) => ({ x: Math.round(p.x), y: Math.round(p.y), value: 1 }));
      heatmap.setData({ max: Math.max(3, Math.round(points.length / 12)), data });
      setStatus(points.length + " gaze points rendered.");
    } catch (e) {
      setStatus("Error: " + e.message);
    }
  }

  async function showFixations() {
    if (!currentSession) return;
    setStatus("Loading fixations…");
    try {
      const json = await fetchJSON("/api/fixations?session_id=" + currentSession.id);
      const fixations = (json.data || []).filter((f) => f.fixation_id >= 0);
      if (fixations.length === 0) { setStatus("No fixations — process first."); return; }
      const w = currentSession.browser_width || 1280;
      const h = currentSession.browser_height || 720;

      createHeatmap();
      const data = fixations.map((f) => ({
        x: Math.round(f.x * w),
        y: Math.round(f.y * h),
        value: Math.max(1, f.duration),
      }));
      const maxVal = Math.max.apply(null, data.map((d) => d.value));
      heatmap.setData({ max: maxVal, data });

      // Numbered fixation order labels.
      overlay.innerHTML = "";
      fixations.forEach((f, i) => {
        const label = document.createElement("p");
        label.className = "fix-label";
        label.textContent = String(i + 1);
        label.style.left = Math.round(f.x * w) + "px";
        label.style.top = Math.round(f.y * h) + "px";
        overlay.appendChild(label);
      });
      setStatus(fixations.length + " fixations rendered.");
    } catch (e) {
      setStatus("Error: " + e.message);
    }
  }

  async function processFixations() {
    if (!currentSession) return;
    processBtn.disabled = true;
    setStatus("Processing fixations… (this can take ~10–30s)");
    try {
      const json = await fetchJSON("/api/process", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session_id: currentSession.id }),
      });
      setStatus("Done: " + (json.fixation_count || 0) + " fixations.");
      await loadSessions(currentSession.id);
      await showFixations();
    } catch (e) {
      setStatus("Error: " + e.message);
      processBtn.disabled = false;
    }
  }

  // Walk up from an element until we find one with an id.
  // Only elements with an id count as "tagged" regions.
  function nearestIdAncestor(el) {
    while (el && el !== el.ownerDocument.documentElement) {
      if (el.id) return el;
      el = el.parentElement;
    }
    return null;
  }

  async function showElements() {
    if (!currentSession) return;
    setStatus("Loading fixations…");
    try {
      await stageReady;
      const json = await fetchJSON("/api/fixations?session_id=" + currentSession.id);
      const fixations = (json.data || []).filter((f) => f.fixation_id >= 0);
      if (fixations.length === 0) { setStatus("No fixations — process first."); return; }

      const doc = contentFrame.contentDocument;
      if (!doc) { setStatus("Page not loaded yet — try again in a moment."); return; }
      const w = currentSession.browser_width || 1280;
      const h = currentSession.browser_height || 720;

      const hits = new Map(); // element -> {count, duration}
      let unmatched = 0;
      for (const f of fixations) {
        // f.x/f.y were normalized by the capture viewport (browser_width x
        // browser_height), not the full scrollable page — reconstruct pixels
        // against the same basis or scrolled fixations land in the wrong spot.
        const x = Math.round(f.x * w);
        const y = Math.round(f.y * h);
        const el = nearestIdAncestor(doc.elementFromPoint(x, y));
        if (!el) { unmatched++; continue; }
        const entry = hits.get(el) || { count: 0, duration: 0 };
        entry.count += 1;
        entry.duration += Math.max(1, f.duration);
        hits.set(el, entry);
      }

      resetOverlay();
      if (hits.size === 0) {
        setStatus("No fixations landed on a tagged element.");
        return;
      }

      const maxCount = Math.max.apply(null, Array.from(hits.values()).map((v) => v.count));
      hits.forEach((entry, el) => {
        const rect = el.getBoundingClientRect();
        const box = document.createElement("div");
        box.className = "element-highlight";
        box.style.left = rect.left + "px";
        box.style.top = rect.top + "px";
        box.style.width = rect.width + "px";
        box.style.height = rect.height + "px";
        box.style.opacity = String(Math.max(0.25, entry.count / maxCount));

        const label = document.createElement("span");
        label.className = "element-count";
        label.textContent = "#" + el.id + " · " + entry.count;
        box.appendChild(label);
        overlay.appendChild(box);
      });

      setStatus(
        fixations.length + " fixations → " + hits.size + " elements" +
        (unmatched ? " (" + unmatched + " untagged)" : "") + "."
      );
    } catch (e) {
      setStatus("Error: " + e.message);
    }
  }

  // Wiring
  sessionSelect.addEventListener("change", onSessionChange);
  showHeatmapBtn.addEventListener("click", showHeatmap);
  showFixationsBtn.addEventListener("click", showFixations);
  processBtn.addEventListener("click", processFixations);
  showElementsBtn.addEventListener("click", showElements);
  window.addEventListener("resize", () => {
    if (currentSession) fitStage(currentSession.browser_width || 1280, stageHeight || currentSession.browser_height || 720);
  });

  (async function init() {
    try {
      await loadHeatmapScript();
    } catch (e) {
      setStatus(e.message);
      return;
    }
    const params = new URLSearchParams(window.location.search);
    await loadSessions(params.get("session_id"));
  })();
})();