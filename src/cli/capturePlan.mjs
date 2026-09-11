// src/cli/capturePlan.mjs
/**
 * Turning captured frames into something a video pipeline can ingest.
 *
 * The driver writes one PNG per screencast frame; this module decides what they
 * are called, how many to expect, and what to hand ffmpeg. Kept pure (no fs, no
 * spawn) so the naming and the encode arguments are unit-testable — a
 * zero-padding bug only shows up as frames out of order in the finished video,
 * which is an expensive place to find it.
 *
 * ffmpeg is OPTIONAL by design. It is not a repo dependency and is absent on
 * plenty of machines, so a run without it still succeeds and leaves a numbered
 * frame sequence plus the exact command to encode it later. Silently producing
 * no video, or failing the whole take, would both be worse.
 *
 * @module cli/capturePlan
 */

/** Zero-padding width. 6 digits is ~9.2 hours at 30fps — beyond any single take. */
export const FRAME_DIGITS = 6;
export const FRAME_PREFIX = 'frame';
export const FRAME_EXTENSION = 'png';

/**
 * Filename for one frame.
 *
 * Zero-padded because ffmpeg's `%0Nd` pattern and plain shell globbing both
 * order lexically: `frame10.png` sorting before `frame2.png` silently scrambles
 * the cut.
 *
 * @param {number} index Zero-based frame number.
 */
export function frameFileName(index) {
  const n = Number.isInteger(index) && index >= 0 ? index : 0;
  return `${FRAME_PREFIX}${String(n).padStart(FRAME_DIGITS, '0')}.${FRAME_EXTENSION}`;
}

/** The `%06d`-style pattern ffmpeg needs for the sequence above. */
export function framePattern() {
  return `${FRAME_PREFIX}%0${FRAME_DIGITS}d.${FRAME_EXTENSION}`;
}

/**
 * How many frames a recording window should yield.
 *
 * Always at least one: a window shorter than a frame interval still deserves
 * the frame it lands on, rather than an empty directory the user must diagnose.
 *
 * @param {number} durationMs
 * @param {number} fps
 */
export function expectedFrameCount(durationMs, fps) {
  const ms = Number.isFinite(durationMs) && durationMs > 0 ? durationMs : 0;
  const rate = Number.isFinite(fps) && fps > 0 ? fps : 1;
  return Math.max(1, Math.round((ms / 1000) * rate));
}

/**
 * ffmpeg arguments to encode a frame sequence to H.264 MP4.
 *
 * Choices that matter for the delivery target (short-form social + AI video
 * pipelines, which re-encode aggressively):
 *   -pix_fmt yuv420p   the only chroma format QuickTime/Safari/most social
 *                      encoders will decode; without it the file plays black.
 *   -crf 16            visually lossless-ish, because this is a MASTER that
 *                      gets re-compressed downstream, not a final delivery.
 *   -movflags +faststart  moves the index to the front so a web player can
 *                      start before the whole file arrives.
 *   -vf scale=...      forces even dimensions; H.264 4:2:0 cannot encode an
 *                      odd width or height and fails outright.
 *
 * @param {object} options
 * @param {string} options.frameDir
 * @param {string} options.outputFile
 * @param {number} options.fps
 * @returns {string[]} argv after the `ffmpeg` binary itself.
 */
export function ffmpegArgs({ frameDir, outputFile, fps }) {
  const rate = Number.isFinite(fps) && fps > 0 ? Math.min(240, Math.round(fps)) : 30;
  return [
    '-y',
    '-framerate', String(rate),
    '-i', `${frameDir}/${framePattern()}`,
    '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2',
    '-c:v', 'libx264',
    '-preset', 'slow',
    '-crf', '16',
    '-pix_fmt', 'yuv420p',
    '-movflags', '+faststart',
    outputFile,
  ];
}

/**
 * A copy-pasteable command line, for when ffmpeg is not installed.
 *
 * Quotes only the arguments that need it, so the printed line stays readable
 * and still survives a paste into a shell.
 */
export function ffmpegCommandLine(options) {
  const quote = (arg) => (/[\s"'$`\\*?()|&;<>]/.test(arg) ? `'${arg.replace(/'/g, `'\\''`)}'` : arg);
  return `ffmpeg ${ffmpegArgs(options).map(quote).join(' ')}`;
}
