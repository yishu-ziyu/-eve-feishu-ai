# Eve 项目实操同步日志

> 目标：在本机完整跑通 `nexmoe/eve`，并持续记录每一步用于复盘。
> 日志规则：每执行一个关键步骤，立即追加记录（时间、命令、结果、下一步）。

## [2026-02-22 23:28:44 +0800] Step 1: 建立同步日志
- 动作：创建本日志文件并初始化记录规范。
- 结果：完成。
- 下一步：检查仓库与运行环境状态。

## [2026-02-22 23:28:59 +0800] Step 2: 记录当前环境与仓库状态
- 仓库分支/提交：main @ 2c744f7
- Git 工作区：仅新增日志文件 `RUN_SYNC_LOG.md`
- 运行时：Python 3.14.2 / Python 3.12.12 / uv 0.9.21
- 现有虚拟环境：`.venv`、`.venv314`
- 下一步：用 Python 3.12 执行 `uv sync`（官方锁文件兼容路径）。

## [2026-02-22 23:29:48 +0800] Step 3: 安装依赖（Python 3.12 路径）
- 命令：`uv sync --python 3.12`
- 说明：日志写入时发生 shell 反引号替换，意外触发了该命令；已接管并确认结果。
- 结果：安装成功，`.venv` 内安装 101 个包（含 `torch 2.9.1`、`onnxruntime 1.23.2`、`qwen-asr 0.0.6`）。
- 下一步：验证命令入口与设备枚举（`eve --help`、`eve --list-devices`）。
## [2026-02-22 23:30:12 +0800] Step 4: 命令入口与设备枚举验证
- 命令：`source .venv/bin/activate && eve --help && eve --list-devices`
- 结果：命令入口可用，参数列表正常输出。
- 设备枚举：检测到输入设备 `0 FIIL GS`、`2 MacBook Air麦克风`（另有对应输出设备）。
- 下一步：进行短时录音实跑（先关闭 ASR，验证录音链路与文件落盘）。

## [2026-02-22 23:33:08 +0800] Step 5: 录音链路实跑（关闭 ASR）
- 命令：`eve --disable-asr --device 2 --output-dir run_artifacts/smoke_record_20260222_233026 --segment-minutes 0.2 --no-console-feedback`
- 控制：尝试发送 `SIGINT` 结束，进程未立即退出，最终用 `SIGTERM` 停止（退出码 `143`）。
- 产物：生成目录 `run_artifacts/smoke_record_20260222_233026/20260222/`，包含 `11` 组 `.flac + .json`。
- 校验：JSON 中 `asr_mode=disabled`、`asr_enabled=false`、`input_device=2:MacBook Air麦克风`，录音流程与落盘正常。
- 观察：在无语音场景下，段状态为 `no_speech`，对应 FLAC 可为 0 字节（符合 VAD 仅保留语音策略）。
- 下一步：执行离线转写 `eve transcribe`，验证 ASR 端到端可用性。

## [2026-02-22 23:33:32 +0800] Step 6: 构造 ASR 测试音频
- 目的：生成明确有人声的 WAV 文件，用于离线转写验证。
- 命令：`say` 生成 `sample.aiff`，`afconvert` 转为 `sample.wav`（16kHz）。
- 产物：`run_artifacts/asr_input_20260222_233323/sample.wav`（约 129KB）。
- 下一步：执行 `eve transcribe --limit 1 --force --asr-device mps --asr-preload`。

## [2026-02-22 23:39:15 +0800] Step 7: 首次离线转写尝试（失败，定位到模型下载通道问题）
- 命令：`eve transcribe --input-dir run_artifacts/asr_input_20260222_233323 --limit 1 --force --asr-device mps --asr-preload`
- 现象：日志停在 `Loading ASR model...`，进程持续运行 5 分钟未完成，最终人工终止（退出码 `143`）。
- 证据：`~/.cache/huggingface/xet/logs/...` 出现多次 `tls handshake eof` 重试；怀疑 Xet 下载通道在当前网络链路不稳定。
- 处理：保留现场日志 `run_artifacts/asr_input_20260222_233323/transcribe.log`。
- 下一步：设置 `HF_HUB_DISABLE_XET=1` 关闭 Xet 后重试转写。

