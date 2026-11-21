// Record a scripted demo scene (?autopilot=<scene>) at 1920x1080 → webm → mp4.
//   npm run dev                      (vite on :5174, or pass BASE_URL)
//   node scripts/record/record.mjs <scene> [maxSeconds]
//     scene: flank_left | rush_open_mid
//   env: BASE_URL=http://localhost:5174  CHANNEL=chrome (default)  HEADLESS=1 (software GL)
//        ROUNDS=n  stop after n finished rounds (default: until match end or maxSeconds, default 240)
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";

const scene = process.argv[2] ?? "flank_left";
const maxSec = Number(process.argv[3] ?? 240);
const rounds = process.env.ROUNDS ? Number(process.env.ROUNDS) : Infinity;
const base = process.env.BASE_URL ?? "http://localhost:5174";
const url = `${base.replace(/\/$/, "")}/?autopilot=${encodeURIComponent(scene)}`;
const outDir = resolve("recordings");
mkdirSync(outDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const W = 1920, H = 1080;

const browser = await chromium.launch({
  channel: process.env.CHANNEL ?? "chrome",
  headless: !!process.env.HEADLESS,
  args: ["--autoplay-policy=no-user-gesture-required", `--window-size=${W},${H + 140}`, "--ignore-gpu-blocklist"],
});
const ctx = await browser.newContext({ viewport: { width: W, height: H } });
const page = await ctx.newPage();

// Capture via CDP screencast (JPEG frames) piped into Homebrew ffmpeg, which
// timestamps them by wall clock and resamples to constant 30 fps H.264.
// (Playwright's recordVideo needs its own ffmpeg download; this avoids it.)
const mp4 = resolve(outDir, `${scene}-${stamp}.mp4`);
const ffmpeg = existsSync("/opt/homebrew/bin/ffmpeg") ? "/opt/homebrew/bin/ffmpeg" : "ffmpeg";
const ff = spawn(ffmpeg, ["-y", "-loglevel", "error", "-f", "image2pipe", "-use_wallclock_as_timestamps", "1", "-c:v", "mjpeg", "-i", "-",
  "-vf", `scale=${W}:${H}:flags=lanczos,fps=30`, "-fps_mode", "cfr", "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-pix_fmt", "yuv420p", "-movflags", "+faststart", mp4], { stdio: ["pipe", "inherit", "inherit"] });
const cdp = await ctx.newCDPSession(page);
let frames = 0;
cdp.on("Page.screencastFrame", (f) => {
  ff.stdin.write(Buffer.from(f.data, "base64"));
  frames++;
  cdp.send("Page.screencastFrameAck", { sessionId: f.sessionId }).catch(() => {});
});
await cdp.send("Page.startScreencast", { format: "jpeg", quality: 92, maxWidth: W, maxHeight: H, everyNthFrame: 1 });
page.on("console", (m) => m.text().startsWith("[autopilot]") && console.log(m.text()));
const t0 = Date.now();
await page.goto(url, { waitUntil: "load", timeout: 60000 });
await page.waitForSelector("canvas", { timeout: 30000 });

let lastLog = "";
while ((Date.now() - t0) / 1000 < maxSec) {
  await page.waitForTimeout(1000);
  const s = await page.evaluate(() => {
    const m = window.__valor?.useMatch?.getState?.();
    const ap = window.__autopilot;
    return { phase: m?.phase, round: m?.round, score: m?.score, history: m?.history?.length ?? m?.rounds?.length, wp: ap?.wp, pos: ap?.pos, target: ap?.target };
  });
  const line = `t=${Math.round((Date.now() - t0) / 1000)}s phase=${s.phase} round=${s.round} score=${JSON.stringify(s.score)} wp=${s.wp}@${s.pos} target=${s.target}`;
  if (true) console.log(line), (lastLog = line.replace(/t=\d+s /, ""));
  if (s.phase === "match_end") { await page.waitForTimeout(5000); break; }
  const done = s.score ? (s.score.blue ?? 0) + (s.score.red ?? 0) : 0;
  if (done >= rounds && s.phase !== "live") { await page.waitForTimeout(3000); break; }
}

await cdp.send("Page.stopScreencast").catch(() => {});
await browser.close();
ff.stdin.end();
await new Promise((r) => ff.on("close", r));
console.log(`saved ${mp4} (${frames} frames captured)`);
