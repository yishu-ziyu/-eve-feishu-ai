/**
 * VAD Segmenter Service
 *
 * Wraps sherpa-onnx VAD to provide intelligent paragraph segmentation:
 * - Tracks cumulative timing across segments
 * - Detects silence > 3s for paragraph breaks
 * - Detects environmental sound changes as event anchors
 * - Aggregates ASR results per segment
 */

import log from "electron-log/main";

/** Window size in samples for 16kHz audio (512 samples = 32ms) */
export const VAD_WINDOW_SIZE = 512;
export const TARGET_SAMPLE_RATE = 16_000;

/** Threshold for detecting environmental sound changes */
const ENERGY_CHANGE_THRESHOLD = 2.0; // 2x RMS change
/** Minimum silence duration (seconds) to trigger paragraph break */
const SILENCE_DURATION_THRESHOLD = 3.0; // 3 seconds
/** Minimum segment duration (seconds) */
const MIN_SEGMENT_DURATION = 0.5;

export interface SegmentMetadata {
  /** Segment index */
  index: number;
  /** Absolute start time in seconds */
  startTime: number;
  /** Absolute end time in seconds */
  endTime: number;
  /** Segment type */
  type: "speech" | "silence" | "event";
  /** Event label (for type="event") */
  eventLabel?: string;
  /** Peak RMS energy */
  energy: number;
  /** ASR transcribed text */
  text?: string;
  /** ASR confidence if available */
  confidence?: number;
}

export interface VadSegmentInput {
  samples: Float32Array;
  start: number; // sample offset within current recording
}

export class VadSegmenter {
  /** Cumulative sample count since recording start */
  private sampleOffset = 0;
  /** Current speech segment being built */
  private currentSegment: {
    startSample: number;
    samples: Float32Array[];
    texts: string[];
    startTime: number;
  } | null = null;
  /** Completed segments */
  private segments: SegmentMetadata[] = [];
  /** Time of last speech detection */
  private lastSpeechAt = 0;
  /** Previous segment energy for change detection */
  private prevEnergy = 0;
  /** Whether we are currently in silence */
  private inSilence = false;
  /** Silence start time (samples) */
  private silenceStartSample = 0;

  constructor() {
    this.reset();
  }

  /**
   * Process a VAD segment from sherpa-onnx
   */
  processVadSegment(vadSegment: VadSegmentInput, asrText?: string): SegmentMetadata | null {
    const segmentDuration = vadSegment.samples.length / TARGET_SAMPLE_RATE;
    const segmentStartTime = vadSegment.start / TARGET_SAMPLE_RATE;
    const segmentEndTime = segmentStartTime + segmentDuration;

    // Calculate RMS energy
    const energy = this.calculateRms(vadSegment.samples);

    // Detect energy change (environmental sound change)
    let eventType: "speech" | "event" = "speech";
    if (this.prevEnergy > 0) {
      const energyRatio = Math.max(energy, this.prevEnergy) / Math.min(energy, this.prevEnergy);
      if (energyRatio > ENERGY_CHANGE_THRESHOLD && Math.abs(energy - this.prevEnergy) > 0.05) {
        eventType = "event";
        log.info(`[vad-segmenter] Energy change detected: ${this.prevEnergy.toFixed(4)} → ${energy.toFixed(4)}, ratio=${energyRatio.toFixed(2)}`);
      }
    }
    this.prevEnergy = energy;

    // Check for paragraph break (silence gap)
    const timeSinceLastSpeech = (vadSegment.start - this.lastSpeechAt) / TARGET_SAMPLE_RATE;
    if (timeSinceLastSpeech > SILENCE_DURATION_THRESHOLD && this.lastSpeechAt > 0) {
      log.info(`[vad-segmenter] Paragraph break detected: ${timeSinceLastSpeech.toFixed(2)}s silence`);
      this.finalizeCurrentSegment();
    }
    this.lastSpeechAt = vadSegment.start + vadSegment.samples.length;

    // Create new segment
    const segment: SegmentMetadata = {
      index: this.segments.length,
      startTime: segmentStartTime,
      endTime: segmentEndTime,
      type: eventType,
      eventLabel: eventType === "event" ? this.detectEventLabel(energy) : undefined,
      energy,
      text: asrText
    };

    this.segments.push(segment);
    return segment;
  }

  /**
   * Process raw samples when VAD is not active (silence)
   */
  processSilence(samples: Float32Array, startSample: number): void {
    if (!this.inSilence) {
      this.inSilence = true;
      this.silenceStartSample = startSample;
    }

    const silenceDuration = (startSample + samples.length - this.silenceStartSample) / TARGET_SAMPLE_RATE;

    // Check for paragraph break after silence threshold
    if (silenceDuration >= SILENCE_DURATION_THRESHOLD && this.currentSegment) {
      log.info(`[vad-segmenter] Paragraph break after silence: ${silenceDuration.toFixed(2)}s`);
      this.finalizeCurrentSegment();
    }
  }

