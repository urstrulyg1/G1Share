import { NumberRing, summarize } from '../../../shared/latency-stats'
import type { Percentiles } from '../../../shared/latency-stats'

export type { Percentiles }

// Presentation-side measurements for the remote video. The probe observes frames that the browser has
// already decided to show (requestVideoFrameCallback); it never reads pixels and never touches React
// state per frame. Samples go into fixed-size ring buffers, so memory stays bounded for any session length.

/** Frame metadata that Chromium provides for WebRTC media. Fields are optional because support varies. */
export interface PresentedFrameMetadata {
  presentationTime?: number
  expectedDisplayTime: number
  /** Sender capture time mapped onto this page's performance.now() timeline (WebRTC only). */
  captureTime?: number
  receiveTime?: number
  presentedFrames?: number
}

export interface PresentedFrame {
  /** Time at which the frame was presented, in performance.now() milliseconds. */
  presentedAt: number
  /** presentedAt minus captureTime when the browser reports a capture time; null otherwise. */
  captureAgeMs: number | null
  /** Milliseconds since the previously presented frame; null for the first frame. */
  intervalMs: number | null
}

export interface ProbeSnapshot {
  framesPresented: number
  droppedFrames: number | null
  /** Presented frames per second over the most recent interval samples. */
  presentedFps: number | null
  captureAgeMs: Percentiles | null
  frameIntervalMs: Percentiles | null
}

const DEFAULT_CAPACITY = 600
const FPS_WINDOW = 60

export class VideoFrameProbe {
  private video: HTMLVideoElement | null = null
  private handle: number | null = null
  private lastPresentedAt: number | null = null
  private framesPresented = 0
  private readonly ages: NumberRing
  private readonly intervals: NumberRing
  private readonly onFrame: ((frame: PresentedFrame, metadata: PresentedFrameMetadata) => void) | undefined

  constructor(options: { capacity?: number; onFrame?: (frame: PresentedFrame, metadata: PresentedFrameMetadata) => void } = {}) {
    const capacity = options.capacity ?? DEFAULT_CAPACITY
    this.ages = new NumberRing(capacity)
    this.intervals = new NumberRing(capacity)
    this.onFrame = options.onFrame
  }

  get attached(): boolean {
    return this.video !== null
  }

  start(video: HTMLVideoElement): void {
    if (this.video === video) return
    this.stop()
    if (typeof video.requestVideoFrameCallback !== 'function') return
    this.video = video
    this.reset()
    this.schedule()
  }

  stop(): void {
    if (this.video && this.handle !== null && typeof this.video.cancelVideoFrameCallback === 'function') {
      this.video.cancelVideoFrameCallback(this.handle)
    }
    this.handle = null
    this.video = null
  }

  reset(): void {
    this.lastPresentedAt = null
    this.framesPresented = 0
    this.ages.clear()
    this.intervals.clear()
  }

  private schedule(): void {
    if (!this.video) return
    this.handle = this.video.requestVideoFrameCallback((now, metadata) => this.handleFrame(now, metadata as unknown as PresentedFrameMetadata))
  }

  private handleFrame(now: number, metadata: PresentedFrameMetadata): void {
    if (!this.video) return
    const presentedAt = metadata.presentationTime ?? metadata.expectedDisplayTime ?? now
    const captureAgeMs = typeof metadata.captureTime === 'number' ? presentedAt - metadata.captureTime : null
    const intervalMs = this.lastPresentedAt === null ? null : presentedAt - this.lastPresentedAt
    this.lastPresentedAt = presentedAt
    this.framesPresented += 1
    this.ages.push(captureAgeMs ?? Number.NaN)
    this.intervals.push(intervalMs ?? Number.NaN)
    this.onFrame?.({ presentedAt, captureAgeMs, intervalMs }, metadata)
    this.schedule()
  }

  snapshot(): ProbeSnapshot {
    const intervals = this.intervals.toArray().filter(value => Number.isFinite(value))
    const recent = intervals.slice(-FPS_WINDOW)
    const recentMs = recent.reduce((total, value) => total + value, 0)
    const quality = this.video && typeof this.video.getVideoPlaybackQuality === 'function' ? this.video.getVideoPlaybackQuality() : null
    return {
      framesPresented: this.framesPresented,
      droppedFrames: quality ? quality.droppedVideoFrames : null,
      presentedFps: recent.length > 0 && recentMs > 0 ? recent.length * 1000 / recentMs : null,
      captureAgeMs: summarize(this.ages.toArray()),
      frameIntervalMs: summarize(intervals)
    }
  }
}
