// frames.ts — the `game` view: a 384 px JPEG of the WebGL canvas for Gemini.
// The game's <Canvas> does not use preserveDrawingBuffer (that costs fill-rate),
// so we read the canvas from a requestAnimationFrame callback queued from a
// timer: it runs in the SAME frame, right after r3f's render (r3f queued its rAF
// earlier), while the drawing buffer is still intact. drawImage into a small 2D
// canvas does the downscale; toDataURL encodes JPEG. Cost is measured by the bridge.

let scratch: HTMLCanvasElement | null = null;

export function captureCanvasJpeg(src: HTMLCanvasElement, width = 384, quality = 0.6): Promise<string | null> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => {
      try {
        if (!src.width || !src.height) return resolve(null);
        const h = Math.round((src.height / src.width) * width);
        scratch ??= document.createElement("canvas");
        if (scratch.width !== width || scratch.height !== h) {
          scratch.width = width;
          scratch.height = h;
        }
        const ctx = scratch.getContext("2d");
        if (!ctx) return resolve(null);
        ctx.drawImage(src, 0, 0, width, h);
        const url = scratch.toDataURL("image/jpeg", quality);
        resolve(url.slice(url.indexOf(",") + 1));
      } catch {
        resolve(null); // tainted / lost context — never throw into the game
      }
    });
  });
}
