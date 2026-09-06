# Eye-Tracking Analysis — Standalone Demo

Webcam eye-tracking with attention heatmaps and fixation analysis, in a single
self-contained project. Extracted and decoupled from the CSU dashboard's
WebGazer feature.

**Stack:** one FastAPI service that serves the frontend, stores gaze data in
SQLite, and runs an ST-DBSCAN fixation pipeline. No PHP, no MySQL, no second
service.

```
capture (WebGazer, browser)  ─►  FastAPI  ─►  SQLite (gaze.db)
                                    │
                                    ├─ raw gaze  ─►  heatmap.js overlay
                                    └─ ST-DBSCAN pipeline  ─►  fixations
```

## What it does

1. **Capture** — consent → 9-point webcam calibration → your gaze is recorded
   while you look at a sample page.
2. **Heatmap** — view the raw gaze density overlaid on the same page.
3. **Fixations** — run the ST-DBSCAN pipeline to cluster gaze into fixations,
   shown as a heatmap with numbered look-order.

## Requirements

- Python 3.11
- A webcam
- A Chromium-based browser is recommended for WebGazer

## Setup

```bash
cd backend
python3.11 -m venv venv
source venv/bin/activate            # Windows: venv\Scripts\activate
pip install --upgrade pip
pip install -r requirements.txt
```

> If `st_dbscan` fails to build, run
> `pip install "setuptools<82.0.0" wheel` first, then re-run the install.

## Run

```bash
cd backend
uvicorn main:app --reload --port 8000
```

Then open **http://localhost:8000/**

- `/capture.html` — record a session
- `/viewer.html` — view heatmaps and fixations

The SQLite database (`backend/gaze.db`) and tables are created automatically on
first run.

## Project layout

```
backend/
  main.py                    FastAPI app: API endpoints + pipeline orchestrator + static mount
  requirements.txt
  utils/
    db/database.py           async SQLite engine (swap from the original MySQL)
    db/models.py             gazepoint_sessions / gazepoint_data / fixation_points
    db/schemas.py
    data_to_csv.py           \
    find_elbow.py             \  reused ST-DBSCAN fixation pipeline
    stdbscan_tuning.py        /  (adapted from CSULB BEACH-Gaze-Converter)
    improved_gaze_converter.py
    fixation_store.py        /
    aoi_config.json
    raw_WG_data/ elbow_knee_values/ best_params/ fixations/   pipeline scratch dirs
frontend/
  index.html                 landing page
  capture.html + capture.css + eyetracker.js
  viewer.html  + viewer.css  + heatmap.js
  sample-page.html           the content users look at (iframed by both pages)
```

## API

| Method | Path                          | Purpose                              |
|--------|-------------------------------|--------------------------------------|
| POST   | `/api/session`                | create a gaze session                |
| POST   | `/api/points`                 | batch-store gaze points              |
| GET    | `/api/sessions`               | list sessions (+ point/fixation counts) |
| GET    | `/api/session/{id}`           | session metadata                     |
| GET    | `/api/points?session_id=`     | raw gaze points (pixels)             |
| POST   | `/api/process`                | run the fixation pipeline            |
| GET    | `/api/fixations?session_id=`  | processed fixations (normalized)     |

## Notes & limitations

- **Accuracy** is webcam-based (WebGazer) — good for demos, not research-grade.
  Calibrate carefully and keep your head still.
- **Fixation processing** needs a reasonable amount of data — sessions with
  fewer than 40 gaze points are rejected. Record ~20–30 seconds.
- **Coordinates:** capture stores viewport pixels; because the sample page fills
  the viewport, the viewer reproduces it at the captured size for exact overlay
  alignment, then CSS-scales it to fit.
- **CSU decoupling:** login/consent-by-user-id, the dashboard page/subsection
  (AOI) taxonomy, MySQL, and the Laravel host were all removed. Consent is a
  local checkbox; storage is SQLite.

## Credits

- WebGazer — https://webgazer.cs.brown.edu/
- heatmap.js — https://www.patrick-wied.at/static/heatmapjs/
- Fixation scripts adapted from CSULB BEACH-Gaze-Converter —
  https://github.com/TheD2Lab/BEACH-Gaze-Converter