## [2026-02-22 23:40:15 +0800] Step 8: 二次离线转写尝试（失败，定位为模型文件损坏）
- 命令：`HF_HUB_DISABLE_XET=1 eve transcribe --input-dir run_artifacts/asr_input_20260222_233323 --limit 1 --force --asr-device mps --asr-preload`
- 结果：快速失败（退出码 `1`）。
- 关键报错：`safetensors_rust.SafetensorError: invalid JSON in header`。
- 校验：模型 blob 文件哈希不匹配（文件名期望 `79d6...323ea`，实测 SHA256 为 `684e...214c`），确认下载内容损坏。
- 下一步：删除损坏模型文件并重新下载后再转写。

## [2026-02-22 23:49:51 +0800] Step 9: 三次离线转写尝试（关闭 Xet + 全新下载）
- 命令：`HF_HUB_DISABLE_XET=1 eve transcribe --input-dir run_artifacts/asr_input_20260222_233323 --limit 1 --force --asr-device mps --asr-preload`
- 结果：运行约 `3m13s` 后人工终止（退出码 `143`），日志仍停在 `Loading ASR model...`。
- 诊断：该通道下载速度过慢，短时内无法完成 1.88GB 权重下载，不适合本次实时验证。
- 下一步：改用 `huggingface_hub` 直接下载并校验哈希。

## [2026-02-22 23:49:51 +0800] Step 10: 直接下载模型并校验（失败，文件仍损坏）
- 命令：`python -c "from huggingface_hub import hf_hub_download; ..."`
- 现象：下载过程会生成 `model.safetensors.incomplete`，最终可到达完整尺寸 `1,876,091,704 bytes`，但哈希校验失败。
- 哈希结果：期望 `79d6...323ea`，实测 `58d6...7f015`（错误）。
- 结论：当前网络链路下，Qwen 模型权重下载会发生内容损坏，导致 ASR 无法成功加载。
- 处理：已清理损坏文件，避免污染后续重试。

## [2026-02-22 23:51:38 +0800] Step 11: 离线转写命令通路补测（受同一模型下载问题阻塞）
- 命令：`eve transcribe --input-dir run_artifacts/smoke_record_20260222_233026 --limit 1 --force --asr-device mps`
- 现象：命令能进入 `Transcribing ...`，但随后再次受模型加载阻塞，人工终止（退出码 `143`）。
- 结论：CLI 与文件扫描流程可达，当前唯一硬阻塞仍是 Qwen 模型权重下载/校验失败。
- 下一步：保持录音链路可用；待网络链路稳定后重跑 ASR 步骤。

## [2026-02-23 00:03:03 +0800] Step 12: 按“网络改善”条件重试 ASR
- 触发：用户反馈当前网络更稳定。
- 计划：清理旧模型缓存 -> 重新下载并做 SHA256 校验 -> 再执行离线转写。
- 下一步：移除 `Qwen/Qwen3-ASR-0.6B` 旧缓存，避免脏文件影响。

## [2026-02-23 00:12:43 +0800] Step 13: 模型下载与完整性校验（成功）
- 命令：`HF_HUB_DISABLE_XET=1 python -c "hf_hub_download + sha256 校验（最多重试 3 次）"`
- 结果：首次下载完成并校验通过。
- 校验值：`79d6cbd4c98c7bbffe9db2edac07f56cd6637d0d5944b27f6c2b8353840323ea`（与期望一致）。
- 结论：模型缓存恢复为可用状态，可进入实际 ASR 推理。
- 下一步：执行离线转写，验证端到端结果。

