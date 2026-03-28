from __future__ import annotations

import argparse
import json
import re
import os
from collections import Counter
from datetime import datetime
from pathlib import Path
from dotenv import load_dotenv

# Load environment variables from .env file
load_dotenv()

from .utils.feishu_notify import FeishuBot
from .utils.sentiment_analyzer import SentimentAnalyzer, get_mood_emoji

DATE_RE = re.compile(r"^\d{8}$")
STAMP_RE = re.compile(r"(\d{8}_\d{6})")
DEFAULT_SOURCE_DIR = Path(os.getenv("EVE_SOURCE_DIR", Path.home() / "eve_recordings")).expanduser()
DEFAULT_OUTPUT_SUBDIR = "_processed"

# Feishu Credentials (Redacted - Loaded from Environment)
FEISHU_APP_ID = os.getenv("FEISHU_APP_ID")
FEISHU_APP_SECRET = os.getenv("FEISHU_APP_SECRET")
FEISHU_RECEIVE_ID = os.getenv("FEISHU_RECEIVE_ID")

# LLM Credentials for Sentiment Analysis (OpenAI Compatible)
LLM_API_KEY = os.getenv("LLM_API_KEY") or os.getenv("STEPFUN_API_KEY")
LLM_BASE_URL = os.getenv("LLM_BASE_URL") or os.getenv("STEPFUN_BASE_URL", "https://api.stepfun.com/v1")
LLM_MODEL = os.getenv("LLM_MODEL") or os.getenv("SENTIMENT_MODEL", "step-3.5-flash")

def _normalize_text(value: object) -> str:
    if value is None:
        return ""
    return re.sub(r"\s+", " ", str(value)).strip()

def _parse_iso(value: object) -> datetime | None:
    if not value:
        return None
    text = str(value).strip()
    if not text:
        return None
    try:
        return datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError:
        return None

def _parse_stamp(value: object) -> datetime | None:
    if not value:
        return None
    text = str(value)
    match = STAMP_RE.search(text)
    if not match:
        return None
    try:
        return datetime.strptime(match.group(1), "%Y%m%d_%H%M%S")
    except ValueError:
        return None

def _read_json(path: Path) -> dict | None:
    try:
        with path.open("r", encoding="utf-8") as handle:
            data = json.load(handle)
    except Exception:
        return None
    if isinstance(data, dict):
        return data
    return None

def _resolve_dates(source_dir: Path, date: str | None) -> list[str]:
    if date:
        if not DATE_RE.fullmatch(date):
            raise ValueError(f"Invalid --date value: {date} (expected YYYYMMDD)")
        date_dir = source_dir / date
        if not date_dir.exists() or not date_dir.is_dir():
            raise ValueError(f"Date directory not found: {date_dir}")
        return [date]

    dates: list[str] = []
    if not source_dir.exists():
        return dates
    for entry in source_dir.iterdir():
        if entry.is_dir() and DATE_RE.fullmatch(entry.name):
            dates.append(entry.name)
    dates.sort()
    return dates

def _segment_time_label(segment: dict) -> str:
    start_iso = segment.get("start_time_iso")
    end_iso = segment.get("end_time_iso")
    if start_iso and end_iso:
        start_dt = _parse_iso(start_iso)
        end_dt = _parse_iso(end_iso)
        if start_dt and end_dt:
            return f"{start_dt.strftime('%H:%M:%S')} ~ {end_dt.strftime('%H:%M:%S')}"

    start_seconds = segment.get("start_seconds")
    end_seconds = segment.get("end_seconds")
    if isinstance(start_seconds, (int, float)) and isinstance(end_seconds, (int, float)):
        return f"{start_seconds:.2f}s ~ {end_seconds:.2f}s"

    segment_start_time = segment.get("segment_start_time")
    parsed = _parse_iso(segment_start_time)
    if parsed:
        return parsed.strftime("%H:%M:%S")

    file_stamp = segment.get("file_stamp")
    parsed_stamp = _parse_stamp(file_stamp)
    if parsed_stamp:
        return parsed_stamp.strftime("%H:%M:%S")
    return "unknown-time"

