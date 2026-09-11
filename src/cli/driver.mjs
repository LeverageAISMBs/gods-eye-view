// src/cli/driver.mjs
/**
 * The GEV driver: a headless browser running the real app, taking tool calls.
 *
 * This is the only module here that touches puppeteer, CDP, and the filesystem;
 * everything it decides (shot-list validity, frame naming, encode flags) lives
 * in the pure modules beside it. That split is what makes the CLI testable
 * without launching Chrome.
 *
 * WHY A REAL BROWSER: GEV's 28 capabilities are defined against a live Cesium
 * scene — camera state, loaded entities, tile streaming. There is no headless
 * "model" of the globe to drive instead, and the footage is the point, so the
 * app has to actually render.
 *
 * Frames come from CDP `Page.startScreencast` rather than repeated
 * `page.screenshot()`: screenshots serialise against the render loop and drop
 * to a few frames a second on a busy scene, which is unusable as video. The
 * screencast pushes frames from the compositor instead.
 *
 * @module cli/driver
 */

import fs from 'node:fs';
import path from 'node:path';
import { frameFileName } from './capturePlan.mjs';
import { FIRST_RUN_STORAGE_KEY } from '../firstRunExperience.js';

/** How long to wait for the app handle before calling the boot failed. */
export const DEFAULT_BOOT_TIMEOUT_MS = 90_000;
/** Cesium streams tiles continuously; this is the cap on waiting for quiet. */
export const DEFAULT_SETTLE_TIMEOUT_MS = 20_000;

/**
 * Chrome flags.
 *
 * `--enable-unsafe-swiftshader` is what lets this run on a GPU-less box (CI, a
 * container, a cheap VPS). It PERMITS the software fallback, it does not force
 * it: Chrome still takes the GPU where there is one. Without it, Cesium fails
 * at construction with "Error constructing CesiumWidget… verify that your
 * browser and hardware support WebGL" and the app never boots — verified in a
 * headless container on 2026-09-10.
 *
 * Software rendering is a correctness fallback, not a delivery target: it is
 * slow and the frames look flat. Capture real footage on a GPU machine.
 */
export const CHROME_ARGS = Object.freeze([
  '--enable-gpu',
  '--enable-unsafe-swiftshader',
  '--no-sandbox',
  '--hide-scrollbars',
  '--autoplay-policy=no-user-gesture-required',
  // The mic is never used by the CLI; denying it up front stops a permission
  // prompt from stealing focus mid-take.
  '--use-fake-ui-for-media-stream',
]);

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

/**
 * Launch a browser and boot GEV to the point where tools can run.
 *
 * @param {object} options
 * @param {import('puppeteer')} options.puppeteer
 * @param {string} options.url
 * @param {{width: number, height: number}} options.viewport
 * @param {boolean} [options.headful]
 * @param {number} [options.bootTimeoutMs]
 * @param {boolean} [options.showFirstRun] Film the first-run launcher on purpose.
 * @param {(message: string) => void} [options.log]
 * @returns {Promise<{browser: object, page: object, close: () => Promise<void>}>}
 */
export async function launchGev({
  puppeteer,
  url,
  viewport,
  headful = false,
  bootTimeoutMs = DEFAULT_BOOT_TIMEOUT_MS,
  showFirstRun = false,
  log = () => {},
}) {
  const executablePath = process.env.PUPPETEER_EXECUTABLE_PATH
    || (() => { try { return puppeteer.executablePath(); } catch { return null; } })();
  if (!executablePath || !fs.existsSync(executablePath)) {
    throw new Error(
      'No Chrome binary for puppeteer. Set PUPPETEER_EXECUTABLE_PATH, or run `npx puppeteer browsers install chrome`.'
    );
  }

  const browser = await puppeteer.launch({
    headless: headful ? false : 'new',
    executablePath,
    args: [...CHROME_ARGS, `--window-size=${viewport.width},${viewport.height}`],
    defaultViewport: { ...viewport, deviceScaleFactor: 1 },
  });

  const page = await browser.newPage();
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));

  if (!showFirstRun) {
    // Every CLI run is a fresh browser profile, so the first-run launcher opens
    // over the globe and lands in the middle of every captured frame — found by
    // filming a take and looking at it. Suppressed the same way the app's own
    // "don't show this again" does, BEFORE any script runs, since the launcher
    // decides during bootstrap.
    await page.evaluateOnNewDocument((key) => {
      try { window.localStorage.setItem(key, 'suppressed'); } catch { /* private mode */ }
    }, FIRST_RUN_STORAGE_KEY);
  }

  const close = async () => {
    try { await browser.close(); } catch { /* the take is already over */ }
  };

  try {
    log(`opening ${url}`);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: bootTimeoutMs });
    // The same readiness signal the repo's QA harness uses, plus the agent
    // bridge — without it there is nothing to drive.
    await page.waitForFunction(
      () => Boolean(window.__godsEyeView?.viewer
        && window.__godsEyeView?.dataManager
        && window.__godsEyeView?.agent?.ready?.()),
      { timeout: bootTimeoutMs, polling: 250 }
    );
    log('GEV ready');
  } catch (error) {
    await close();
    const detail = pageErrors.length ? ` Page errors: ${pageErrors.slice(0, 3).join('; ')}` : '';
    throw new Error(
      `GEV did not become ready at ${url} within ${bootTimeoutMs}ms.${detail} `
      + 'Is the dev server running (npm run dev)?'
    );
  }

  return { browser, page, close, pageErrors };
}

/**
 * Run one GEV tool in the page.
 *
 * Failures come back as `{ok:false, error}` from the bridge rather than
 * throwing, so a single bad step in a long shot list is a reported step, not a
 * lost take.
 *
 * @param {object} page
 * @param {string} tool
 * @param {object} args
 * @returns {Promise<object>}
 */