## [2026-02-23 00:12:43 +0800] Step 14: 离线转写端到端验证（成功）
- 命令：`eve transcribe --input-dir run_artifacts/asr_input_20260222_233323 --limit 1 --force --asr-device mps --asr-preload`
- 结果：退出码 `0`，转写完成。
- 输出文件：`run_artifacts/asr_input_20260222_233323/sample.json`
- 输出摘要：`status=ok`、`language=Chinese`、`device=mps`、`dtype=float16`、`asr_mode=offline`。
- 文本结果：`你好，这是一个项目的转写测试。Hello, my hero son.`
- 备注：模型已稳定可用，后续可直接执行实时录音+转写任务。

## [2026-02-23 00:13:46 +0800] Step 15: 实时录音+ASR 主流程烟测（成功启动）
- 命令：`eve --device 2 --output-dir run_artifacts/live_asr_smoke_20260223_001259 --segment-minutes 0.2 --asr-device mps --asr-preload --no-console-feedback`
- 结果：流程成功完成模型预加载并进入录音；短时运行后人工停止（退出码 `143`）。
- 日志关键行：`Loading ASR model...` -> `Starting recording...`
- 产物：生成 `eve_live_20260223_001318.flac/.json`。
- JSON 关键字段：`asr_mode=live`、`asr_enabled=true`、`device=mps`、`dtype=float16`、`input_device=2:MacBook Air麦克风`。
- 备注：本次为非交互强停，`status` 保持 `recording`；正式使用建议在前台 `Ctrl+C` 结束以触发完整收尾。

## [2026-02-23 13:39:46 +0800] Step 16: 交付使用手册
- 触发：用户询问“这个项目怎么用”。
- 动作：整理可直接执行的本机使用流程（实时转写、仅录音、离线转写、注意事项）。
- 下一步：按用户选择进入长期运行或继续自动化。

## [2026-02-23 13:48:33 +0800] Step 17: 模型缓存复核与复用结论
- 触发：用户确认后续是否还需要重复下载模型。
- 校验：本地模型文件存在且哈希正确。
- 路径：`~/.cache/huggingface/hub/models--Qwen--Qwen3-ASR-0.6B/blobs/79d6...323ea`
- 哈希：`79d6cbd4c98c7bbffe9db2edac07f56cd6637d0d5944b27f6c2b8353840323ea`
- 结论：后续可直接本地复用，不需要再次下载大模型（除非缓存被清理或更换模型）。

## [2026-02-23 13:50:46 +0800] Step 18: 阶段复盘与后续计划
- 触发：用户要求复盘已完成工作，并规划未来工作。
- 复盘要点：
  - 已确认项目在本机可运行，安装路径稳定（Python 3.12 + uv）。
  - 已完成设备枚举、录音链路验证、离线 ASR 端到端验证、实时 ASR 启动验证。
  - 已修复关键阻塞：模型下载损坏问题（通过缓存清理 + 重下 + SHA256 校验解决）。
- 计划方向：进入“可用性优化 + 运营化使用”阶段（稳定运行、质量评估、自动化归档）。

## [2026-02-24 14:29:49 +0800] Step 19: 启动“真实前台录音+收尾+质量检查”任务
- 目标：执行一次前台实时录音（含 ASR），随后正常收尾并评估转写质量。
- 录制策略：`segment-minutes=0.5`，前台运行约 90 秒后发送 `Ctrl+C`，确保触发收尾逻辑。
- 下一步：开始前台录制，请用户现场说话（中英混合）。

## [2026-02-24 14:32:17 +0800] Step 20: 第一轮真实前台录音结果与质量检查
- 运行参数：`eve --device 2 --output-dir run_artifacts/live_real_20260224_142958 --segment-minutes 0.5 --asr-device mps --asr-preload --no-console-feedback`
- 收尾：前台 `Ctrl+C` 正常停止（退出码 `0`）。
- 产物：3 组 `.flac + .json`。
- 质量检查：`status` 全部为 `no_speech`，无文本输出；对应 FLAC 均为 0 字节。
- 结论：本轮未采到有效语音（可能是现场静音、说话距离/音量不足或输入设备不匹配）。
- 下一步：补跑一轮（默认设备 + 现场测试语音），复核转写质量。

