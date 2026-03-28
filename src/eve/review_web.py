from __future__ import annotations

import argparse
from datetime import datetime
from pathlib import Path

from flask import Flask, render_template_string, request

from .review_pipeline import DEFAULT_SOURCE_DIR, process_recordings

app = Flask(__name__)

TEMPLATE = """
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Eve Daily Review Builder</title>
  <style>
    body {
      margin: 0;
      font-family: "SF Pro Text", "PingFang SC", "Noto Sans CJK SC", sans-serif;
      background: linear-gradient(135deg, #f4f8ff 0%, #f8fcf8 100%);
      color: #1e2b35;
    }
    .wrap {
      max-width: 1080px;
      margin: 28px auto;
      padding: 0 16px 32px;
    }
    .card {
      background: #ffffff;
      border-radius: 14px;
      box-shadow: 0 8px 24px rgba(15, 35, 60, 0.08);
      padding: 18px;
      margin-bottom: 16px;
    }
    h1 {
      margin: 0 0 14px;
      font-size: 24px;
    }
    .muted {
      color: #6b7c8b;
      font-size: 14px;
    }
    form {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
      gap: 12px;
      align-items: end;
    }
    label {
      font-size: 13px;
      color: #4b5b69;
      display: block;
      margin-bottom: 4px;
    }
    input {
      width: 100%;
      box-sizing: border-box;
      border: 1px solid #d8e2ec;
      border-radius: 8px;
      padding: 10px 11px;
      font-size: 14px;
      background: #fefefe;
    }
    button {
      border: 0;
      border-radius: 10px;
      padding: 11px 14px;
      color: #fff;
      background: linear-gradient(135deg, #1779d7 0%, #0f5fb0 100%);
      font-weight: 600;
      cursor: pointer;
    }
    .actions {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
    }
    .btn-secondary {
      background: linear-gradient(135deg, #2a9d6f 0%, #1e7e58 100%);
    }
    .error {
      background: #fff5f5;
      color: #8f2d2d;
      border: 1px solid #f4c7c7;
      border-radius: 10px;
      padding: 10px 12px;
      margin-top: 12px;
      white-space: pre-wrap;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      font-size: 14px;
    }
    th, td {
      border-bottom: 1px solid #edf2f7;
      text-align: left;
      padding: 8px 6px;
      vertical-align: top;
    }
    pre {
      margin: 0;
      white-space: pre-wrap;
      word-wrap: break-word;
      max-height: 360px;
      overflow: auto;
      background: #f7fafc;
      border: 1px solid #e5edf4;
      border-radius: 10px;
      padding: 10px;
      font-size: 13px;
      line-height: 1.5;
    }
    .grid2 {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 12px;
    }
    @media (max-width: 900px) {
      .grid2 {
        grid-template-columns: 1fr;
      }
    }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="card">
      <h1>Eve Daily Review Builder</h1>
      <div class="muted">点击按钮触发脚本，生成并展示 daily_YYYYMMDD.md 与 segments_YYYYMMDD.jsonl。</div>
      <form method="post">
        <div>
          <label>Source Dir</label>
          <input name="source_dir" value="{{ source_dir }}" />
        </div>
        <div>
          <label>Output Dir (optional)</label>
          <input name="output_dir" value="{{ output_dir }}" />
        </div>
        <div>
          <label>Date (YYYYMMDD, optional)</label>
          <input name="date" value="{{ date }}" />
        </div>
        <div>
          <label><input type="checkbox" name="notify" style="width:auto" checked /> 同步发送飞书通知</label>
          <div class="actions">
            <button type="submit" name="action" value="run_today">生成今日并刷新</button>
            <button type="submit" name="action" value="run_custom" class="btn-secondary">按填写条件生成</button>
          </div>
        </div>
      </form>
      {% if error %}
      <div class="error">{{ error }}</div>
      {% endif %}
    </div>

    {% if results %}
    <div class="card">
      <h2>本次生成结果</h2>
      <table>
        <thead>
          <tr>
            <th>Date</th>
            <th>Source JSON</th>
            <th>Text Segments</th>
            <th>Daily MD</th>
            <th>Segments JSONL</th>
          </tr>
        </thead>
        <tbody>
          {% for row in results %}
          <tr>
            <td>{{ row.date }}</td>
            <td>{{ row.source_file_count }}</td>
            <td>{{ row.segment_count }}</td>
            <td><code>{{ row.daily_md_path }}</code></td>
            <td><code>{{ row.segments_jsonl_path }}</code></td>
          </tr>
          {% endfor %}
        </tbody>
      </table>
    </div>
    {% endif %}

    {% if selected %}
    <div class="grid2">
      <div class="card">
        <h3>{{ selected.daily_name }}</h3>
        <pre>{{ selected.daily_content }}</pre>
      </div>
      <div class="card">
        <h3>{{ selected.segments_name }}</h3>
        <pre>{{ selected.segments_content }}</pre>
      </div>
    </div>
    {% endif %}
  </div>
</body>
</html>
"""


def _read_text(path: str) -> str:
    file_path = Path(path)
    if not file_path.exists():
        return ""
    return file_path.read_text(encoding="utf-8")


def _today_date_str() -> str:
    return datetime.now().strftime("%Y%m%d")


@app.route("/", methods=["GET", "POST"])
def index():
    source_dir = request.values.get("source_dir", str(DEFAULT_SOURCE_DIR))
    output_dir = request.values.get("output_dir", "")
    input_date = request.values.get("date", "").strip()
    action = request.values.get("action", "")
    notify = request.values.get("notify") == "on"
    today = _today_date_str()
    date = input_date or today

    results = []
    selected = None
    error = ""

    if request.method == "POST":
        target_date = today if action == "run_today" else (input_date or None)
        date = today if action == "run_today" else input_date
        try:
            results = process_recordings(
                source_dir=source_dir,
                output_dir=output_dir or None,
                date=target_date,
                notify=notify,
            )
            if results:
                selected_row = results[-1]
                daily_path = selected_row["daily_md_path"]
                jsonl_path = selected_row["segments_jsonl_path"]
                selected = {
                    "daily_name": Path(daily_path).name,
                    "segments_name": Path(jsonl_path).name,
                    "daily_content": _read_text(daily_path),
                    "segments_content": _read_text(jsonl_path),
                }
        except Exception as exc:
            error = str(exc)

    return render_template_string(
        TEMPLATE,
        source_dir=source_dir,
        output_dir=output_dir,
        date=date,
        results=results,
        selected=selected,
        error=error,
    )


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Run a local web UI to trigger and view eve daily review outputs."
    )
    parser.add_argument("--host", default="127.0.0.1", help="Bind host.")
    parser.add_argument("--port", type=int, default=8765, help="Bind port.")
    parser.add_argument(
        "--debug",
        action="store_true",
        help="Enable Flask debug mode.",
    )
    return parser


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()
    app.run(host=args.host, port=args.port, debug=args.debug)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