def _segment_sort_key(segment: dict) -> tuple:
    for key in ("start_time_iso", "segment_start_time", "file_stamp"):
        if key in ("start_time_iso", "segment_start_time"):
            parsed = _parse_iso(segment.get(key))
        else:
            parsed = _parse_stamp(segment.get(key))
        if parsed is not None:
            return (0, parsed.isoformat(), segment.get("source_json", ""), segment.get("segment_index", 0))
    return (1, segment.get("source_json", ""), segment.get("segment_index", 0))

def _extract_segments(payload: dict, json_path: Path, include_empty: bool) -> list[dict]:
    records: list[dict] = []
    base_record = {
        "source_json": str(json_path.resolve()),
        "audio_file": payload.get("audio_file"),
        "audio_path": payload.get("audio_path"),
        "status": payload.get("status"),
        "asr_mode": payload.get("asr_mode"),
        "input_device": payload.get("input_device"),
        "model": payload.get("model"),
        "device": payload.get("device"),
        "dtype": payload.get("dtype"),
        "segment_start_time": payload.get("segment_start_time"),
        "transcribed_at": payload.get("transcribed_at"),
        "file_stamp": json_path.stem,
    }

    segments = payload.get("speech_segments")
    if isinstance(segments, list):
        for index, segment in enumerate(segments):
            if not isinstance(segment, dict):
                continue
            text = _normalize_text(segment.get("text"))
            if not text and not include_empty:
                continue
            records.append(
                {
                    **base_record,
                    "segment_index": index,
                    "language": segment.get("language") or payload.get("language"),
                    "text": text,
                    "start_time_iso": segment.get("start_time_iso"),
                    "end_time_iso": segment.get("end_time_iso"),
                    "start_seconds": segment.get("start_seconds"),
                    "end_seconds": segment.get("end_seconds"),
                }
            )

    # Fallback: if no segment-level text exists, use top-level text.
    if not records:
        top_text = _normalize_text(payload.get("text"))
        if top_text or include_empty:
            records.append(
                {
                    **base_record,
                    "segment_index": 0,
                    "language": payload.get("language"),
                    "text": top_text,
                    "start_time_iso": None,
                    "end_time_iso": None,
                    "start_seconds": None,
                    "end_seconds": None,
                }
            )
    return records

def _write_jsonl(path: Path, records: list[dict]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as handle:
        for record in records:
            handle.write(json.dumps(record, ensure_ascii=False))
            handle.write("\n")

def _write_daily_md(
    path: Path,
    *,
    date: str,
    source_dir: Path,
    status_counter: Counter,
    records: list[dict],
    source_file_count: int,
) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)

    languages = Counter((record.get("language") or "Unknown") for record in records if record.get("text"))
    combined_text = "\n".join(record["text"] for record in records if record.get("text"))
    total_chars = sum(len(record.get("text", "")) for record in records)

    lines: list[str] = []
    lines.append(f"# Daily Review {date}")
    lines.append("")
    lines.append(f"- Generated At: {datetime.now().astimezone().isoformat()}")
    lines.append(f"- Source Dir: `{source_dir}`")
    lines.append(f"- Source JSON Files: {source_file_count}")
    lines.append(f"- Text Segments: {len(records)}")
    lines.append(f"- Total Characters: {total_chars}")
    lines.append(
        "- Status Distribution: "
        + ", ".join(f"{name}={count}" for name, count in sorted(status_counter.items()))
    )
    if languages:
        lines.append(
            "- Language Distribution: "
            + ", ".join(f"{name}={count}" for name, count in sorted(languages.items()))
        )
    lines.append("")
    lines.append("## Timeline")
    lines.append("")
    if not records:
        lines.append("- No text segments found.")
    else:
        for index, record in enumerate(records, start=1):
            label = _segment_time_label(record)
            language = record.get("language") or "Unknown"
            text = record.get("text") or ""
            mood = get_mood_emoji(record.get("sentiment_score", 0)) if "sentiment_score" in record else ""
            lines.append(f"{index}. [{label}] {mood} ({language}) {text}")
    lines.append("")
    lines.append("## Merged Transcript")
    lines.append("")
    lines.append(combined_text or "(empty)")
    lines.append("")

    with path.open("w", encoding="utf-8") as handle:
        handle.write("\n".join(lines))

