import { readdir, readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import log from "electron-log/main";
import { FeishuService } from "./feishuService";
import { SentimentAnalyzer } from "./sentimentService";
import { SummaryService, type SummaryResult } from "./summaryService";
import { getFeishuConfig, getSentimentConfig } from "../store";

export interface DailyReportResult {
  success: boolean;
  date: string;
  sourceFileCount: number;
  segmentCount: number;
  totalChars: number;
  moodScore: number;
  moodLabel: string;
  summary?: SummaryResult;
  errorMessage?: string;
}

export class DailyReportService {
  private readonly sourceDir: string;

  constructor(sourceDir: string) {
    this.sourceDir = sourceDir;
  }

  async generateReport(date: string): Promise<DailyReportResult> {
    try {
      const dateDir = join(this.sourceDir, date);
      const jsonFiles = (await readdir(dateDir))
        .filter(f => f.endsWith(".json"))
        .sort();

      if (jsonFiles.length === 0) {
        return {
          success: false,
          date,
          sourceFileCount: 0,
          segmentCount: 0,
          totalChars: 0,
          moodScore: 0,
          moodLabel: "Neutral",
          errorMessage: "No recordings found for this date"
        };
      }

      // Read all JSON files and extract segments
      const records: Array<{
        text: string;
        sentiment_score?: number;
        sentiment_label?: string;
        start_time_iso?: string;
        end_time_iso?: string;
      }> = [];
      let totalChars = 0;
      let moodScores: number[] = [];

      for (const file of jsonFiles) {
        try {
          const content = await readFile(join(dateDir, file), "utf-8");
          const data = JSON.parse(content);
          const segments = data.segments || [];

          for (const seg of segments) {
            if (seg.text) {
              records.push(seg);
              totalChars += seg.text.length;
            }
          }
        } catch (e) {
          log.warn(`[daily-report] Failed to read ${file}:`, e);
        }
      }

      // Analyze sentiments
      const sentimentConfig = getSentimentConfig();
      let moodScore = 0;
      let moodLabel = "Neutral";

      if (sentimentConfig.enabled && sentimentConfig.apiKey && sentimentConfig.baseUrl) {
        const analyzer = new SentimentAnalyzer({
          apiKey: sentimentConfig.apiKey,
          baseUrl: sentimentConfig.baseUrl,
          model: sentimentConfig.model
        });

        // Analyze in batches
        const batchSize = 10;
        for (let i = 0; i < records.length; i += batchSize) {
          const batch = records.slice(i, i + batchSize);
          const batchText = batch.map(r => r.text).filter(Boolean).join(" ");

          if (batchText.trim()) {
            const result = await analyzer.analyze(batchText);
            const score = result.score;
            moodScores.push(score);

            for (const r of batch) {
              r.sentiment_score = score;
              r.sentiment_label = result.label;
            }
          }
        }

        if (moodScores.length > 0) {
          moodScore = moodScores.reduce((a, b) => a + b, 0) / moodScores.length;
          if (moodScore > 0.3) moodLabel = "Positive";
          else if (moodScore < -0.3) moodLabel = "Negative";
        }
      }

      // Generate smart summary using LLM
      let summary: SummaryResult | undefined;
      const fullTranscript = records.map(r => r.text).filter(Boolean).join(" ");
      if (sentimentConfig.enabled && sentimentConfig.apiKey && sentimentConfig.baseUrl && fullTranscript.trim()) {
        try {
          const summaryService = new SummaryService({
            apiKey: sentimentConfig.apiKey,
            baseUrl: sentimentConfig.baseUrl,
            model: sentimentConfig.model
          });
          summary = await summaryService.generateSummary(fullTranscript, date);
          log.info(`[daily-report] Summary generated: ${summary.decisions.length} decisions, ${summary.todos.length} todos`);
        } catch (e) {
          log.warn("[daily-report] Failed to generate summary:", e);
        }
      }

      // Generate markdown report
      const reportContent = this.generateMarkdown(date, {
        sourceFileCount: jsonFiles.length,
        segmentCount: records.length,
        totalChars,
        moodScore,
        moodLabel,
        records,
        summary
      });

      // Save report
      const outputDir = join(dateDir, "_processed");
      await mkdir(outputDir, { recursive: true });
      const reportPath = join(outputDir, `daily_report_${date}.md`);
      await writeFile(reportPath, reportContent, "utf-8");

      log.info(`[daily-report] Report generated: ${reportPath}`);

      return {
        success: true,
        date,
        sourceFileCount: jsonFiles.length,
        segmentCount: records.length,
        totalChars,
        moodScore,
        moodLabel,
        summary
      };
    } catch (error) {
      log.error("[daily-report] Failed to generate report:", error);
      return {
        success: false,
        date,
        sourceFileCount: 0,
        segmentCount: 0,
        totalChars: 0,
        moodScore: 0,
        moodLabel: "Neutral",
        errorMessage: String(error)
      };
    }
  }

  private generateMarkdown(
    date: string,
    data: {
      sourceFileCount: number;
      segmentCount: number;
      totalChars: number;
      moodScore: number;
      moodLabel: string;
      records: Array<{
        text?: string;
        sentiment_score?: number;
        start_time_iso?: string;
        end_time_iso?: string;
      }>;
      summary?: SummaryResult;
    }
  ): string {
    const lines: string[] = [];
    const moodEmoji = data.moodScore > 0.3 ? "🟢" : data.moodScore < -0.3 ? "🔴" : "🟡";

    lines.push(`# Daily Review ${date}`);
    lines.push("");
    lines.push(`- Generated At: ${new Date().toISOString()}`);
    lines.push(`- Source Files: ${data.sourceFileCount}`);
    lines.push(`- Text Segments: ${data.segmentCount}`);
    lines.push(`- Total Characters: ${data.totalChars}`);
    lines.push(`- Mood: ${moodEmoji} ${data.moodLabel} (score: ${data.moodScore.toFixed(2)})`);
    lines.push("");

    // Smart Summary Section
    if (data.summary) {
      lines.push("## 📋 Smart Summary");
      lines.push("");
      if (data.summary.summary) {
        lines.push(`**概述**: ${data.summary.summary}`);
        lines.push("");
      }
      if (data.summary.decisions.length > 0) {
        lines.push("### 🎯 Key Decisions");
        for (const decision of data.summary.decisions) {
          lines.push(`- ${decision}`);
        }
        lines.push("");
      }
      if (data.summary.todos.length > 0) {
        lines.push("### 📌 Action Items");
        for (const todo of data.summary.todos) {
          const assignee = todo.assignee ? ` @${todo.assignee}` : "";
          lines.push(`- [ ] ${todo.text}${assignee}`);
        }
        lines.push("");
      }
      if (data.summary.highlights.length > 0) {
        lines.push("### 💬 Highlights");
        for (const highlight of data.summary.highlights) {
          lines.push(`> ${highlight}`);
        }
        lines.push("");
      }
    }

    lines.push("## Timeline");
    lines.push("");

    if (data.records.length === 0) {
      lines.push("- No text segments found.");
    } else {
      data.records.forEach((record, index) => {
        const start = record.start_time_iso ? new Date(record.start_time_iso) : null;
        const timeLabel = start ? start.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "Unknown";
        const emoji = record.sentiment_score !== undefined
          ? (record.sentiment_score > 0.3 ? "🟢" : record.sentiment_score < -0.3 ? "🔴" : "🟡")
          : "";
        lines.push(`${index + 1}. [${timeLabel}] ${emoji} ${record.text || ""}`);
      });
    }

    lines.push("");
    lines.push("## Transcript");
    lines.push("");
    lines.push(data.records.map(r => r.text || "").filter(Boolean).join("\n\n") || "(empty)");

    return lines.join("\n");
  }

  async sendFeishuNotification(report: DailyReportResult, reportPath: string): Promise<boolean> {
    const feishuConfig = getFeishuConfig();
    if (!feishuConfig.enabled || !feishuConfig.appId || !feishuConfig.appSecret) {
      log.warn("[daily-report] Feishu not configured, skipping notification");
      return false;
    }

    try {
      const service = new FeishuService(feishuConfig.appId, feishuConfig.appSecret);
      const moodEmoji = report.moodScore > 0.3 ? "🟢" : report.moodScore < -0.3 ? "🔴" : "🟡";

      let message = `📅 **EVE Daily Review - ${report.date}**

📊 **统计信息：**
- 源文件数：${report.sourceFileCount}
- 转写段数：${report.segmentCount}
- 总字符数：${report.totalChars}
- 心情指数：${moodEmoji} ${report.moodLabel} (得分: ${report.moodScore.toFixed(2)})`;

      // Add smart summary if available
      if (report.summary) {
        if (report.summary.summary) {
          message += `\n\n📝 **概述**: ${report.summary.summary}`;
        }
        if (report.summary.decisions.length > 0) {
          message += `\n\n🎯 **决策**:`;
          for (const d of report.summary.decisions.slice(0, 3)) {
            message += `\n• ${d}`;
          }
        }
        if (report.summary.todos.length > 0) {
          message += `\n\n📌 **待办**:`;
          for (const t of report.summary.todos.slice(0, 3)) {
            const assignee = t.assignee ? ` @${t.assignee}` : "";
            message += `\n• ${t.text}${assignee}`;
          }
        }
      }

      message += `\n\n📄 **完整报告**: ${reportPath}`;

      const result = await service.sendTextMessage(
        feishuConfig.receiveId,
        message,
        feishuConfig.receiveIdType
      );

      if (result.success) {
        log.info("[daily-report] Feishu notification sent");
        return true;
      } else {
        log.error("[daily-report] Failed to send Feishu notification:", result.errorMessage);
        return false;
      }
    } catch (error) {
      log.error("[daily-report] Error sending Feishu notification:", error);
      return false;
    }
  }
}
