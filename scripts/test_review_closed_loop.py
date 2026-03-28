#!/usr/bin/env python3
from __future__ import annotations

import argparse
import shutil
import sys
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / "src"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

from eve.review_pipeline import process_recordings
from eve.review_web import app


def _assert(condition: bool, message: str) -> None:
    if not condition:
        raise RuntimeError(message)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Closed-loop test for daily review pipeline + web trigger."
    )
    parser.add_argument(
        "--source-dir",
        required=True,
        help="Source dir containing YYYYMMDD folders with eve json files.",
    )
    parser.add_argument(
        "--date",
        required=True,
        help="Target date in YYYYMMDD.",
    )
    parser.add_argument(
        "--output-dir",
        required=True,
        help="Output dir to write generated daily/jsonl files for this test.",
    )
    return parser


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()

    source_dir = Path(args.source_dir).expanduser().resolve()
    output_dir = Path(args.output_dir).expanduser().resolve()
    date = args.date.strip()

    if output_dir.exists():
        shutil.rmtree(output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    # Step 1: direct pipeline run
    results = process_recordings(
        source_dir=source_dir,
        output_dir=output_dir,
        date=date,
    )
    _assert(len(results) == 1, "Expected exactly one date result from pipeline.")
    row = results[0]
    daily_path = Path(row["daily_md_path"])
    jsonl_path = Path(row["segments_jsonl_path"])
    _assert(daily_path.exists(), f"Missing daily file: {daily_path}")
    _assert(jsonl_path.exists(), f"Missing jsonl file: {jsonl_path}")

    daily_content = daily_path.read_text(encoding="utf-8")
    jsonl_content = jsonl_path.read_text(encoding="utf-8")
    _assert(f"Daily Review {date}" in daily_content, "Daily markdown title mismatch.")
    _assert(len(jsonl_content.strip()) > 0, "JSONL output is empty.")

    # Step 2: web-trigger run
    web_out = output_dir / "web_trigger_output"
    with app.test_client() as client:
        response = client.post(
            "/",
            data={
                "source_dir": str(source_dir),
                "output_dir": str(web_out),
                "date": date,
                "action": "run_custom",
            },
        )
        html = response.get_data(as_text=True)
        _assert(response.status_code == 200, "Web response is not 200.")
        _assert(f"daily_{date}.md" in html, "Web page missing daily file name.")
        _assert(
            f"segments_{date}.jsonl" in html,
            "Web page missing segments jsonl file name.",
        )
        _assert("本次生成结果" in html, "Web result table not rendered.")

    # Step 3: one-click "today" button run
    today = datetime.now().strftime("%Y%m%d")
    today_source = output_dir / "_today_source" / today
    today_source.mkdir(parents=True, exist_ok=True)
    sample_json = source_dir / date
    json_candidates = sorted(sample_json.glob("*.json"))
    _assert(bool(json_candidates), f"No source json found in {sample_json}")
    shutil.copy2(json_candidates[0], today_source / f"eve_live_{today}_120000.json")

    web_today_out = output_dir / "web_today_output"
    with app.test_client() as client:
        response = client.post(
            "/",
            data={
                "source_dir": str(today_source.parent),
                "output_dir": str(web_today_out),
                "date": "",
                "action": "run_today",
            },
        )
        html = response.get_data(as_text=True)
        _assert(response.status_code == 200, "Today-button web response is not 200.")
        _assert(
            f"daily_{today}.md" in html,
            "Today-button web page missing today's daily file name.",
        )
        _assert(
            f"segments_{today}.jsonl" in html,
            "Today-button web page missing today's jsonl file name.",
        )

    print("closed_loop_ok")
    print(f"pipeline_daily={daily_path}")
    print(f"pipeline_jsonl={jsonl_path}")
    print(f"web_output_dir={web_out}")
    print(f"today_button_date={today}")
    print(f"web_today_output_dir={web_today_out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