def send_feishu_notification(item: dict):
    if not all([FEISHU_APP_ID, FEISHU_APP_SECRET, FEISHU_RECEIVE_ID]):
        print("Skipping notification: Feishu credentials not fully configured in .env")
        return

    bot = FeishuBot(FEISHU_APP_ID, FEISHU_APP_SECRET)
    
    # Extract some snippets for the message
    daily_path = Path(item["daily_md_path"])
    content = ""
    if daily_path.exists():
        content = daily_path.read_text(encoding="utf-8")
    
    # Generate Mood Curve Summary
    mood_curve = ""
    if item.get("sentiment_summary"):
        s = item["sentiment_summary"]
        avg_score = s.get("average_score", 0)
        mood_curve = f"\n🌈 **今日心情指数：** {get_mood_emoji(avg_score)} (得分: {avg_score:.2f})\n"
        if "labels" in s:
            counts = Counter(s["labels"])
            mood_curve += f"- 积极 🟢: {counts.get('Positive', 0)}\n- 中性 🟡: {counts.get('Neutral', 0)}\n- 消极 🔴: {counts.get('Negative', 0)}\n"
    
    # Get top 5 lines of timeline as a preview
    timeline_lines = []
    in_timeline = False
    for line in content.splitlines():
        if line.startswith("## Timeline"):
            in_timeline = True
            continue
        if in_timeline and line.startswith("##"):
            break
        if in_timeline and line.strip() and not line.startswith("-"):
            timeline_lines.append(line)
            if len(timeline_lines) >= 5:
                break
    
    preview = "\n".join(timeline_lines)
    
    message = (
        f"📅 **Eve Daily Review - {item['date']}**\n\n"
        f"📊 **统计信息：**\n"
        f"- 源文件数：{item['source_file_count']}\n"
        f"- 转写段数：{item['segment_count']}\n"
        f"- 状态分布：{item['status_distribution']}\n"
        f"{mood_curve}\n"
        f"📝 **今日预览：**\n"
        f"{preview}\n\n"
        f"📂 **本地路径：**\n"
        f"`{item['daily_md_path']}`"
    )
    
    bot.send_text_message(FEISHU_RECEIVE_ID, message)

def analyze_sentiments_for_records(records: list[dict]):
    if not LLM_API_KEY:
        print("Skipping sentiment analysis: LLM_API_KEY not configured in .env")
        return {}

    analyzer = SentimentAnalyzer(LLM_API_KEY, LLM_BASE_URL, LLM_MODEL)
    
    scores = []
    labels = []
    
    # Process in batches of 10 segments
    batch_size = 10
    for i in range(0, len(records), batch_size):
        batch = records[i:i+batch_size]
        batch_text = " ".join([r.get("text", "") for r in batch if r.get("text")])
        if not batch_text.strip():
            continue
            
        res = analyzer.analyze(batch_text)
        score = res.get("score", 0.0)
        label = res.get("label", "Neutral")
        
        for r in batch:
            r["sentiment_score"] = score
            r["sentiment_label"] = label
        
        scores.append(score)
        labels.append(label)
        
    return {
        "average_score": sum(scores) / len(scores) if scores else 0.0,
        "labels": labels
    }

