// src/cli/gevSession.test.mjs
// The session is what makes an agent's calls land on the SAME globe. Its three
// load-bearing behaviours — one boot under concurrency, healing a dead page,
// and closing when idle — are exactly the ones that only misbehave under an
// agent's usage pattern, so puppeteer is injected and they are asserted here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GevSession } from './gevSession.mjs';

/**
 * A puppeteer stand-in. `launchGev` calls executablePath(), launch(), newPage(),
 * goto() and waitForFunction(); this satisfies that contract without Chrome.
 */
function fakePuppeteer({ bootDelayMs = 0 } = {}) {
  const state = { launches: 0, closes: 0, pages: [] };
  return {
    state,
    executablePath: () => process.execPath, // a path that exists
    async launch() {
      state.launches += 1;
      if (bootDelayMs) await new Promise((r) => { setTimeout(r, bootDelayMs); });
      return {
        async newPage() {
          const page = {
            closed: false,
            calls: [],
            isClosed() { return this.closed; },
            on() {},
            // The driver suppresses the first-run launcher before bootstrap.
            async evaluateOnNewDocument() {},
            async goto() {},
            async waitForFunction() { return true; },
            async evaluate(_fn, tool, args) {
              this.calls.push({ tool, args });
              return { ok: true, tool, action: tool };
            },
            async screenshot() { return Buffer.from([0x89, 0x50, 0x4e, 0x47]); },
          };
          state.pages.push(page);
          return page;
        },
        async close() { state.closes += 1; state.pages.forEach((p) => { p.closed = true; }); },
      };
    },
  };
}

const makeSession = (puppeteer, overrides = {}) => new GevSession({
  puppeteer, url: 'http://localhost:5173', idleTimeoutMs: 0, ...overrides,
});

test('the browser boots once and is reused across calls', async () => {
  const puppeteer = fakePuppeteer();
  const session = makeSession(puppeteer);
  await session.execute('zoom_to_globe');
  await session.execute('fly_to_location', { query: 'Austin' });
  // Both calls must land on the same globe — a second boot would lose all state.
  assert.equal(puppeteer.state.launches, 1);
  assert.equal(session.toolCalls, 2);
  assert.deepEqual(puppeteer.state.pages[0].calls.map((c) => c.tool),
    ['zoom_to_globe', 'fly_to_location']);
  await session.close();
});

test('concurrent first calls share one boot instead of racing two browsers', async () => {
  const puppeteer = fakePuppeteer({ bootDelayMs: 25 });
  const session = makeSession(puppeteer);
  // Agents pipeline requests; this is the realistic first moment of a session.
  const results = await Promise.all([
    session.execute('zoom_to_globe'),
    session.execute('set_hud', { enabled: false }),
    session.execute('fly_to_location', { query: 'Austin' }),
  ]);
  assert.equal(puppeteer.state.launches, 1, 'one browser, not three');
  assert.equal(results.every((r) => r.ok), true);
  await session.close();
});

test('a dead page heals on the next call rather than failing forever', async () => {
  const puppeteer = fakePuppeteer();
  const session = makeSession(puppeteer);
  await session.execute('zoom_to_globe');
  assert.equal(session.isRunning(), true);

  // The tab crashed or was closed out from under us.
  puppeteer.state.pages[0].closed = true;
  assert.equal(session.isRunning(), false);

  const result = await session.execute('fly_to_location', { query: 'Austin' });
  assert.equal(result.ok, true);
  assert.equal(puppeteer.state.launches, 2, 'rebooted');
  assert.equal(puppeteer.state.closes, 1, 'and tore the dead one down');
  await session.close();
});

test('an idle session closes itself', async () => {
  const puppeteer = fakePuppeteer();
  const session = makeSession(puppeteer, { idleTimeoutMs: 30 });
  await session.execute('zoom_to_globe');
  assert.equal(session.isRunning(), true);
  await new Promise((r) => { setTimeout(r, 70); });
  assert.equal(session.isRunning(), false, 'Chrome should not stay resident forever');
  assert.equal(puppeteer.state.closes, 1);
});

test('each use restarts the idle countdown', async () => {
  const puppeteer = fakePuppeteer();
  const session = makeSession(puppeteer, { idleTimeoutMs: 60 });
  await session.execute('zoom_to_globe');
  await new Promise((r) => { setTimeout(r, 40); });
  await session.execute('zoom_to_globe');
  await new Promise((r) => { setTimeout(r, 40); });
  // 80ms total, but never 60ms idle — an active agent keeps its globe.
  assert.equal(session.isRunning(), true);
  await session.close();
});

test('a screenshot settles the scene first and returns PNG bytes', async () => {
  const puppeteer = fakePuppeteer();
  const session = makeSession(puppeteer);
  const { png, settled } = await session.screenshot({ settleMs: 10 });
  assert.ok(Buffer.isBuffer(png));
  assert.deepEqual([...png.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47], 'a real PNG header');
  assert.equal(settled, true);
  await session.close();
});

test('status reports what an agent needs without starting anything', async () => {
  const puppeteer = fakePuppeteer();
  const session = makeSession(puppeteer);
  const before = session.status();
  assert.equal(before.running, false);
  assert.equal(before.toolCalls, 0);
  assert.equal(puppeteer.state.launches, 0, 'asking must never boot the browser');

  await session.execute('zoom_to_globe');
  const after = session.status();
  assert.equal(after.running, true);
  assert.equal(after.toolCalls, 1);
  assert.equal(after.url, 'http://localhost:5173');
  await session.close();
});

test('closing is idempotent and safe before any boot', async () => {
  const puppeteer = fakePuppeteer();
  const session = makeSession(puppeteer);
  await session.close();
  await session.execute('zoom_to_globe');
  await session.close();
  await session.close();
  assert.equal(puppeteer.state.closes, 1);
  assert.equal(session.isRunning(), false);
});
