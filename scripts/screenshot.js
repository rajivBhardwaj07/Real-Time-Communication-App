// Generates screenshots/*.png for the README.
// Uses Playwright with fake-media flags so getUserMedia / getDisplayMedia don't prompt.

const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const BASE = 'http://localhost:3000';
const OUT_DIR = path.join(__dirname, '..', 'screenshots');
fs.mkdirSync(OUT_DIR, { recursive: true });

const VIEWPORT = { width: 1440, height: 900 };

async function shot(page, name) {
  const p = path.join(OUT_DIR, `${name}.png`);
  await page.screenshot({ path: p, fullPage: false });
  console.log('  ->', path.relative(process.cwd(), p));
}

async function newCtx(browser, userTag) {
  const ctx = await browser.newContext({
    viewport: VIEWPORT,
    permissions: ['camera', 'microphone'],
  });
  const page = await ctx.newPage();
  page.on('console', (m) => {
    if (m.type() === 'error') console.log(`[${userTag} console.error]`, m.text());
  });
  return { ctx, page };
}

// Register-or-login: tries register first, falls back to login if username taken.
async function authenticate(page, username, password) {
  await page.goto(BASE);
  await page.click('#tab-register');
  await page.fill('#username', username);
  await page.fill('#password', password);
  await page.click('#auth-submit');
  // wait for either lobby to appear, or error (already-registered)
  try {
    await page.waitForSelector('#lobby:not(.hidden)', { timeout: 2500 });
  } catch {
    await page.click('#tab-login');
    await page.fill('#username', username);
    await page.fill('#password', password);
    await page.click('#auth-submit');
    await page.waitForSelector('#lobby:not(.hidden)', { timeout: 5000 });
  }
}

async function joinRoom(page, room, pass) {
  await page.fill('#room', room);
  await page.fill('#passphrase', pass);
  await page.click('#join');
  await page.waitForSelector('#app:not(.hidden)', { timeout: 10000 });
  // give WebRTC handshakes a moment
  await page.waitForTimeout(2500);
}

(async () => {
  const browser = await chromium.launch({
    headless: true,
    args: [
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      '--auto-accept-camera-and-microphone-capture',
    ],
  });

  // --- 1. Auth screen
  console.log('Screenshot: auth screen');
  const a1 = await newCtx(browser, 'A');
  await a1.page.goto(BASE);
  await a1.page.waitForSelector('#auth:not(.hidden)');
  await shot(a1.page, '01-login');

  // register tab variant
  await a1.page.click('#tab-register');
  await a1.page.waitForTimeout(150);
  await shot(a1.page, '02-register');

  // --- 2. Register user A and capture lobby
  console.log('Screenshot: lobby');
  const userA = 'alice_' + Date.now().toString(36);
  const userB = 'bob_' + Date.now().toString(36);
  const room = 'demo-room';
  const pass = 'shared-secret';

  await authenticate(a1.page, userA, 'password123');
  await shot(a1.page, '03-lobby');

  // --- 3. Two-user call: A joins, then B joins
  console.log('Screenshot: in-call (2 users)');
  await joinRoom(a1.page, room, pass);

  const b1 = await newCtx(browser, 'B');
  await authenticate(b1.page, userB, 'password123');
  await joinRoom(b1.page, room, pass);

  // back to A, wait for B's tile, then screenshot
  await a1.page.bringToFront();
  await a1.page.waitForFunction(
    () => document.querySelectorAll('#videos .video-tile').length >= 2,
    null,
    { timeout: 8000 }
  ).catch(() => console.log('  (only one tile detected; capturing anyway)'));
  await a1.page.waitForTimeout(1500);

  // Send a couple of chat messages so the chat pane has content.
  await a1.page.fill('#chat-input', 'Hey Bob — can you see my screen?');
  await a1.page.press('#chat-input', 'Enter');
  await a1.page.waitForTimeout(300);
  await b1.page.fill('#chat-input', 'Yep, looks great!');
  await b1.page.press('#chat-input', 'Enter');
  await a1.page.waitForTimeout(600);

  await shot(a1.page, '04-in-call');

  // --- 4. Whiteboard
  console.log('Screenshot: whiteboard');
  await a1.page.click('#btn-board');
  await a1.page.waitForSelector('#board-wrap:not(.hidden)');
  await a1.page.waitForTimeout(300);

  // Draw something on the whiteboard via pointer events on the canvas.
  const canvas = await a1.page.$('#board');
  const box = await canvas.boundingBox();
  async function drawCurve(startX, startY, points, color) {
    await a1.page.evaluate((c) => {
      document.getElementById('board-color').value = c;
      document.getElementById('board-color').dispatchEvent(new Event('input'));
    }, color);
    await a1.page.mouse.move(box.x + startX, box.y + startY);
    await a1.page.mouse.down();
    for (const [dx, dy] of points) {
      await a1.page.mouse.move(box.x + dx, box.y + dy, { steps: 8 });
    }
    await a1.page.mouse.up();
  }

  // Sketch "Hello!" + an underline
  await drawCurve(120, 220, [[120,160],[140,140],[160,180],[160,260],[150,300]], '#7c5cff'); // H stroke left
  await drawCurve(160, 220, [[200,220]], '#7c5cff');                                          // H bar
  await drawCurve(200, 220, [[200,300]], '#7c5cff');                                          // H stroke right
  await drawCurve(240, 220, [[240,300],[290,300]], '#4cc9ff');                                // L1
  await drawCurve(320, 220, [[320,300],[370,300]], '#4cc9ff');                                // L2
  await drawCurve(400, 240, [[420,220],[450,240],[450,280],[420,300],[400,280],[400,240],[450,280]], '#2ee6a8'); // o-ish loop
  await drawCurve(490, 220, [[490,300]], '#ff5470');                                          // !
  await drawCurve(490, 320, [[490,322]], '#ff5470');                                          // ! dot
  await drawCurve(120, 360, [[600, 360]], '#7c5cff');                                          // underline

  await a1.page.waitForTimeout(500);
  await shot(a1.page, '05-whiteboard');

  // close whiteboard
  await a1.page.click('#board-close');

  console.log('Done.');
  await browser.close();
})().catch((err) => {
  console.error('Screenshot script failed:', err);
  process.exit(1);
});
