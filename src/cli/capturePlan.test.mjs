// src/cli/capturePlan.test.mjs
// Frame naming and encode flags are only observably wrong in the finished
// video — frames out of order, or a file that plays black in Safari — which is
// an expensive place to discover a bug. Both are pinned here instead.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  FRAME_DIGITS,
  expectedFrameCount,
  ffmpegArgs,
  ffmpegCommandLine,
  framePattern,
  frameFileName,
} from './capturePlan.mjs';

test('frame names zero-pad so lexical order is playback order', () => {
  assert.equal(frameFileName(0), 'frame000000.png');
  assert.equal(frameFileName(7), 'frame000007.png');
  // The bug this prevents: frame10 must not sort before frame2.
  assert.deepEqual(
    [frameFileName(10), frameFileName(2)].sort(),
    [frameFileName(2), frameFileName(10)]
  );
  assert.equal(framePattern(), `frame%0${FRAME_DIGITS}d.png`);
});

test('a nonsense frame index still yields a usable name', () => {
  for (const bad of [-1, 1.5, NaN, null, undefined, 'x']) {
    assert.match(frameFileName(bad), /^frame\d{6}\.png$/);
  }
});

test('frame counts follow duration and fps, never zero', () => {
  assert.equal(expectedFrameCount(1000, 30), 30);
  assert.equal(expectedFrameCount(8000, 30), 240);
  assert.equal(expectedFrameCount(500, 24), 12);
  // Shorter than one interval still captures the frame it lands on.
  assert.equal(expectedFrameCount(10, 30), 1);
  assert.equal(expectedFrameCount(0, 30), 1);
  assert.equal(expectedFrameCount(NaN, NaN), 1);
});

test('encode flags carry the four that decide whether the file is usable', () => {
  const args = ffmpegArgs({ frameDir: '/out/frames', outputFile: '/out/take.mp4', fps: 30 });
  const at = (flag) => args[args.indexOf(flag) + 1];
  // Without yuv420p the MP4 plays black in Safari and most social encoders.
  assert.equal(at('-pix_fmt'), 'yuv420p');
  // H.264 4:2:0 cannot encode odd dimensions — it fails outright.
  assert.equal(at('-vf'), 'scale=trunc(iw/2)*2:trunc(ih/2)*2');
  // Faststart lets a web player begin before the file finishes arriving.
  assert.equal(at('-movflags'), '+faststart');
  assert.equal(at('-framerate'), '30');
  assert.equal(at('-i'), `/out/frames/${framePattern()}`);
  assert.equal(args[args.length - 1], '/out/take.mp4', 'output is last');
  assert.equal(args[0], '-y', 'overwrite rather than block on a prompt');
});

test('fps is clamped and rounded before it reaches ffmpeg', () => {
  const rateOf = (fps) => {
    const args = ffmpegArgs({ frameDir: '/f', outputFile: '/o.mp4', fps });
    return args[args.indexOf('-framerate') + 1];
  };
  assert.equal(rateOf(29.97), '30');
  assert.equal(rateOf(100000), '240');
  for (const bad of [0, -5, NaN, null, undefined, 'x']) assert.equal(rateOf(bad), '30');
});

test('the printed fallback command survives a paste into a shell', () => {
  const line = ffmpegCommandLine({
    frameDir: '/tmp/my frames', outputFile: '/tmp/take one.mp4', fps: 30,
  });
  assert.match(line, /^ffmpeg /);
  // Paths with spaces are quoted; plain tokens are left bare and readable.
  assert.match(line, /'\/tmp\/my frames\/frame%06d\.png'/);
  assert.match(line, /'\/tmp\/take one\.mp4'/);
  assert.match(line, / -c:v libx264 /);
});
