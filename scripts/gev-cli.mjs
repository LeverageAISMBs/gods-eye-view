#!/usr/bin/env node
/**
 * gev — drive God's Eye View from the command line, or from an AI agent.
 *
 * GEV already exposes 28 capabilities to its voice model. This hands the same
 * set to anything that can run a command: list the tools and their schemas,
 * execute one, or replay a shot list while capturing footage.
 *
 *   gev tools [--json]                       what can be driven, with schemas
 *   gev exec <tool> [--args '{...}']         run one tool, print the result
 *   gev run <shotlist.json>                  replay a plan, no capture
 *   gev record <shotlist.json> --out <dir>   replay it and capture frames/video
 *
 * Requires a running GEV server (`npm run dev`); point elsewhere with --url.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';
import { GEV_REALTIME_TOOLS } from '../vite.config.js';
import { intFlag, jsonObjectFlag, parseArgs } from '../src/cli/cliArgs.mjs';
import { estimateDurationMs, recordingSteps, validateShotList } from '../src/cli/shotList.mjs';
import { ffmpegArgs, ffmpegCommandLine } from '../src/cli/capturePlan.mjs';
import { executeTool, launchGev, runShotList, waitForSceneQuiet } from '../src/cli/driver.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_URL = process.env.GEV_CLI_URL || 'http://localhost:5173';
const TOOL_NAMES = new Set(GEV_REALTIME_TOOLS.map((tool) => tool.name));

const USAGE = `gev — drive God's Eye View from the command line

  gev tools [--json]                        List the ${TOOL_NAMES.size} drivable tools
  gev exec <tool> [--args '<json>']         Run one tool and print its result
  gev run <shotlist.json>                   Replay a shot list (no capture)
  gev record <shotlist.json> --out <dir>    Replay it and capture frames + video

Options
  --url <url>        GEV server (default ${DEFAULT_URL})
  --out <dir>        Output directory (record)
  --fps <n>          Override the shot list's capture rate
  --width/--height   Override the viewport
  --headful          Show the browser
  --json             Machine-readable output
  --no-encode        Keep frames, skip the ffmpeg step
  --keep-frames      Keep frames after a successful encode
  --quiet            Errors only

A shot list is JSON: an ordered plan of tool calls, waits and capture windows.

  {
    "name": "austin-flights",
    "viewport": { "width": 1920, "height": 1080 },
    "capture": { "fps": 30 },
    "steps": [
      { "tool": "set_layer_visibility", "args": { "layerId": "flights", "visible": true } },
      { "tool": "fly_to_location", "args": { "query": "Austin, Texas" }, "settleMs": 5000 },
      { "tool": "move_camera", "args": { "motion": "orbit" }, "record": true, "durationMs": 8000 }
    ]
  }
`;

function fail(message, { code = 1 } = {}) {
  process.stderr.write(`gev: ${message}\n`);
  process.exit(code);
}

/** Read a shot list from a path, or from stdin when the path is "-". */
function readShotListSource(file) {
  if (file === '-') return fs.readFileSync(0, 'utf8');
  const resolved = path.resolve(process.cwd(), file);
  if (!fs.existsSync(resolved)) throw new Error(`shot list not found: ${resolved}`);
  return fs.readFileSync(resolved, 'utf8');
}

function loadShotList(file, flags) {
  let parsed;
  try {
    parsed = JSON.parse(readShotListSource(file));
  } catch (error) {
    fail(`could not read shot list — ${error.message}`);
  }
  const { ok, shotList, errors } = validateShotList(parsed, {
    isKnownTool: (name) => TOOL_NAMES.has(name),
  });
  if (!ok) {
    // Every problem at once: one round of fixes, not one per run.
    fail(`shot list is invalid:\n  - ${errors.join('\n  - ')}`);
  }

  // CLI overrides win over the file, so one plan can be re-shot at other sizes.
  const fpsFlag = intFlag(flags, 'fps', shotList.capture.fps);
  const widthFlag = intFlag(flags, 'width', shotList.viewport.width);
  const heightFlag = intFlag(flags, 'height', shotList.viewport.height);
  for (const { error } of [fpsFlag, widthFlag, heightFlag]) if (error) fail(error);

  return {
    ...shotList,
    capture: { fps: fpsFlag.value },
    viewport: { width: widthFlag.value, height: heightFlag.value },
  };
}

function encodeFrames({ frameDir, outputFile, fps, log }) {
  const probe = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' });
  if (probe.error || probe.status !== 0) {
    // ffmpeg is not a dependency of this repo and is missing on plenty of
    // machines. The frames ARE the deliverable either way; print the command
    // rather than failing a take that already succeeded.
    log('ffmpeg not found — frames kept. Encode them with:');
    log(`  ${ffmpegCommandLine({ frameDir, outputFile, fps })}`);
    return { encoded: false, outputFile: null };
  }
  const result = spawnSync('ffmpeg', ffmpegArgs({ frameDir, outputFile, fps }), { stdio: 'ignore' });
  if (result.status !== 0) {
    log(`ffmpeg exited ${result.status}; frames kept at ${frameDir}`);
    return { encoded: false, outputFile: null };
  }
  return { encoded: true, outputFile };
}

