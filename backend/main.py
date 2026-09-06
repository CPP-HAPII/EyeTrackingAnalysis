"""Standalone eye-tracking demo backend.

A single FastAPI service that:
  * serves the static frontend (capture + viewer pages),
  * stores gaze sessions and raw gaze points in SQLite,
  * runs the reused ST-DBSCAN fixation pipeline on demand,
  * returns raw points and processed fixations for heatmap rendering.

Run from this directory:  uvicorn main:app --reload --port 8000
Then open:                http://localhost:8000/
"""
import sys
import shutil
import asyncio
import subprocess
from pathlib import Path
from datetime import datetime, timezone

BASE_DIR = Path(__file__).resolve().parent          # backend/
UTILS_DIR = BASE_DIR / "utils"
FRONTEND_DIR = BASE_DIR.parent / "frontend"

# Make the pipeline's `db` package importable the same way the subprocess
# scripts see it (their sys.path[0] is utils/, so they do `from db...`).
sys.path.insert(0, str(UTILS_DIR))

from fastapi import FastAPI, Depends, HTTPException, Request  # noqa: E402
from fastapi.middleware.cors import CORSMiddleware  # noqa: E402
from fastapi.staticfiles import StaticFiles  # noqa: E402
from sqlalchemy import select, func  # noqa: E402
from sqlalchemy.ext.asyncio import AsyncSession  # noqa: E402

from db.database import get_db, init_db, AsyncSessionLocal  # noqa: E402
from db.models import GazepointSession, GazepointData, Fixation  # noqa: E402

# Minimum gaze points needed for the clustering pipeline to find a knee/fixations.
MIN_POINTS_FOR_FIXATIONS = 40

# Folders the pipeline writes into; cleared before each processing run so only
# the requested session is processed.
PIPELINE_WORK_DIRS = [
    UTILS_DIR / "raw_WG_data",
    UTILS_DIR / "elbow_knee_values",
    UTILS_DIR / "best_params",
    UTILS_DIR / "fixations",
]

app = FastAPI(title="Eye-Tracking Analysis Demo")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.on_event("startup")
async def _startup() -> None:
    """Create SQLite tables if they don't exist yet."""
    await init_db()


# --------------------------------------------------------------------------
# Capture endpoints
# --------------------------------------------------------------------------

@app.post("/api/session")
async def create_session(request: Request, db: AsyncSession = Depends(get_db)):
    """Create a gaze session and return its id."""
    body = await request.json()
    session = GazepointSession(
        page_name=body.get("page_name", "NA"),
        browser_width=int(body.get("browser_width") or 0),
        browser_height=int(body.get("browser_height") or 0),
        created_at=datetime.now(timezone.utc),
    )
    db.add(session)
    await db.flush()
    await db.refresh(session)
    # Commit before returning: get_db's post-yield commit runs only after the
    # response is sent, which races with the client's next request.
    await db.commit()
    return {"status": "success", "session_id": session.id}


@app.post("/api/points")
async def store_points(request: Request, db: AsyncSession = Depends(get_db)):
    """Batch-store gaze points. Body: {points: [{session_id,x,y,timestamp,...}]}."""
    body = await request.json()
    points = body.get("points", [])
    if not points:
        return {"status": "success", "stored": 0}

    now = datetime.now(timezone.utc)
    rows = [
        GazepointData(
            session_id=int(p["session_id"]),
            x=float(p["x"]),
            y=float(p["y"]),
            timestamp=float(p["timestamp"]),
            element=(p.get("element") or None),
            subsection=(p.get("subsection") or None),
            created_at=now,
        )
        for p in points
    ]
    db.add_all(rows)
    await db.commit()
    return {"status": "success", "stored": len(rows)}


# --------------------------------------------------------------------------
# Retrieval endpoints
# --------------------------------------------------------------------------

@app.get("/api/sessions")
async def list_sessions(db: AsyncSession = Depends(get_db)):
    """List sessions with gaze-point and fixation counts, newest first."""
    point_counts = dict(
        (await db.execute(
            select(GazepointData.session_id, func.count(GazepointData.id))
            .group_by(GazepointData.session_id)
        )).all()
    )
    fixation_counts = dict(
        (await db.execute(
            select(Fixation.session_id, func.count(Fixation.id))
            .group_by(Fixation.session_id)
        )).all()
    )
    sessions = (await db.execute(
        select(GazepointSession).order_by(GazepointSession.id.desc())
    )).scalars().all()

    return {
        "status": "success",
        "data": [
            {
                "id": s.id,
                "page_name": s.page_name,
                "browser_width": s.browser_width,
                "browser_height": s.browser_height,
                "created_at": s.created_at.isoformat() if s.created_at else None,
                "point_count": point_counts.get(s.id, 0),
                "fixation_count": fixation_counts.get(s.id, 0),
            }
            for s in sessions
        ],
    }


