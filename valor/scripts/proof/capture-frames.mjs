// Saves real 384 px `game` frames (exactly what the bridge sends Gemini) to docs/proof/frames/.
// Runs the same capture algorithm as src/agent/frames.ts inside the running game.
//   npm run dev            (in another terminal; vite on :5174)
//   node scripts/proof/capture-frames.mjs [url]     HEADED=1 for a real GPU window
import { chromium } from "playwright";
import { mkdirSync, writeFileSync } from "node:fs";

const URL = process.argv[2] ?? "http://localhost:5174/?game";
const OUT = "docs/proof/frames";
mkdirSync(OUT, { recursive: true });
const headed = !!process.env.HEADED;
const browser = await chromium.launch(headed ? { headless: false, channel: process.env.CHANNEL } : { channel: process.env.CHANNEL, args: ["--use-gl=angle", "--use-angle=swiftshader", "--ignore-gpu-blocklist", "--enable-webgl"] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
await page.goto(URL, { waitUntil: "load", timeout: 60000 });
await page.waitForSelector("canvas", { timeout: 20000 });
await page.waitForTimeout(8000);
const stats = [];
for (let i = 0; i < 3; i++) {
  // Same algorithm as src/agent/frames.ts (rAF read after r3f's render → 384 px 2D canvas → JPEG 0.6).
  const r = await page.evaluate(
    () =>
      new Promise((resolve) => {
        const t0 = performance.now();
        requestAnimationFrame(() => {
          const src = document.querySelector("canvas");
          const w = 384, h = Math.round((src.height / src.width) * w);
          const c = document.createElement("canvas");
          c.width = w;
          c.height = h;
          c.getContext("2d").drawImage(src, 0, 0, w, h);
          const url = c.toDataURL("image/jpeg", 0.6);
          resolve({ b64: url.slice(url.indexOf(",") + 1), ms: performance.now() - t0 });
        });
      }),
  );
  if (r.b64) {
    writeFileSync(`${OUT}/game_${i + 1}.jpg`, Buffer.from(r.b64, "base64"));
    stats.push({ file: `game_${i + 1}.jpg`, bytes: Math.round((r.b64.length * 3) / 4), capture_ms: +r.ms.toFixed(1) });
  }
  await page.mouse.move(400 + i * 200, 360);
  await page.waitForTimeout(1500);
}
writeFileSync(`${OUT}/frames.json`, JSON.stringify({ url: URL, headed, note: "headless uses SwiftShader (software GL): capture_ms is pessimistic vs a real GPU", frames: stats }, null, 2));
console.log(stats);
await browser.close();