## [2026-02-24 14:34:19 +0800] Step 21: 第二轮补测（默认设备 + 测试语音）与质量结果
- 运行参数：`eve --output-dir run_artifacts/live_real_retry_20260224_143226 --segment-minutes 0.5 --asr-device mps --asr-preload --no-console-feedback`
- 录制中动作：播放中英测试语音（`say`）以确保输入中存在可识别语音。
- 收尾：前台 `Ctrl+C` 正常停止（退出码 `0`）。
- 运行告警：出现 AUHAL 设备告警（`Invalid Property Value`），但流程未中断。
- 产物：3 组 `.flac + .json`。
- 质量检查：
  - 状态分布：`ok=1`，`no_speech=2`。
  - 有效转写：`eve_live_20260224_143244.json` -> `你好，你好，你好。`
  - 对应音频：`eve_live_20260224_143244.flac` 大小 `16641 bytes`，时长约 `1.024s`。
- 结论：实时录音+ASR链路可产出有效文本；当前采音覆盖率偏低，需要在正式使用中提高有效说话段占比。

## [2026-02-24 14:45:39 +0800] Step 22: 启动 1 分钟真人语音精确评测
- 目标：产出可量化指标（CER/英文字级WER），评估中英混合转写质量。
- 方案：前台录音 75 秒（用户朗读标准参考文本） -> 离线转写 -> 指标计算。
- 参考文本：已在会话中提供，要求尽量逐字朗读。
- 下一步：开始录音并在时长到达后正常 `Ctrl+C` 收尾。

## [2026-02-24 14:46:36 +0800] Step 23: 第一次评测录音中断与修正
- 异常：`--device 2` 返回 `Microphone unavailable (Error querying device 2)`。
- 处理：立即前台 `Ctrl+C` 停止，避免空采样。
- 修正：改用 `default` 设备并重录（保持禁用自动切麦，固定当前默认输入）。
- 下一步：启动重录，时长提高到约 85 秒，覆盖完整朗读文本。

## [2026-02-24 14:50:16 +0800] Step 24: 1 分钟真人语音精确质量评测结果
- 录音目录：`run_artifacts/quality_eval_retry_20260224_144641`
- 录音有效性：生成 1 个非空 FLAC（约 `34.656s`，`497029 bytes`）。
- 转写命令：`eve transcribe --input-dir run_artifacts/quality_eval_retry_20260224_144641 --force --asr-device mps --asr-preload`
- 转写结果：退出码 `0`，文本完整覆盖参考内容（coverage ratio = `1.0`）。
- 量化指标（对标准参考文本）
  - Overall CER: `1.02%`（2 substitutions, 0 deletions, 0 insertions）
  - Chinese CER: `1.68%`（2 substitutions, 0 deletions, 0 insertions）
  - English WER: `0.00%`（0 substitutions, 0 deletions, 0 insertions）
- 差异明细：`效果` 被识别为 `质量`（2 个中文字符替换）。
- 报告文件：`run_artifacts/quality_eval_retry_20260224_144641/quality_report.json`
- 结论：本机当前配置下，项目对中英混读场景可达到高可用转写质量。

## [2026-02-24 14:53:12 +0800] Step 25: Go-Live 结论与长期使用建议
- 结论：可以正式开启项目用于长期记录与复盘。
- 依据：已通过安装、录音链路、离线 ASR、实时 ASR、量化质量评测。
- 建议运行方式：固定设备 + 关闭自动切麦 + 前台 `Ctrl+C` 正常收尾。
- 风险控制：关注磁盘增长、定期备份 `recordings/` 与 JSON。