async function withGev({ url, viewport, headful, showFirstRun, log }, work) {
  const session = await launchGev({ puppeteer, url, viewport, headful, showFirstRun, log });
  try {
    return await work(session);
  } finally {
    await session.close();
  }
}

async function main() {
  const { command, positional, flags, errors } = parseArgs(process.argv.slice(2));
  if (errors.length) fail(errors.join('; '));
  if (!command || flags.help || command === 'help') {
    process.stdout.write(USAGE);
    process.exit(command && !flags.help ? 1 : 0);
  }

  const quiet = flags.quiet === true;
  const asJson = flags.json === true;
  const log = (message) => { if (!quiet && !asJson) process.stdout.write(`${message}\n`); };
  const url = typeof flags.url === 'string' ? flags.url : DEFAULT_URL;

  if (command === 'tools') {
    if (asJson) {
      process.stdout.write(`${JSON.stringify(GEV_REALTIME_TOOLS, null, 2)}\n`);
      return;
    }
    process.stdout.write(`${TOOL_NAMES.size} drivable tools\n\n`);
    for (const tool of GEV_REALTIME_TOOLS) {
      const params = Object.keys(tool.parameters?.properties || {});
      const required = new Set(tool.parameters?.required || []);
      const signature = params.map((p) => (required.has(p) ? p : `${p}?`)).join(', ');
      process.stdout.write(`  ${tool.name}(${signature})\n`);
      process.stdout.write(`      ${String(tool.description || '').split('. ')[0]}.\n`);
    }
    process.stdout.write('\nFull schemas: gev tools --json\n');
    return;
  }

  if (command === 'exec') {
    const tool = positional[0];
    if (!tool) fail('exec needs a tool name — see `gev tools`');
    if (!TOOL_NAMES.has(tool)) fail(`unknown tool "${tool}" — see \`gev tools\``);
    const { value: args, error } = jsonObjectFlag(flags.args);
    if (error) fail(error);

    const width = intFlag(flags, 'width', 1600);
    const height = intFlag(flags, 'height', 900);
    // GEV runs its own opening camera move on boot. Firing a navigation tool
    // into that gets the tool's flight CANCELLED — a real result, but never the
    // one the caller wanted. Let the scene go quiet first.
    const settle = intFlag(flags, 'settle', 4000);
    for (const { error } of [width, height, settle]) if (error) fail(error);

    const result = await withGev({
      url,
      viewport: { width: width.value, height: height.value },
      headful: flags.headful === true,
      showFirstRun: flags['show-first-run'] === true,
      log,
    }, async ({ page }) => {
      await waitForSceneQuiet(page, settle.value);
      return executeTool(page, tool, args);
    });

    process.stdout.write(`${JSON.stringify(result, null, asJson ? 0 : 2)}\n`);
    process.exit(result.ok ? 0 : 2);
  }

  if (command === 'run' || command === 'record') {
    const file = positional[0];
    if (!file) fail(`${command} needs a shot list — see \`gev help\``);
    const shotList = loadShotList(file, flags);
    const recording = command === 'record';

    let frameDir = null;
    let outDir = null;
    if (recording) {
      if (!flags.out) fail('record needs --out <dir>');
      outDir = path.resolve(process.cwd(), String(flags.out));
      frameDir = path.join(outDir, 'frames');
      fs.mkdirSync(frameDir, { recursive: true });
      if (!recordingSteps(shotList).length) {
        fail('no step in this shot list has "record": true — nothing would be captured');
      }
    }

    const seconds = Math.round(estimateDurationMs(shotList) / 100) / 10;
    log(`${shotList.name}: ${shotList.steps.length} steps, ~${seconds}s at `
      + `${shotList.viewport.width}x${shotList.viewport.height}`);

    const outcome = await withGev({
      url,
      viewport: shotList.viewport,
      headful: flags.headful === true,
      showFirstRun: flags['show-first-run'] === true,
      log,
    }, ({ page }) => runShotList({ page, shotList, frameDir, log }));

    let video = null;
    if (recording && outcome.frames > 0 && flags['no-encode'] !== true) {
      const encoded = encodeFrames({
        frameDir,
        outputFile: path.join(outDir, `${shotList.name}.mp4`),
        fps: shotList.capture.fps,
        log,
      });
      video = encoded.outputFile;
      if (encoded.encoded && flags['keep-frames'] !== true) {
        fs.rmSync(frameDir, { recursive: true, force: true });
      }
    }

    const summary = {
      name: shotList.name,
      ok: outcome.ok,
      steps: outcome.steps.map(({ index, label, tool, ok, elapsedMs }) => (
        { index, label, tool, ok, elapsedMs }
      )),
      frames: outcome.frames,
      video,
      frameDir: video && flags['keep-frames'] !== true ? null : frameDir,
    };

    if (asJson) {
      process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    } else {
      const failed = outcome.steps.filter((step) => !step.ok);
      log(failed.length ? `\n${failed.length} step(s) failed:` : '\nall steps ok');
      for (const step of failed) log(`  step ${step.index + 1} ${step.label}: ${step.result?.error || 'failed'}`);
      if (video) log(`video: ${video}`);
      else if (outcome.frames) log(`frames: ${frameDir} (${outcome.frames})`);
    }
    process.exit(outcome.ok ? 0 : 2);
  }

  fail(`unknown command "${command}" — see \`gev help\``);
}

main().catch((error) => fail(error?.message || String(error)));