def process_date(
    *,
    source_dir: Path,
    output_dir: Path,
    date: str,
    include_empty: bool = False,
    notify: bool = False,
    analyze_sentiment: bool = True,
) -> dict:
    date_dir = source_dir / date
    json_files = sorted(date_dir.glob("*.json"))
    status_counter: Counter = Counter()
    segment_records: list[dict] = []

    for json_file in json_files:
        payload = _read_json(json_file)
        if payload is None:
            continue
        status_counter[str(payload.get("status") or "unknown")] += 1
        segments = _extract_segments(payload, json_file, include_empty=include_empty)
        for segment in segments:
            if segment.get("text") or include_empty:
                segment["date"] = date
                segment_records.append(segment)

    segment_records.sort(key=_segment_sort_key)

    sentiment_summary = {}
    if analyze_sentiment and segment_records:
        try:
            sentiment_summary = analyze_sentiments_for_records(segment_records)
        except Exception as e:
            print(f"Sentiment analysis failed: {e}")

    daily_md_path = output_dir / f"daily_{date}.md"
    segments_jsonl_path = output_dir / f"segments_{date}.jsonl"
    
    # We write AFTER sentiment analysis so results are included
    _write_jsonl(segments_jsonl_path, segment_records)
    _write_daily_md(
        daily_md_path,
        date=date,
        source_dir=date_dir,
        status_counter=status_counter,
        records=segment_records,
        source_file_count=len(json_files),
    )

    result = {
        "date": date,
        "source_dir": str(date_dir.resolve()),
        "source_file_count": len(json_files),
        "segment_count": len(segment_records),
        "status_distribution": dict(status_counter),
        "daily_md_path": str(daily_md_path.resolve()),
        "segments_jsonl_path": str(segments_jsonl_path.resolve()),
        "sentiment_summary": sentiment_summary,
    }

    if notify:
        try:
            send_feishu_notification(result)
        except Exception as e:
            print(f"Failed to send Feishu notification: {e}")

    return result

def process_recordings(
    *,
    source_dir: str | Path | None = None,
    output_dir: str | Path | None = None,
    date: str | None = None,
    include_empty: bool = False,
    notify: bool = False,
    analyze_sentiment: bool = True,
) -> list[dict]:
    resolved_source = Path(source_dir or DEFAULT_SOURCE_DIR).expanduser().resolve()
    resolved_output = (
        Path(output_dir).expanduser().resolve()
        if output_dir
        else (resolved_source / DEFAULT_OUTPUT_SUBDIR).resolve()
    )
    dates = _resolve_dates(resolved_source, date)
    results: list[dict] = []
    for current_date in dates:
        results.append(
            process_date(
                source_dir=resolved_source,
                output_dir=resolved_output,
                date=current_date,
                include_empty=include_empty,
                notify=notify,
                analyze_sentiment=analyze_sentiment,
            )
        )
    return results

def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description=(
            "Build daily readable review files and structured JSONL segments "
            "from eve transcript JSON outputs."
        )
    )
    parser.add_argument(
        "--source-dir",
        default=str(DEFAULT_SOURCE_DIR),
        help="Directory containing date folders (YYYYMMDD) with eve JSON files.",
    )
    parser.add_argument(
        "--output-dir",
        default="",
        help="Directory to write daily_YYYYMMDD.md and segments_YYYYMMDD.jsonl "
        "(default: <source-dir>/_processed).",
    )
    parser.add_argument(
        "--date",
        default="",
        help="Only process a specific date (YYYYMMDD).",
    )
    parser.add_argument(
        "--include-empty",
        action="store_true",
        help="Include empty-text records in JSONL output.",
    )
    parser.add_argument(
        "--notify",
        action="store_true",
        help="Send summary notification to Feishu.",
    )
    parser.add_argument(
        "--no-sentiment",
        action="store_false",
        dest="analyze_sentiment",
        help="Disable sentiment analysis.",
    )
    return parser

def main() -> int:
    parser = build_parser()
    args = parser.parse_args()
    results = process_recordings(
        source_dir=args.source_dir,
        output_dir=args.output_dir or None,
        date=args.date or None,
        include_empty=args.include_empty,
        notify=args.notify,
        analyze_sentiment=args.analyze_sentiment,
    )
    if not results:
        print("No valid date folders found, nothing generated.")
        return 0

    for item in results:
        print(
            f"[{item['date']}] "
            f"source_json={item['source_file_count']} "
            f"segments={item['segment_count']}\n"
            f"  md: {item['daily_md_path']}\n"
            f"  jsonl: {item['segments_jsonl_path']}"
        )
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