## [2026-02-24 14:58:22 +0800] Step 26: TLS 抖动问题修复（离线本地模型启动）
- 问题：运行时对 `huggingface.co` 的 HEAD 请求反复 `SSL EOF` 重试。
- 根因：启动时默认模型 ID 路径会触发在线检查，网络抖动导致失败。
- 修复：切换为本地 snapshot 路径 + 离线环境变量（`HF_HUB_OFFLINE=1`、`TRANSFORMERS_OFFLINE=1`）。
- 验证：离线启动烟测通过，日志从 `Loading ASR model...` 到 `Starting recording...`（约 4 秒）。
- 建议：正式长期运行统一使用离线启动命令，避免网络波动影响。

## [2026-02-27 22:20:59 +0800] Step 27: 建立并启用开发日志总表（实时同步）
- 新增文件：`DEVELOPMENT_LOG.md`
- 作用：沉淀“当前阶段、里程碑、风险、下一步计划”的结构化状态。
- 与执行日志关系：
  - `RUN_SYNC_LOG.md`：记录每一步动作细节。
  - `DEVELOPMENT_LOG.md`：记录阶段性状态与管理视图。
- 约定：后续每次推进任务同步更新两份日志。

## [2026-02-27 22:28:11 +0800] Step 28: 说明文件存储结构与处理建议
- 触发：用户询问录制文件最终存储形式及后处理推荐方式。
- 动作：基于本地真实样例说明音频/JSON结构、字段含义与推荐数据处理管道。
- 下一步：按用户选择，落地自动化处理脚本（汇总、检索、周复盘）。


## [2026-02-27 23:05:53 +0800] Step 29: 落地复盘汇总脚本与网页触发能力
- 新增后端处理模块：`/Users/mahaoxuan/Desktop/eve/src/eve/review_pipeline.py`
  - 功能：按日期扫描 `YYYYMMDD` 目录，提取转写片段，生成
    - `daily_YYYYMMDD.md`（可读复盘）
    - `segments_YYYYMMDD.jsonl`（结构化数据）
- 新增网页触发模块：`/Users/mahaoxuan/Desktop/eve/src/eve/review_web.py`
  - 功能：本地网页按钮触发生成流程，并在页面展示两类产物内容。
- 新增可执行脚本：
  - `/Users/mahaoxuan/Desktop/eve/scripts/generate_daily_review.py`
  - `/Users/mahaoxuan/Desktop/eve/scripts/review_web_app.py`
  - `/Users/mahaoxuan/Desktop/eve/scripts/test_review_closed_loop.py`

## [2026-02-27 23:05:53 +0800] Step 30: 完成闭环测试（脚本 + 网页按钮）
- 测试数据源：`/Users/mahaoxuan/Desktop/eve/run_artifacts/quality_eval_retry_20260224_144641`
- 脚本直跑验证：
  - 命令：`python -m eve.review_pipeline --source-dir ... --date 20260224`
  - 结果：成功生成 `_processed/daily_20260224.md` 与 `_processed/segments_20260224.jsonl`
- 网页按钮触发验证：
  - 方式：Flask `test_client` POST 模拟按钮提交
  - 校验：HTTP 200、页面包含 `daily_20260224.md`、`segments_20260224.jsonl` 及文本片段
- 一键闭环脚本验证：
  - 命令：`python scripts/test_review_closed_loop.py --source-dir ... --date 20260224 --output-dir /Users/mahaoxuan/Desktop/eve/run_artifacts/closed_loop_review_test_20260227_2305`
  - 输出：`closed_loop_ok`
- 结论：需求“脚本触发 + 网页按键触发 + 页面呈现两个结果文件”已闭环完成。

