#!/bin/bash

# =================================================================
# EVE Daily Review Auto-Scheduler (macOS/Linux)
# This script is triggered by Cron to generate daily review and 
# send notification to Feishu.
# =================================================================

# 1. Define paths (Absolute paths are required for Cron)
PROJECT_DIR="/Users/mahaoxuan/Desktop/AI产品经理/01-项目/eve"
VENV_PYTHON="$PROJECT_DIR/.venv/bin/python3"
SOURCE_DIR="/Users/mahaoxuan/eve_recordings"
LOG_FILE="$PROJECT_DIR/run_artifacts/cron_last_run.log"

# 2. Get today's date in YYYYMMDD format
TODAY=$(date +"%Y%m%d")

echo "--- [$(date)] Starting Auto Review for $TODAY ---" >> "$LOG_FILE"

# 3. Execute the review pipeline with Feishu notification
cd "$PROJECT_DIR" || exit
export PYTHONPATH="$PROJECT_DIR/src"

"$VENV_PYTHON" -m eve.review_pipeline \
    --source-dir "$SOURCE_DIR" \
    --date "$TODAY" \
    --notify >> "$LOG_FILE" 2>&1

echo "--- [$(date)] Finished ---" >> "$LOG_FILE"
