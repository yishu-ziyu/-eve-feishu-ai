#!/usr/bin/env python3
from __future__ import annotations

import os
import sys
from pathlib import Path

# Add src to sys.path
ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / "src"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

try:
    from eve.utils.feishu_notify import FeishuBot
except ImportError:
    print("Error: Could not import FeishuBot. Make sure PYTHONPATH includes src/.")
    sys.exit(1)


def _require_env(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        print(f"Missing required environment variable: {name}")
        print("Copy .env.example to .env and fill FEISHU_APP_ID / FEISHU_APP_SECRET / FEISHU_RECEIVE_ID.")
        sys.exit(1)
    return value


def test_feishu_connection():
    app_id = _require_env("FEISHU_APP_ID")
    app_secret = _require_env("FEISHU_APP_SECRET")
    receive_id = _require_env("FEISHU_RECEIVE_ID")

    print("--- Testing Feishu Notification ---")
    print(f"App ID: {app_id}")
    print(f"Target User ID: {receive_id}")

    bot = FeishuBot(app_id, app_secret)

    print("\n[Step 1] Attempting to get tenant_access_token...")
    token = bot._get_tenant_access_token()
    if token:
        print(f"SUCCESS: Token acquired (starts with: {token[:10]}...)")
    else:
        print("FAILURE: Could not get token. Check your App ID and App Secret.")
        return False

    test_message = (
        "🤖 **EVE Test Notification**\n\n"
        "这条消息用于验证 EVE 项目的飞书通知功能是否正常。\n\n"
        f"发送时间: {os.popen('date').read().strip()}\n"
        f"环境: {sys.platform}\n"
        "状态: 链接测试中..."
    )

    print("\n[Step 2] Sending test message...")
    success = bot.send_text_message(receive_id, test_message)

    if success:
        print("SUCCESS: Message sent successfully! Please check your Feishu client.")
    else:
        print("FAILURE: Message sending failed. Check logs for API errors.")
        return False

    print("\n--- Test Completed Successfully ---")
    return True


if __name__ == "__main__":
    if not test_feishu_connection():
        sys.exit(1)
