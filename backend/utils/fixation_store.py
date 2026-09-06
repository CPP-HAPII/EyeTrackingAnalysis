import sys, os
from pathlib import Path
import pandas as pd
import asyncio
from sqlalchemy.ext.asyncio import AsyncSession
from db.database import get_db
from db.models import Fixation
from db.schemas import FixationCreate

BASE_DIR = Path(__file__).parent
FIXATION_PATH = BASE_DIR / "fixations"

async def store_fixation(data: FixationCreate, db: AsyncSession) -> Fixation:
    fixation = Fixation(
        session_id=data.session_id,
        fixation_id=data.fixation_id,
        x=data.x,
        y=data.y,
        duration=data.duration,
        timestamp=data.timestamp,
    )
    db.add(fixation)
    await db.flush()
    await db.refresh(fixation)
    return fixation

async def main():
    session_id = sys.argv[1]

    try:
        async for db in get_db():
            for user_fixation_file in FIXATION_PATH.glob("*.csv"):
                try:
                    df = pd.read_csv(user_fixation_file)
                    df = df[["TIMETICK", "FPOGX", "FPOGY", "FPOGID"]]

                    fixations = df.groupby("FPOGID").agg(
                        x=("FPOGX", "mean"),
                        y=("FPOGY", "mean"),
                        duration=("TIMETICK", lambda x: x.max() - x.min()),
                        timestamp=("TIMETICK", "max")
                    ).reset_index()

                    for _, row in fixations.iterrows():
                        data = FixationCreate(
                            session_id=session_id,
                            fixation_id=int(row["FPOGID"]),
                            x=float(row["x"]),
                            y=float(row["y"]),
                            duration=int(row["duration"]),
                            timestamp=int(row["timestamp"])
                        )
                        await store_fixation(data, db)

                except (KeyError, ValueError) as e:
                    print(f"Error processing {user_fixation_file.name}: {e}")
                    return

    except Exception as e:
        print(f"Fatal DB error: {e}")
        return

    # Best-effort cleanup of this session's intermediate files.
    for temp_file in (
        FIXATION_PATH / f"{session_id}_all_gaze.csv",
        BASE_DIR / "raw_WG_data" / f"session_{session_id}_data.csv",
        BASE_DIR / "elbow_knee_values" / "eps_values.csv",
        BASE_DIR / "best_params" / "best_param_values_mod.csv",
    ):
        try:
            os.remove(temp_file)
        except FileNotFoundError:
            pass

if __name__ == "__main__":
    asyncio.run(main())
