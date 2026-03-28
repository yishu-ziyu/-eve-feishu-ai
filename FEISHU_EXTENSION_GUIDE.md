# EVE 增强版使用指南 (Feishu & AI Edition)

本项目基于 `nexmoe/eve` 进行了深度定制，增加了 **飞书自动化推送**、**AI 情感画像** 以及 **无人值守定时复盘** 功能。

## 🌟 核心新功能

1.  **飞书机器人实时通知**：复盘生成后，机器人自动将统计摘要、今日 Timeline 预览、本地文件路径发送到你的飞书。
2.  **今日心情曲线 (Mood Curve)**：利用大模型 (LLM) 对转写文本进行情感审计，自动计算并展示一天的情绪分布。
3.  **全自动复盘流程**：支持通过 Cron 任务实现每天定时自动扫描录音、分析、推送，完全解放双手。

## 🛠 快速开始

### 1. 安装额外依赖
本版本引入了 `requests` 和 `python-dotenv`：
```bash
uv add requests python-dotenv
```

### 2. 配置环境变量
复制项目根目录下的 `.env.example` 为 `.env`，并填写以下信息：
*   **Feishu**: 在飞书开放平台创建一个“企业自建应用”，获取 `APP_ID` 和 `APP_SECRET`。
*   **LLM (OpenAI 兼容)**: 
    *   你可以自由选择 LLM 供应商，只需支持 OpenAI 接口格式即可。
    *   **推荐方案**：
        *   **DeepSeek**: `LLM_BASE_URL=https://api.deepseek.com/v1`, `LLM_MODEL=deepseek-chat`
        *   **阶跃星辰**: `LLM_BASE_URL=https://api.stepfun.com/v1`, `LLM_MODEL=step-1.5-flash`
        *   **豆包**: `LLM_BASE_URL=https://ark.cn-beijing.volces.com/api/v3`
*   **Receive ID**: 你的飞书 Open ID。

### 3. 使用 Web UI 触发
启动网页界面：
```bash
python -m eve.review_web
```
在网页中勾选 **“同步发送飞书通知”** 后点击生成。

### 4. 设置定时自动推送 (macOS/Linux)
如果你希望每天固定时间（如晚上 7 点）收到复盘：
1. 修改 `scripts/auto_daily_review.sh` 中的绝对路径为你的本地路径。
2. 添加 Cron 任务：
   ```bash
   (crontab -l 2>/dev/null; echo "0 19 * * * /你的路径/scripts/auto_daily_review.sh") | crontab -
   ```

## 📄 开发者说明
本项目的核心逻辑修改集中在：
- `src/eve/review_pipeline.py`: 集成了情感分析与通知触发。
- `src/eve/utils/feishu_notify.py`: 飞书 API 封装。
- `src/eve/utils/sentiment_analyzer.py`: LLM 推理封装。
