from datetime import datetime
from sqlalchemy import BigInteger, DateTime, Integer, Float, ForeignKey, String, Index
from sqlalchemy.orm import Mapped, mapped_column, relationship
from .database import Base

class GazepointSession(Base):
    __tablename__ = "gazepoint_sessions"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    page_name: Mapped[str] = mapped_column(String(255), nullable=False)
    browser_width: Mapped[int | None] = mapped_column(Integer, nullable=True)
    browser_height: Mapped[int | None] = mapped_column(Integer, nullable=True)
    created_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)

    # Relationship back to fixations
    fixations: Mapped[list["Fixation"]] = relationship(
        "Fixation", back_populates="session", lazy="selectin"
    )
    data: Mapped[list["GazepointData"]] = relationship(
        "GazepointData", back_populates="session", uselist=False, lazy="selectin"
    )

class GazepointData(Base):
    __tablename__ = "gazepoint_data"

    __table_args__ = (
        Index("idx_gaze_session_ts", "session_id", "timestamp"),
	)

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    session_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("gazepoint_sessions.id"), nullable=False
    )
    x: Mapped[float] = mapped_column(Float, nullable=False)
    y: Mapped[float] = mapped_column(Float, nullable=False)
    timestamp: Mapped[float] = mapped_column(Float, nullable=False)
    element: Mapped[str] = mapped_column(String(255), nullable=True)
    subsection: Mapped[str] = mapped_column(String(255), nullable=True)
    created_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)

    session: Mapped["GazepointSession"] = relationship(
        "GazepointSession", back_populates="data", lazy="selectin"
    )


class ValidationPoint(Base):
    """Accuracy of one evaluation point from the post-calibration check: the
    mean distance (px) between the point and the gaze predictions sampled
    while the participant looked at it. A session has one row per point per
    attempt; recalibrating adds a new attempt, and the highest attempt is the
    calibration the recording was made with.
    """
    __tablename__ = "validation_points"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    session_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("gazepoint_sessions.id"), nullable=False, index=True
    )
    attempt: Mapped[int] = mapped_column(Integer, nullable=False)
    point_index: Mapped[int] = mapped_column(Integer, nullable=False)
    target_x: Mapped[float] = mapped_column(Float, nullable=False)
    target_y: Mapped[float] = mapped_column(Float, nullable=False)
    # NULL when no gaze prediction was available while the point was shown.
    mean_error_px: Mapped[float | None] = mapped_column(Float, nullable=True)
    sample_count: Mapped[int] = mapped_column(Integer, nullable=False)
    created_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)


class Fixation(Base):
    __tablename__ = "fixation_points"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    session_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("gazepoint_sessions.id"), nullable=False, index=True
    )
    fixation_id: Mapped[int] = mapped_column(Integer, nullable=False)
    x: Mapped[float] = mapped_column(Float, nullable=False)
    y: Mapped[float] = mapped_column(Float, nullable=False)
    duration: Mapped[int] = mapped_column(BigInteger, nullable=False)
    timestamp: Mapped[int] = mapped_column(BigInteger, nullable=False)

    # Relationship to parent session
    session: Mapped["GazepointSession"] = relationship(
        "GazepointSession", back_populates="fixations", lazy="selectin"
    )
