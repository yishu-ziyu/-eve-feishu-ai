import json
import requests
import logging

class FeishuBot:
    def __init__(self, app_id: str, app_secret: str):
        self.app_id = app_id
        self.app_secret = app_secret
        self.tenant_access_token = None

    def _get_tenant_access_token(self):
        url = "https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal"
        try:
            resp = requests.post(url, json={
                "app_id": self.app_id,
                "app_secret": self.app_secret
            }, timeout=10)
            resp.raise_for_status()
            data = resp.json()
            if data.get("code") == 0:
                self.tenant_access_token = data.get("tenant_access_token")
                return self.tenant_access_token
        except Exception as e:
            logging.error(f"Failed to get Feishu token: {e}")
        return None

    def send_text_message(self, receive_id: str, content: str, receive_id_type: str = "open_id"):
        token = self._get_tenant_access_token()
        if not token:
            return False

        url = f"https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type={receive_id_type}"
        headers = {
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json; charset=utf-8"
        }
        payload = {
            "receive_id": receive_id,
            "msg_type": "text",
            "content": json.dumps({"text": content}, ensure_ascii=False)
        }
        
        try:
            resp = requests.post(url, headers=headers, json=payload, timeout=10)
            data = resp.json()
            if data.get("code") == 0:
                logging.info("Feishu message sent successfully.")
                return True
            else:
                logging.error(f"Feishu API error: {data}")
        except Exception as e:
            logging.error(f"Failed to send Feishu message: {e}")
        return False

    def send_interactive_card(self, receive_id: str, card_content: dict, receive_id_type: str = "open_id"):
        token = self._get_tenant_access_token()
        if not token:
            return False

        url = f"https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type={receive_id_type}"
        headers = {
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json; charset=utf-8"
        }
        payload = {
            "receive_id": receive_id,
            "msg_type": "interactive",
            "card": json.dumps(card_content, ensure_ascii=False)
        }
        
        try:
            resp = requests.post(url, headers=headers, json=payload, timeout=10)
            return resp.json()
        except Exception as e:
            logging.error(f"Failed to send Feishu card: {e}")
        return None
