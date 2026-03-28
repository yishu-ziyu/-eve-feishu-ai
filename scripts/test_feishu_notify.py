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

# Feishu Credentials (extracted from project context)
FEISHU_APP_ID = "cli_a924394c1dfadbef"
FEISHU_APP_SECRET = "REDACTED_FEISHU_APP_SECRET"
FEISHU_RECEIVE_ID = "ou_b72eeedbfc39434b34727810198f4f77"

def test_feishu_connection():
    print(f"--- Testing Feishu Notification ---")
    print(f"App ID: {FEISHU_APP_ID}")
    print(f"Target User ID: {FEISHU_RECEIVE_ID}")
    
    bot = FeishuBot(FEISHU_APP_ID, FEISHU_APP_SECRET)
    
    # Test 1: Get Token
    print("\n[Step 1] Attempting to get tenant_access_token...")
    token = bot._get_tenant_access_token()
    if token:
        print(f"SUCCESS: Token acquired (starts with: {token[:10]}...)")
    else:
        print("FAILURE: Could not get token. Check your App ID and App Secret.")
        return False

    # Test 2: Send Message
    test_message = f"🤖 **EVE Test Notification**\n\n这条消息用于验证 EVE 项目的飞书通知功能是否正常。\n\n发送时间: {os.popen('date').read().strip()}\n环境: {sys.platform}\n状态: 链接测试中..."
    
    print("\n[Step 2] Sending test message...")
    success = bot.send_text_message(FEISHU_RECEIVE_ID, test_message)
    
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
