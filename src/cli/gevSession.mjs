// src/cli/gevSession.mjs
/**
 * A long-lived GEV browser session, shared across MCP tool calls.
 *
 * This is the one real architectural difference between the CLI and the MCP
 * server. The CLI runs a command and exits, so launching a browser per
 * invocation is fine. An MCP server is a conversation: an agent may call
 * `fly_to_location`, then `set_layer_visibility`, then `gev_screenshot`, and
 * each of those must land on the SAME globe. Booting per call would both lose
 * all state and cost a fresh boot every time.
 *
 * So the session is lazily booted on first use and reused, with three
 * properties that matter under an agent's usage pattern:
 *
 *   - CONCURRENT CALLS SHARE ONE BOOT. Agents pipeline requests; two calls
 *     arriving during startup must await the same launch, not race two
 *     browsers into existence.
 *   - A CRASHED PAGE HEALS. If the tab dies, the next call reboots instead of
 *     failing forever with a detached-frame error.
 *   - IDLE SESSIONS CLOSE. An agent that wanders off should not leave Chrome
 *     resident indefinitely.
 *
 * @module cli/gevSession
 */

import { executeTool, launchGev, waitForSceneQuiet } from './driver.mjs';

/** Close the browser after this long with no tool calls. */
export const DEFAULT_IDLE_TIMEOUT_MS = 15 * 60_000;
/** Default settle before a screenshot — half-resolved terrain looks broken. */
export const DEFAULT_SCREENSHOT_SETTLE_MS = 4_000;

export class GevSession {
  /**
   * @param {object} options
   * @param {import('puppeteer')} options.puppeteer
   * @param {string} options.url
   * @param {{width: number, height: number}} [options.viewport]
   * @param {boolean} [options.headful]
   * @param {number} [options.idleTimeoutMs]
   * @param {(message: string) => void} [options.log]
   */
  constructor({
    puppeteer,
    url,
    viewport = { width: 1600, height: 900 },
    headful = false,
    idleTimeoutMs = DEFAULT_IDLE_TIMEOUT_MS,
    log = () => {},
  }) {
    this.puppeteer = puppeteer;
    this.url = url;
    this.viewport = viewport;
    this.headful = headful;
    this.idleTimeoutMs = idleTimeoutMs;
    this.log = log;

    this.session = null;
    /** @type {Promise<object>|null} In-flight boot, shared by concurrent callers. */
    this.booting = null;
    this.toolCalls = 0;
    this.startedAt = null;
    this.lastUsedAt = null;
    this.idleTimer = null;
  }

  /** True when a live page is attached and usable. */
  isRunning() {
    return Boolean(this.session && !this.session.page.isClosed());
  }

  /**
   * Boot if needed and return the live session.
   *
   * Concurrent callers await one promise: an agent that fires three tool calls
   * at once must not launch three browsers.
   */
  async ensureReady() {
    if (this.isRunning()) return this.session;
    // A page that died (crash, manual close) leaves a stale handle behind —
    // drop it so this boots fresh instead of failing forever on a dead frame.
    if (this.session) {
      this.log('GEV page is gone; restarting');
      await this.close({ keepIdleTimer: true });
    }
    if (!this.booting) {
      this.booting = (async () => {
        const session = await launchGev({
          puppeteer: this.puppeteer,
          url: this.url,
          viewport: this.viewport,
          headful: this.headful,
          log: this.log,
        });
        this.session = session;
        this.startedAt = Date.now();
        return session;
      })().finally(() => { this.booting = null; });
    }
    return this.booting;
  }

  /** Restart the idle countdown. Called on every use. */
  touch() {
    this.lastUsedAt = Date.now();
    if (this.idleTimer) clearTimeout(this.idleTimer);
    if (!this.idleTimeoutMs || this.idleTimeoutMs <= 0) return;
    this.idleTimer = setTimeout(() => {
      this.log('closing idle GEV session');
      this.close().catch(() => { /* nothing left to do about it */ });
    }, this.idleTimeoutMs);
    // Never hold the process open just to time out a browser.
    if (typeof this.idleTimer.unref === 'function') this.idleTimer.unref();
  }

  /**
   * Run one GEV tool on the shared page.
   *
   * @param {string} tool
   * @param {object} args
   * @returns {Promise<object>} The bridge's `{ok, ...}` envelope.
   */
  async execute(tool, args = {}) {
    const { page } = await this.ensureReady();
    this.touch();
    this.toolCalls += 1;
    return executeTool(page, tool, args);
  }

  /**
   * Capture the globe as a PNG, after letting the scene settle.
   *
   * @param {object} [options]
   * @param {number} [options.settleMs]
   * @returns {Promise<{png: Buffer, settled: boolean}>}
   */
  async screenshot({ settleMs = DEFAULT_SCREENSHOT_SETTLE_MS } = {}) {
    const { page } = await this.ensureReady();
    this.touch();
    const settled = await waitForSceneQuiet(page, settleMs);
    // Cesium renders to a WebGL canvas; a normal page screenshot captures the
    // composited frame, which is what the user would see.
    const png = await page.screenshot({ type: 'png', fullPage: false });
    return { png: Buffer.from(png), settled };
  }

  /** Key-free state for the `gev_session_status` tool. */
  status() {
    return {
      running: this.isRunning(),
      booting: Boolean(this.booting),
      url: this.url,
      viewport: { ...this.viewport },
      toolCalls: this.toolCalls,
      uptimeMs: this.startedAt && this.isRunning() ? Date.now() - this.startedAt : 0,
      idleMs: this.lastUsedAt ? Date.now() - this.lastUsedAt : 0,
      idleTimeoutMs: this.idleTimeoutMs,
    };
  }

  /**
   * Close the browser. Safe to call when nothing is running.
   *
   * @param {object} [options]
   * @param {boolean} [options.keepIdleTimer] Internal: a restart, not a shutdown.
   */
  async close({ keepIdleTimer = false } = {}) {
    if (!keepIdleTimer && this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    const session = this.session;
    this.session = null;
    this.startedAt = null;
    if (session) await session.close();
  }
}