export async function executeTool(page, tool, args = {}) {
  return page.evaluate(
    (name, payload) => window.__godsEyeView.agent.execute(name, payload),
    tool,
    args
  );
}

/**
 * Wait for the globe to stop changing, or until the cap.
 *
 * Cesium keeps streaming tiles as the camera settles, and cutting a shot while
 * the terrain is still resolving is the single most common way footage looks
 * cheap. `tilesLoaded` is the scene's own signal for that.
 *
 * @param {object} page
 * @param {number} timeoutMs
 * @returns {Promise<boolean>} true if the scene reported quiet before the cap.
 */
export async function waitForSceneQuiet(page, timeoutMs = DEFAULT_SETTLE_TIMEOUT_MS) {
  try {
    await page.waitForFunction(
      () => {
        const gev = window.__godsEyeView;
        const tileset = gev?.tileset;
        const globe = gev?.viewer?.scene?.globe;
        // Both may be absent depending on the active map stack; absent means
        // "nothing streaming", not "never quiet".
        const tilesetReady = !tileset || tileset.tilesLoaded !== false;
        const globeReady = !globe || globe.tilesLoaded !== false;
        return tilesetReady && globeReady;
      },
      { timeout: timeoutMs, polling: 250 }
    );
    return true;
  } catch {
    // Not fatal: a busy scene that never fully settles still films fine, and
    // stalling the whole shot list on it would be worse.
    return false;
  }
}

/**
 * Capture a screencast to numbered PNGs for a fixed window.
 *
 * @param {object} options
 * @param {object} options.page
 * @param {string} options.frameDir
 * @param {number} options.durationMs
 * @param {number} options.fps
 * @param {number} [options.startIndex] Continue an existing sequence.
 * @returns {Promise<{frames: number, nextIndex: number}>}
 */
export async function captureWindow({ page, frameDir, durationMs, fps, startIndex = 0 }) {
  fs.mkdirSync(frameDir, { recursive: true });
  const client = await page.createCDPSession();
  let index = startIndex;
  let written = 0;
  // The compositor pushes frames faster than the target rate on a simple scene,
  // so frames are admitted on a wall-clock schedule rather than one-per-event —
  // otherwise the finished video runs fast.
  const intervalMs = 1000 / Math.max(1, fps);
  let nextDueAt = 0;

  const onFrame = async ({ data, sessionId }) => {
    // ACK every frame even when dropping it, or Chrome stops sending.
    try { await client.send('Page.screencastFrameAck', { sessionId }); } catch { /* torn down */ }
    const now = Date.now();
    if (now < nextDueAt) return;
    nextDueAt = Math.max(now, nextDueAt) + intervalMs;
    try {
      fs.writeFileSync(path.join(frameDir, frameFileName(index)), Buffer.from(data, 'base64'));
      index += 1;
      written += 1;
    } catch { /* disk full or dir removed mid-take; reported by the count */ }
  };

  client.on('Page.screencastFrame', onFrame);
  const startedAt = Date.now();
  nextDueAt = startedAt;
  await client.send('Page.startScreencast', { format: 'png', everyNthFrame: 1 });
  await sleep(durationMs);
  try { await client.send('Page.stopScreencast'); } catch { /* already gone */ }
  client.off('Page.screencastFrame', onFrame);
  // Let the last in-flight frame land before the caller moves on.
  await sleep(120);
  try { await client.detach(); } catch { /* already detached */ }

  return { frames: written, nextIndex: index };
}

/**
 * Run a validated shot list end to end.
 *
 * @param {object} options
 * @param {object} options.page
 * @param {object} options.shotList
 * @param {string|null} options.frameDir  null disables capture entirely.
 * @param {(message: string) => void} [options.log]
 * @returns {Promise<{steps: object[], frames: number, ok: boolean}>}
 */
export async function runShotList({ page, shotList, frameDir, log = () => {} }) {
  const results = [];
  let frameIndex = 0;
  let totalFrames = 0;

  for (const step of shotList.steps) {
    const startedAt = Date.now();
    let result = null;

    if (step.tool) {
      log(`[${step.index + 1}/${shotList.steps.length}] ${step.label}`);
      result = await executeTool(page, step.tool, step.args);
      if (!result.ok) log(`  ! ${result.error || 'tool reported failure'}`);
    } else {
      log(`[${step.index + 1}/${shotList.steps.length}] ${step.label}`);
    }

    if (step.settleMs > 0) {
      await waitForSceneQuiet(page, step.settleMs);
      // waitForSceneQuiet returns as soon as the scene is quiet, which is
      // usually well before settleMs. Hold the remainder so a shot list's
      // pacing is what its author wrote, not whatever the tiles did.
      const remaining = step.settleMs - (Date.now() - startedAt);
      if (remaining > 0) await sleep(remaining);
    }

    if (step.record && frameDir) {
      const capture = await captureWindow({
        page,
        frameDir,
        durationMs: step.durationMs,
        fps: shotList.capture.fps,
        startIndex: frameIndex,
      });
      frameIndex = capture.nextIndex;
      totalFrames += capture.frames;
      log(`  captured ${capture.frames} frames`);
    } else if (step.hold > 0) {
      await sleep(step.hold);
    }

    results.push({
      index: step.index,
      label: step.label,
      tool: step.tool,
      ok: result ? result.ok !== false : true,
      result,
      elapsedMs: Date.now() - startedAt,
    });
  }

  return {
    steps: results,
    frames: totalFrames,
    ok: results.every((step) => step.ok),
  };
}
