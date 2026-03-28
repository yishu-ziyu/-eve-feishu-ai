import json
import requests
import logging

class SentimentAnalyzer:
    def __init__(self, api_key: str, base_url: str, model: str):
        self.api_key = api_key
        self.base_url = base_url
        self.model = model

    def analyze(self, text: str) -> dict:
        """
        Analyzes the sentiment of a given text.
        Returns a dict with 'score' (-1 to 1) and 'label' (Positive, Neutral, Negative).
        """
        if not text.strip():
            return {"score": 0.0, "label": "Neutral"}

        payload = {
            "model": self.model,
            "messages": [
                {
                    "role": "system",
                    "content": "你是一个情感分析助手。请对用户提供的文本进行情感极性评估。返回 JSON 格式：{\"score\": 浮点数(-1.0 到 1.0), \"label\": \"Positive\"|\"Neutral\"|\"Negative\"}"
                },
                {"role": "user", "content": text}
            ],
            "response_format": {"type": "json_object"},
            "temperature": 0.1
        }
        
        headers = {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json"
        }
        
        try:
            # Note: /chat/completions is usually appended to base_url if not present
            url = self.base_url.rstrip("/") + "/chat/completions"
            resp = requests.post(url, headers=headers, json=payload, timeout=5)
            resp.raise_for_status()
            data = resp.json()
            content = data["choices"][0]["message"]["content"]
            return json.loads(content)
        except Exception as e:
            logging.error(f"Sentiment analysis failed: {e}")
            return {"score": 0.0, "label": "Error"}

def get_mood_emoji(score: float) -> str:
    if score > 0.3: return "🟢"
    if score < -0.3: return "🔴"
    return "🟡"
