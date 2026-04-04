/**
 * Summary Service
 *
 * Generates structured meeting summaries from transcript segments:
 * - Key decisions (决策)
 * - Action items (待办事项)
 * - Highlight quotes (高引用观点)
 * - Sentiment analysis
 */

import log from "electron-log/main";

export interface SummaryResult {
  decisions: string[];
  todos: Array<{ text: string; assignee?: string }>;
  highlights: string[];
  sentiment: "positive" | "neutral" | "mixed" | "negative";
  score: number; // -1 to 1
  summary: string; // Brief overall summary
}

interface LLMMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface SummaryConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
}

/**
 * Generate structured summary from transcript text using LLM
 */
export class SummaryService {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly model: string;

  constructor(config: SummaryConfig) {
    this.apiKey = config.apiKey;
    this.baseUrl = config.baseUrl;
    this.model = config.model;
  }

  /**
   * Analyze transcript and extract structured summary
   */
  async generateSummary(transcript: string, date: string): Promise<SummaryResult> {
    if (!transcript || transcript.trim().length < 10) {
      return {
        decisions: [],
        todos: [],
        highlights: [],
        sentiment: "neutral",
        score: 0,
        summary: "无有效转录内容"
      };
    }

    const prompt = this.buildSummaryPrompt(transcript, date);

    try {
      const response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`
        },
        body: JSON.stringify({
          model: this.model,
          messages: prompt,
          temperature: 0.3, // Lower temp for more consistent structured output
          max_tokens: 2000
        })
      });

      if (!response.ok) {
        const errorText = await response.text();
        log.error("[summary] LLM API error:", response.status, errorText);
        throw new Error(`LLM API returned ${response.status}`);
      }

      const data = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
      const content = data.choices?.[0]?.message?.content;

      if (!content) {
        throw new Error("Empty response from LLM");
      }

      return this.parseSummaryResponse(content);
    } catch (error) {
      log.error("[summary] Failed to generate summary:", error);
      return {
        decisions: [],
        todos: [],
        highlights: [],
        sentiment: "neutral",
        score: 0,
        summary: `生成失败: ${error instanceof Error ? error.message : "未知错误"}`
      };
    }
  }

  /**
   * Build prompt for structured summary extraction
   */
  private buildSummaryPrompt(transcript: string, date: string): LLMMessage[] {
    const systemPrompt = `你是一个会议分析助手。你的任务是从转录文本中提取关键信息，生成结构化的会议简报。

请分析以下转录内容，提取并返回 JSON 格式的结构化信息：

{
  "decisions": ["决策1", "决策2"],  // 以"决定"、"确认"、"通过"、"同意"、"否决"等开头的陈述
  "todos": [{"text": "待办描述", "assignee": "负责人"}],  // 以"需要"、"待"、"TODO"、"应该"、"必须"开头的事项，含@人名优先提取
  "highlights": ["高引用观点1", "高引用观点2"],  // 被强调、重复或总结性的陈述
  "sentiment": "positive|neutral|mixed|negative",  // 整体情感倾向
  "score": 0.0,  // -1到1的情感得分
  "summary": "一句话总结"  // 会议核心内容概述
}

注意：
- decisions 最多5条，每条不超过50字
- todos 最多10条，每条不超过100字
- highlights 最多5条，每条不超过100字
- 如果某项为空，返回空数组 []
- summary 不超过30字
- 直接返回 JSON，不要有其他文字`;

    return [
      { role: "system", content: systemPrompt },
      { role: "user", content: `日期: ${date}\n\n转录内容:\n${transcript}` }
    ];
  }

  /**
   * Parse LLM response into structured summary
   */
  private parseSummaryResponse(content: string): SummaryResult {
    try {
      // Try to extract JSON from the response
      let jsonStr = content.trim();

      // Handle markdown code blocks
      const jsonMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
      if (jsonMatch) {
        jsonStr = jsonMatch[1];
      }

      // Try to find JSON object
      const objectMatch = jsonStr.match(/\{[\s\S]*\}/);
      if (objectMatch) {
        jsonStr = objectMatch[0];
      }

      const parsed = JSON.parse(jsonStr);

      return {
        decisions: Array.isArray(parsed.decisions) ? parsed.decisions : [],
        todos: Array.isArray(parsed.todos) ? parsed.todos : [],
        highlights: Array.isArray(parsed.highlights) ? parsed.highlights : [],
        sentiment: this.normalizeSentiment(parsed.sentiment),
        score: this.normalizeScore(parsed.score),
        summary: typeof parsed.summary === "string" ? parsed.summary : "无摘要"
      };
    } catch (error) {
      log.warn("[summary] Failed to parse LLM response:", error);
      // Return a fallback with the raw content as summary
      return {
        decisions: [],
        todos: [],
        highlights: [],
        sentiment: "neutral",
        score: 0,
        summary: content.slice(0, 100)
      };
    }
  }

  /**
   * Normalize sentiment string
   */
  private normalizeSentiment(s: unknown): "positive" | "neutral" | "mixed" | "negative" {
    if (typeof s !== "string") return "neutral";
    const lower = s.toLowerCase();
    if (lower === "positive" || lower === "positive" || lower === "积极") return "positive";
    if (lower === "negative" || lower === "negative" || lower === "消极") return "negative";
    if (lower === "mixed" || lower === "mixed" || lower === "中性偏正面" || lower === "中性偏负面") return "mixed";
    return "neutral";
  }

  /**
   * Normalize score to -1 to 1 range
   */
  private normalizeScore(score: unknown): number {
    if (typeof score !== "number" || !Number.isFinite(score)) return 0;
    return Math.max(-1, Math.min(1, score));
  }
}

/**
 * Extract assignee from todo text (e.g., "@张三 跟进合同" -> "张三")
 */
export function extractAssignee(text: string): string | undefined {
  const match = text.match(/@(\S+)/);
  return match ? match[1] : undefined;
}

/**
 * Clean todo text by removing @mentions
 */
export function cleanTodoText(text: string): string {
  return text.replace(/@\S+\s*/g, "").trim();
}