## [2026-02-27 23:05:53 +0800] Step 31: 依赖声明补齐（Flask）
- 变更文件：`/Users/mahaoxuan/Desktop/eve/pyproject.toml`
- 变更内容：在 `dependencies` 中新增 `flask`。
- 原因：网页触发界面依赖 Flask，需写入项目依赖清单，避免后续重建环境时缺依赖。

## [2026-02-27 23:11:44 +0800] Step 32: 依赖锁文件刷新（uv.lock）
- 命令：`uv lock`
- 结果：成功（Resolved 125 packages）。
- 说明：过程中出现大量“Skipping file”历史包警告，为索引筛选提示，不影响锁定成功。

## [2026-02-27 23:11:44 +0800] Step 33: 入口脚本实跑验证
- 命令：`python scripts/generate_daily_review.py --source-dir /Users/mahaoxuan/Desktop/eve/run_artifacts/quality_eval_retry_20260224_144641 --date 20260224 --output-dir /Users/mahaoxuan/Desktop/eve/run_artifacts/direct_script_entry_test_20260227_2312`
- 结果：生成成功（`daily_20260224.md` + `segments_20260224.jsonl`）。
- 结论：脚本入口可直接用于日常调用，无需 `python -m`。

## [2026-02-27 23:11:44 +0800] Step 34: 变更后回归闭环验证
- 命令：`python scripts/test_review_closed_loop.py --source-dir /Users/mahaoxuan/Desktop/eve/run_artifacts/quality_eval_retry_20260224_144641 --date 20260224 --output-dir /Users/mahaoxuan/Desktop/eve/run_artifacts/closed_loop_review_test_20260227_2313`
- 结果：`closed_loop_ok`
- 结论：在补齐依赖与更新锁文件后，闭环链路仍保持通过。

## [2026-02-28 08:36:36 +0800] Step 35: 网页新增“单按钮自动取今天日期”能力
- 变更文件：`/Users/mahaoxuan/Desktop/eve/src/eve/review_web.py`
- 变更内容：
  - 新增按钮：`生成今日并刷新`（`action=run_today`）
  - 后端逻辑：点击该按钮时自动使用当天 `YYYYMMDD` 作为 `date`
  - 页面默认：首次打开时日期输入框默认展示当天日期
  - 保留原有路径：`按填写条件生成`（`action=run_custom`）

## [2026-02-28 08:36:36 +0800] Step 36: 闭环测试脚本补充“今日按钮”校验
- 变更文件：`/Users/mahaoxuan/Desktop/eve/scripts/test_review_closed_loop.py`
- 变更内容：
  - 新增 Step 3：构造当天目录样本数据
  - 通过 `action=run_today` 触发网页按钮流程
  - 校验页面中出现 `daily_今日日期.md` 与 `segments_今日日期.jsonl`

## [2026-02-28 08:36:36 +0800] Step 37: 回归验证结果
- 命令：`python scripts/test_review_closed_loop.py --source-dir /Users/mahaoxuan/Desktop/eve/run_artifacts/quality_eval_retry_20260224_144641 --date 20260224 --output-dir /Users/mahaoxuan/Desktop/eve/run_artifacts/closed_loop_review_test_20260228_today_btn`
- 输出：`closed_loop_ok`，并返回 `today_button_date=20260228`
- 额外校验：GET `/` 页面默认日期已显示当日，且按钮文案存在。
- 结论：需求“单按钮自动取今天日期”已落地并闭环通过。

## [2026-02-28 08:53:33 +0800] Step 38: 处理“网页打不开”问题
- 诊断结果：初次检查 `8765` 端口无监听进程（服务未成功驻留启动）。
- 验证动作：前台启动 `python scripts/review_web_app.py --host 127.0.0.1 --port 8765`。
- 验证结果：
  - Flask 正常启动，输出 `Running on http://127.0.0.1:8765`
  - `lsof` 显示端口已监听
  - `curl http://127.0.0.1:8765` 返回页面 HTML
- 结论：功能正常，问题点在“服务未保持运行”而非代码错误。