  /**
   * Start a new speech segment
   */
  startSpeechSegment(startSample: number): void {
    this.inSilence = false;
    this.currentSegment = {
      startSample,
      samples: [],
      texts: [],
      startTime: startSample / TARGET_SAMPLE_RATE
    };
  }

  /**
   * Add samples to current segment
   */
  appendToSegment(samples: Float32Array, asrText?: string): void {
    if (!this.currentSegment) {
      this.startSpeechSegment(this.sampleOffset);
    }
    this.currentSegment!.samples.push(samples);
    if (asrText) {
      this.currentSegment!.texts.push(asrText);
    }
  }

  /**
   * Finalize the current segment and prepare for next
   */
  private finalizeCurrentSegment(): void {
    if (!this.currentSegment) return;

    const totalSamples = this.currentSegment.samples.reduce((sum, s) => sum + s.length, 0);
    const duration = totalSamples / TARGET_SAMPLE_RATE;

    if (duration >= MIN_SEGMENT_DURATION) {
      // Calculate average energy
      let totalEnergy = 0;
      let sampleCount = 0;
      for (const s of this.currentSegment.samples) {
        totalEnergy += this.calculateRms(s) * s.length;
        sampleCount += s.length;
      }
      const avgEnergy = totalEnergy / sampleCount;

      const segment: SegmentMetadata = {
        index: this.segments.length,
        startTime: this.currentSegment.startTime,
        endTime: this.currentSegment.startTime + duration,
        type: "speech",
        energy: avgEnergy,
        text: this.currentSegment.texts.join(" ").trim() || undefined
      };
      this.segments.push(segment);
      log.info(`[vad-segmenter] Segment finalized: ${segment.index}, duration=${duration.toFixed(2)}s, text="${segment.text?.slice(0, 50) ?? ""}..."`);
    }

    this.currentSegment = null;
  }

  /**
   * Detect event type from energy level
   */
  private detectEventLabel(energy: number): string {
    // Low energy events
    if (energy < 0.01) {
      return "quiet_event"; // door closing softly, footsteps stopping
    }
    // High energy events
    if (energy > 0.3) {
      return "loud_event"; // door slam, object drop, laugh
    }
    return "environmental_change";
  }

  /**
   * Calculate RMS energy of samples
   */
  private calculateRms(samples: Float32Array): number {
    if (samples.length === 0) return 0;
    let sum = 0;
    for (let i = 0; i < samples.length; i++) {
      sum += samples[i] * samples[i];
    }
    return Math.sqrt(sum / samples.length);
  }

  /**
   * Get all completed segments
   */
  getSegments(): SegmentMetadata[] {
    return [...this.segments];
  }

  /**
   * Get segment count
   */
  getSegmentCount(): number {
    return this.segments.length;
  }

  /**
   * Reset the segmenter state
   */
  reset(): void {
    this.sampleOffset = 0;
    this.segments = [];
    this.currentSegment = null;
    this.lastSpeechAt = 0;
    this.prevEnergy = 0;
    this.inSilence = false;
    this.silenceStartSample = 0;
  }

  /**
   * Advance the sample offset (call after processing a chunk)
   */
  advanceSampleOffset(samplesCount: number): void {
    this.sampleOffset += samplesCount;
  }

  /**
   * Flush any remaining segment data
   */
  flush(): SegmentMetadata | null {
    this.finalizeCurrentSegment();
    return this.segments.length > 0 ? this.segments[this.segments.length - 1] : null;
  }

  /**
   * Generate paragraph grouping from segments
   * Groups consecutive speech segments into paragraphs
   */
  getParagraphs(): SegmentMetadata[][] {
    const paragraphs: SegmentMetadata[][] = [];
    let currentParagraph: SegmentMetadata[] = [];

    for (const segment of this.segments) {
      if (segment.type === "event") {
        // Events are appended to current paragraph but not grouped
        currentParagraph.push(segment);
        continue;
      }

      if (segment.type === "silence") {
        // End current paragraph
        if (currentParagraph.length > 0) {
          paragraphs.push(currentParagraph);
          currentParagraph = [];
        }
        continue;
      }

      currentParagraph.push(segment);
    }

    // Don't forget the last paragraph
    if (currentParagraph.length > 0) {
      paragraphs.push(currentParagraph);
    }

    return paragraphs;
  }

  /**
   * Export segments in JSON-serializable format
   */
  toJSON(): object {
    return {
      segmentCount: this.segments.length,
      totalDuration: this.segments.length > 0
        ? this.segments[this.segments.length - 1].endTime - this.segments[0].startTime
        : 0,
      segments: this.segments,
      paragraphs: this.getParagraphs().map((p, i) => ({
        index: i,
        startTime: p[0]?.startTime ?? 0,
        endTime: p[p.length - 1]?.endTime ?? 0,
        segmentCount: p.length,
        texts: p.map(s => s.text).filter(Boolean).join(" ")
      }))
    };
  }
}
