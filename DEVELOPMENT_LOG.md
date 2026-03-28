# Eve 项目开发日志（实时更新）

- 最后更新时间：2026-02-28 08:53:33 +0800
- 当前阶段：Go-Live（可正式使用）
- 当前状态：核心目标已完成，且“日复盘文件自动生成 + 网页按钮触发（含一键今日）”已落地并通过闭环测试

## 一、项目进度总览
- 进度结论：已完成从环境搭建、依赖安装、录音链路验证、ASR 验证到质量评测的全链路闭环。
- 当前可直接使用：是。
- 推荐启动方式：离线本地模型启动（规避 Hugging Face 网络抖动）。
- 复盘自动化能力：已可一键产出
  - `daily_YYYYMMDD.md`（可读复盘）
  - `segments_YYYYMMDD.jsonl`（结构化数据）

## 二、已完成里程碑
1. 环境与依赖
- 仓库已拉取并确认版本：`main@2c744f7`
- 稳定运行环境：`Python 3.12 + uv`
- 依赖安装成功，命令入口可用（`eve --help`）
- 依赖清单已补充 `flask`（用于复盘网页触发界面）
- 锁文件已刷新（`uv.lock`），依赖版本可复现

2. 录音与设备
- 设备枚举可用（`eve --list-devices`）
- 录音链路可用（可稳定生成 `.flac + .json`）

3. ASR 与模型
- `Qwen/Qwen3-ASR-0.6B` 模型本地缓存已完成
- 模型 SHA256 校验通过：
  - `79d6cbd4c98c7bbffe9db2edac07f56cd6637d0d5944b27f6c2b8353840323ea`
- 离线转写端到端成功（`eve transcribe ...`）

4. 质量评测
- 完成真人语音精确评测（中英混读）
- 指标：
  - Overall CER：`1.02%`
  - Chinese CER：`1.68%`
  - English WER：`0.00%`
- 评测报告文件：
  - `run_artifacts/quality_eval_retry_20260224_144641/quality_report.json`

5. 线上稳定性修复
- 识别并修复 `huggingface.co` TLS EOF 抖动影响
- 固化方案：本地 snapshot + 离线模式启动

6. 复盘汇总与网页触发
- 已新增处理模块：`/Users/mahaoxuan/Desktop/eve/src/eve/review_pipeline.py`
- 已新增网页模块：`/Users/mahaoxuan/Desktop/eve/src/eve/review_web.py`
- 已新增可执行脚本：
  - `/Users/mahaoxuan/Desktop/eve/scripts/generate_daily_review.py`
  - `/Users/mahaoxuan/Desktop/eve/scripts/review_web_app.py`
  - `/Users/mahaoxuan/Desktop/eve/scripts/test_review_closed_loop.py`
- 闭环结果：脚本直跑 + 网页按钮触发 + 页面展示均验证通过（`closed_loop_ok`）。
- 回归验证：补齐依赖与刷新锁文件后再次闭环测试，结果仍为 `closed_loop_ok`。
- 网页可用性增强：已支持“生成今日并刷新”单按钮自动取当天日期（`YYYYMMDD`），并默认展示今日日期。
- 运行诊断结论：网页服务代码可用；若“打不开”，通常是服务未保持运行（需前台持续运行进程）。

7. 飞书通知集成 (方案二)
- 已新增通知模块：`src/eve/utils/feishu_notify.py`
- 已集成通知逻辑：`src/eve/review_pipeline.py` 支持 `--notify` 参数。
- Web UI 增强：`review_web.py` 新增“同步发送飞书通知”勾选框。
- 依赖补充：已通过 `uv add requests` 补齐网络请求依赖。

## 三、当前已知事项
- `--total-hours` 在当前版本基本不生效，建议手动 `Ctrl+C` 正常收尾。
- 个别场景会出现 AUHAL 告警（设备层），但主流程可继续运行。
- 建议固定设备并关闭自动切麦以提升稳定性。

## 四、正式运行命令（推荐）
```bash
cd /Users/mahaoxuan/Desktop/eve
source .venv/bin/activate

MODEL_DIR="/Users/mahaoxuan/.cache/huggingface/hub/models--Qwen--Qwen3-ASR-0.6B/snapshots/5eb144179a02acc5e5ba31e748d22b0cf3e303b0"

HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1 \
  eve --device default --no-auto-switch-device \
      --output-dir ~/eve_recordings \
      --segment-minutes 30 \
      --asr-device mps \
      --asr-preload \
      --asr-model "$MODEL_DIR"
```

## 五、下一阶段计划
1. 连续运行稳定性验证（1~3 天）
- 观察是否有中断、设备丢失、空段过多问题

2. 固化日常复盘 SOP
- 形成“日录制 -> 触发汇总脚本 -> 复盘阅读 -> 周汇总”固定流程
- 目标：沉淀可复用的实习/在校复盘资产，并减少手工整理时间

3. 自动化与归档
- 在 `daily_YYYYMMDD.md` 基础上增加关键词、行动项抽取（可选）
- 设定保留策略与备份策略（音频+JSON+每日复盘产物）

## 六、日志更新约定
- 细粒度执行日志：`RUN_SYNC_LOG.md`（逐步动作）
- 阶段性开发日志：`DEVELOPMENT_LOG.md`（里程碑与状态）
- 后续每次推进任务都会同步更新这两份文件。
