const SESSION_CHANNEL_MAX_UNACKED_FRAMES = 512
const SESSION_CHANNEL_MAX_UNACKED_BYTES = 4 * 1024 * 1024

export function sessionChannelBacklogExceeded(
  pendingFrameCount: number,
  unacknowledgedBytes: number,
  nextFrameBytes: number,
): boolean {
  // Always allow a single in-flight frame so a large snapshot can land and a later output can
  // advance an acknowledgement. Age alone is not backpressure: an idle frame consumes bounded
  // memory, and rejecting the next frame would prevent the renderer from ever clearing it.
  if (pendingFrameCount === 0) return false
  if (pendingFrameCount >= SESSION_CHANNEL_MAX_UNACKED_FRAMES) return true
  return unacknowledgedBytes + nextFrameBytes > SESSION_CHANNEL_MAX_UNACKED_BYTES
}