@app.get("/api/session/{session_id}")
async def get_session(session_id: int, db: AsyncSession = Depends(get_db)):
    """Return metadata for a single session."""
    session = await db.get(GazepointSession, session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
    return {
        "status": "success",
        "data": {
            "id": session.id,
            "page_name": session.page_name,
            "browser_width": session.browser_width,
            "browser_height": session.browser_height,
            "created_at": session.created_at.isoformat() if session.created_at else None,
        },
    }


@app.get("/api/points")
async def get_points(session_id: int, db: AsyncSession = Depends(get_db)):
    """Return raw gaze points (pixels) for a session, ordered by time."""
    rows = (await db.execute(
        select(GazepointData)
        .where(GazepointData.session_id == session_id)
        .order_by(GazepointData.timestamp)
    )).scalars().all()
    return {
        "status": "success",
        "data": [{"x": r.x, "y": r.y, "timestamp": r.timestamp} for r in rows],
    }


@app.get("/api/fixations")
async def get_fixations(session_id: int, db: AsyncSession = Depends(get_db)):
    """Return processed fixations (normalized 0-1 coords) for a session."""
    rows = (await db.execute(
        select(Fixation)
        .where(Fixation.session_id == session_id)
        .order_by(Fixation.timestamp)
    )).scalars().all()
    return {
        "status": "success",
        "data": [
            {
                "fixation_id": r.fixation_id,
                "x": r.x,
                "y": r.y,
                "duration": r.duration,
                "timestamp": r.timestamp,
            }
            for r in rows
        ],
    }


# --------------------------------------------------------------------------
# Fixation processing
# --------------------------------------------------------------------------

def _clean_work_dirs() -> None:
    """Remove any leftover CSVs so the pipeline only sees the current session."""
    for d in PIPELINE_WORK_DIRS:
        for f in d.glob("*.csv"):
            f.unlink(missing_ok=True)


def _run_pipeline(session_id: str, screen_w: str, screen_h: str) -> None:
    """Run the 5-stage ST-DBSCAN fixation pipeline as sequential subprocesses.

    Blocking; call via asyncio.to_thread so the event loop stays responsive.
    Each script resolves `from db...` via its own directory (utils/), so cwd
    is set to the backend root and scripts are referenced as utils/<name>.py.
    """
    py = sys.executable
    steps = [
        [py, "utils/data_to_csv.py", session_id],
        [py, "utils/find_elbow.py", screen_w, screen_h, "all"],
        [py, "utils/stdbscan_tuning.py", screen_w, screen_h],
        [py, "utils/improved_gaze_converter.py", screen_w, screen_h],
        [py, "utils/fixation_store.py", session_id],
    ]
    for cmd in steps:
        result = subprocess.run(
            cmd, cwd=str(BASE_DIR), capture_output=True, text=True
        )
        if result.returncode != 0:
            raise RuntimeError(
                f"Pipeline step failed: {' '.join(cmd)}\n"
                f"STDOUT:\n{result.stdout}\nSTDERR:\n{result.stderr}"
            )


@app.post("/api/process")
async def process_session(request: Request):
    """Run the fixation pipeline for a session and store the resulting fixations."""
    body = await request.json()
    session_id = body.get("session_id")
    if session_id is None:
        raise HTTPException(status_code=400, detail="session_id is required")

    # Fetch dims + point count in a short-lived session, then release the
    # connection before the pipeline subprocesses touch the same SQLite file.
    async with AsyncSessionLocal() as db:
        session = await db.get(GazepointSession, int(session_id))
        if not session:
            raise HTTPException(status_code=404, detail="Session not found")
        screen_w = str(session.browser_width or 1920)
        screen_h = str(session.browser_height or 1080)
        point_count = (await db.execute(
            select(func.count(GazepointData.id))
            .where(GazepointData.session_id == int(session_id))
        )).scalar_one()
        already = (await db.execute(
            select(func.count(Fixation.id))
            .where(Fixation.session_id == int(session_id))
        )).scalar_one()

    if already:
        return {"status": "complete", "message": "Fixations already processed",
                "fixation_count": already}

    if point_count < MIN_POINTS_FOR_FIXATIONS:
        raise HTTPException(
            status_code=422,
            detail=(
                f"Session has only {point_count} gaze points; at least "
                f"{MIN_POINTS_FOR_FIXATIONS} are needed for fixation processing. "
                "Record a longer session."
            ),
        )

    _clean_work_dirs()
    try:
        await asyncio.to_thread(_run_pipeline, str(session_id), screen_w, screen_h)
    except RuntimeError as e:
        raise HTTPException(status_code=500, detail=str(e))

    async with AsyncSessionLocal() as db:
        count = (await db.execute(
            select(func.count(Fixation.id))
            .where(Fixation.session_id == int(session_id))
        )).scalar_one()

    return {"status": "complete", "fixation_count": count}


# --------------------------------------------------------------------------
# Static frontend (mounted last so /api/* routes take precedence)
# --------------------------------------------------------------------------
app.mount("/", StaticFiles(directory=str(FRONTEND_DIR), html=True), name="frontend")
