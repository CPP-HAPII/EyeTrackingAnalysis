"""Async SQLite database layer for the standalone eye-tracking demo.

This replaces the original MySQL/aiomysql setup with a zero-config SQLite
file (`gaze.db` in the backend root). Every pipeline script and the FastAPI
app import `get_db` from here, so switching the engine in this single file
propagates the change everywhere.
"""
import os
from pathlib import Path

from sqlalchemy import event
from sqlalchemy.ext.asyncio import (
    create_async_engine,
    async_sessionmaker,
    AsyncSession,
)
from sqlalchemy.orm import DeclarativeBase

# backend/ (three levels up: db -> utils -> backend)
BASE_DIR = Path(__file__).resolve().parents[2]
DB_PATH = os.getenv("GAZE_DB_PATH", str(BASE_DIR / "gaze.db"))
db_url = f"sqlite+aiosqlite:///{DB_PATH}"

# A 30s busy timeout lets the FastAPI process and the pipeline subprocesses
# take turns writing the same SQLite file without immediate "database is
# locked" errors.
engine = create_async_engine(
    db_url,
    echo=False,
    connect_args={"timeout": 30},
)


@event.listens_for(engine.sync_engine, "connect")
def _set_sqlite_pragmas(dbapi_connection, connection_record):
    """Enable WAL + a busy timeout so concurrent readers/writers coexist."""
    cursor = dbapi_connection.cursor()
    cursor.execute("PRAGMA journal_mode=WAL;")
    cursor.execute("PRAGMA busy_timeout=30000;")
    cursor.close()


AsyncSessionLocal = async_sessionmaker(
    bind=engine,
    class_=AsyncSession,
    expire_on_commit=False,
)


class Base(DeclarativeBase):
    pass


async def get_db() -> AsyncSession:
    """Yield an async session, committing on success and rolling back on error."""
    async with AsyncSessionLocal() as session:
        try:
            yield session
            await session.commit()
        except Exception:
            await session.rollback()
            raise


async def init_db() -> None:
    """Create all tables if they do not yet exist (called at app startup)."""
    from . import models  # noqa: F401 - ensure models register with Base.metadata

    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
