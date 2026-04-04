#!/usr/bin/env python3
"""
EVE Recordings Indexer

Scans the EVE recordings directory and creates a unified index of all recordings.
This helps the review_pipeline quickly locate historical recordings.

Usage:
    python scripts/index_recordings.py
    python scripts/index_recordings.py --dry-run

Output:
    ~/.eve_recordings_index.json
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from datetime import datetime
from pathlib import Path


def get_recordings_dir() -> Path:
    """Get the recordings directory from environment or default."""
    return Path(os.getenv("EVE_RECORDINGS_DIR", Path.home() / "eve_recordings")).expanduser()


def scan_recordings(recordings_dir: Path, dry_run: bool = False) -> dict:
    """
    Scan recordings directory and build an index.

    Expected structure:
        recordings_dir/
            YYYYMMDD/
                eve_live_YYYYMMDD_HHMMSS.flac
                eve_live_YYYYMMDD_HHMMSS.json
    """
    index = {
        "created_at": datetime.now().isoformat(),
        "recordings_dir": str(recordings_dir),
        "dates": {},
        "total_recordings": 0,
        "total_size_bytes": 0,
    }

    if not recordings_dir.exists():
        print(f"Warning: Recordings directory not found: {recordings_dir}")
        if not dry_run:
            save_index(index)
        return index

    # Scan each date directory
    for date_dir in sorted(recordings_dir.iterdir()):
        if not date_dir.is_dir():
            continue
        if not date_dir.name.isdigit() or len(date_dir.name) != 8:
            continue  # Skip non-date directories

        date_str = date_dir.name
        date_info = {
            "path": str(date_dir),
            "recordings": [],
            "total_size_bytes": 0,
            "flac_count": 0,
            "json_count": 0,
        }

        for file_path in sorted(date_dir.iterdir()):
            if file_path.suffix == ".flac":
                json_path = file_path.with_suffix(".json")
                file_info = {
                    "flac_path": str(file_path),
                    "json_path": str(json_path) if json_path.exists() else None,
                    "json_exists": json_path.exists(),
                    "size_bytes": file_path.stat().st_size,
                    "timestamp": file_path.stem,  # eve_live_YYYYMMDD_HHMMSS
                }
                date_info["recordings"].append(file_info)
                date_info["flac_count"] += 1
                date_info["total_size_bytes"] += file_info["size_bytes"]
                index["total_recordings"] += 1
                index["total_size_bytes"] += file_info["size_bytes"]

            elif file_path.suffix == ".json":
                date_info["json_count"] += 1

        if date_info["recordings"]:
            index["dates"][date_str] = date_info

    return index


def save_index(index: dict, index_path: Path | None = None) -> None:
    """Save the index to a JSON file."""
    if index_path is None:
        index_path = Path.home() / ".eve_recordings_index.json"

    with open(index_path, "w", encoding="utf-8") as f:
        json.dump(index, f, indent=2, ensure_ascii=False)

    print(f"Index saved to: {index_path}")


def print_summary(index: dict) -> None:
    """Print a summary of the indexed recordings."""
    print("\n=== EVE Recordings Index Summary ===")
    print(f"Recordings directory: {index['recordings_dir']}")
    print(f"Total recordings: {index['total_recordings']}")
    print(f"Total size: {index['total_size_bytes'] / (1024*1024):.1f} MB")
    print(f"Date directories: {len(index['dates'])}")

    if index["dates"]:
        print("\nDates with recordings:")
        for date_str in sorted(index["dates"].keys(), reverse=True)[:10]:
            date_info = index["dates"][date_str]
            size_mb = date_info["total_size_bytes"] / (1024 * 1024)
            print(f"  {date_str}: {date_info['flac_count']} recordings, {size_mb:.1f} MB")

        if len(index["dates"]) > 10:
            print(f"  ... and {len(index['dates']) - 10} more dates")


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Index EVE recordings for easy retrieval"
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Scan but don't save the index",
    )
    parser.add_argument(
        "--recordings-dir",
        type=str,
        help="Override recordings directory",
    )
    args = parser.parse_args()

    if args.recordings_dir:
        recordings_dir = Path(args.recordings_dir).expanduser()
        os.environ["EVE_RECORDINGS_DIR"] = str(recordings_dir)
    else:
        recordings_dir = get_recordings_dir()

    print(f"Scanning recordings in: {recordings_dir}")

    index = scan_recordings(recordings_dir, dry_run=args.dry_run)
    print_summary(index)

    if not args.dry_run:
        save_index(index)

    return 0


if __name__ == "__main__":
    sys.exit(main())
