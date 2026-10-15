import { describe, expect, it } from 'vitest'
import { VideoFrameProbe } from './video-probe'

/** Stand-in for HTMLVideoElement that lets the test deliver frames through requestVideoFrameCallback by hand. */
function fakeVideo(dropped = 0) {
  const video = {
    callback: null as ((now: number, metadata: Record<string, unknown>) => void) | null,
    cancelled: [] as number[],
    requestVideoFrameCallback(callback: (now: number, metadata: Record<string, unknown>) => void) {
      video.callback = callback
      return 7
    },
    cancelVideoFrameCallback(handle: number) {
      video.cancelled.push(handle)
    },
    getVideoPlaybackQuality: () => ({ droppedVideoFrames: dropped }),
    deliver(metadata: Record<string, unknown>, now = 0) {
      const callback = video.callback
      if (!callback) throw new Error('no frame callback registered')
      video.callback = null
      callback(now, metadata)
    }
  }
  return video
}

describe('VideoFrameProbe', () => {
  it('records presented frames, capture age and interval from frame metadata', () => {
    const probe = new VideoFrameProbe()
    const video = fakeVideo()
    probe.start(video as unknown as HTMLVideoElement)
    video.deliver({ presentationTime: 1000, expectedDisplayTime: 1000, captureTime: 950 })
    video.deliver({ presentationTime: 1033, expectedDisplayTime: 1033, captureTime: 1000 })
    video.deliver({ presentationTime: 1066, expectedDisplayTime: 1066, captureTime: 1020 })
    const snapshot = probe.snapshot()
    expect(snapshot.framesPresented).toBe(3)
    expect(snapshot.captureAgeMs?.count).toBe(3)
    expect(snapshot.captureAgeMs?.p50).toBe(46)
    expect(snapshot.frameIntervalMs?.count).toBe(2)
    expect(snapshot.frameIntervalMs?.p50).toBe(33)
    expect(snapshot.presentedFps).toBeCloseTo(1000 / 33, 1)
  })

  it('leaves capture age empty when the browser supplies no capture time', () => {
    const probe = new VideoFrameProbe()
    const video = fakeVideo()
    probe.start(video as unknown as HTMLVideoElement)
    video.deliver({ expectedDisplayTime: 500 })
    video.deliver({ expectedDisplayTime: 540 })
    const snapshot = probe.snapshot()
    expect(snapshot.captureAgeMs).toBeNull()
    expect(snapshot.frameIntervalMs?.p50).toBe(40)
  })

  it('reports the decoder drop count from playback quality', () => {
    const probe = new VideoFrameProbe()
    probe.start(fakeVideo(5) as unknown as HTMLVideoElement)
    expect(probe.snapshot().droppedFrames).toBe(5)
  })

  it('stays bounded: the ring keeps only the newest samples', () => {
    const probe = new VideoFrameProbe({ capacity: 3 })
    const video = fakeVideo()
    probe.start(video as unknown as HTMLVideoElement)
    for (let index = 0; index < 10; index += 1) video.deliver({ presentationTime: index * 10, expectedDisplayTime: index * 10, captureTime: index * 10 - 4 })
    const snapshot = probe.snapshot()
    expect(snapshot.framesPresented).toBe(10)
    expect(snapshot.captureAgeMs?.count).toBe(3)
    expect(snapshot.frameIntervalMs?.count).toBe(3)
  })

  it('reports each frame to the optional callback with its timing', () => {
    const seen: Array<{ presentedAt: number; intervalMs: number | null }> = []
    const probe = new VideoFrameProbe({ onFrame: frame => seen.push({ presentedAt: frame.presentedAt, intervalMs: frame.intervalMs }) })
    const video = fakeVideo()
    probe.start(video as unknown as HTMLVideoElement)
    video.deliver({ presentationTime: 100, expectedDisplayTime: 100 })
    video.deliver({ presentationTime: 133, expectedDisplayTime: 133 })
    expect(seen).toEqual([{ presentedAt: 100, intervalMs: null }, { presentedAt: 133, intervalMs: 33 }])
  })

  it('cancels its callback on stop and ignores a video without requestVideoFrameCallback', () => {
    const probe = new VideoFrameProbe()
    const video = fakeVideo()
    probe.start(video as unknown as HTMLVideoElement)
    expect(probe.attached).toBe(true)
    probe.stop()
    expect(video.cancelled).toEqual([7])
    expect(probe.attached).toBe(false)
    probe.start({} as HTMLVideoElement)
    expect(probe.attached).toBe(false)
  })
})
