// Hand-written SVG small multiples (no chart deps): one panel per habit, x = round, y = rate 0..1,
// a line + 95% CI band per series, dashed 50% line, optional shaded target band.
type Pt = { p: number; lo: number; hi: number };
export interface Panel {
  title: string;
  series: Array<{ name: string; color: string; points: Pt[] }>;
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");

export function svgPanels(panels: Panel[], o: { yLabel: string; title: string; band?: [number, number] }): string {
  const pw = 300, ph = 220, m = { l: 46, r: 12, t: 30, b: 34 };
  const W = pw * panels.length + 20, H = ph + 80;
  const out: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" font-family="system-ui, -apple-system, Segoe UI, sans-serif" font-size="11">`,
    `<rect width="100%" height="100%" fill="#ffffff"/>`,
    `<text x="12" y="20" font-size="14" font-weight="600" fill="#1d2330">${esc(o.title)}</text>`,
  ];
  panels.forEach((pan, pi) => {
    const x0 = 10 + pi * pw + m.l, y0 = 30 + m.t, iw = pw - m.l - m.r, ih = ph - m.t - m.b;
    const n = pan.series[0].points.length;
    const X = (i: number) => x0 + (n === 1 ? iw / 2 : (i * iw) / (n - 1));
    const Y = (v: number) => y0 + ih - v * ih;
    out.push(`<text x="${x0}" y="${y0 - 10}" font-size="12" font-weight="600" fill="#1d2330">${esc(pan.title)}</text>`);
    if (o.band) out.push(`<rect x="${x0}" y="${Y(o.band[1])}" width="${iw}" height="${Y(o.band[0]) - Y(o.band[1])}" fill="#2fa36b" opacity="0.08"/>`);
    for (let g = 0; g <= 4; g++) {
      const v = g / 4;
      out.push(`<line x1="${x0}" x2="${x0 + iw}" y1="${Y(v)}" y2="${Y(v)}" stroke="#e3e6eb"/>`);
      out.push(`<text x="${x0 - 6}" y="${Y(v) + 4}" text-anchor="end" fill="#5b6270">${Math.round(v * 100)}%</text>`);
    }
    out.push(`<line x1="${x0}" x2="${x0 + iw}" y1="${Y(0.5)}" y2="${Y(0.5)}" stroke="#9aa1ad" stroke-dasharray="4 3"/>`);
    for (let i = 0; i < n; i++) out.push(`<text x="${X(i)}" y="${y0 + ih + 16}" text-anchor="middle" fill="#5b6270">${i + 1}</text>`);
    out.push(`<text x="${x0 + iw / 2}" y="${y0 + ih + 30}" text-anchor="middle" fill="#5b6270">round</text>`);
    if (pi === 0) out.push(`<text transform="translate(${x0 - 36},${y0 + ih / 2}) rotate(-90)" text-anchor="middle" fill="#5b6270">${esc(o.yLabel)}</text>`);
    for (const s of pan.series) {
      const band = s.points
        .map((p, i) => `${X(i)},${Y(p.hi)}`)
        .concat(s.points.map((p, i) => `${X(i)},${Y(p.lo)}`).reverse())
        .join(" ");
      out.push(`<polygon points="${band}" fill="${s.color}" opacity="0.15"/>`);
      out.push(`<polyline points="${s.points.map((p, i) => `${X(i)},${Y(p.p)}`).join(" ")}" fill="none" stroke="${s.color}" stroke-width="2.2"/>`);
      s.points.forEach((p, i) =>
        out.push(`<circle cx="${X(i)}" cy="${Y(p.p)}" r="3" fill="${s.color}"><title>${esc(s.name)} round ${i + 1}: ${(p.p * 100).toFixed(1)}% [${(p.lo * 100).toFixed(1)}-${(p.hi * 100).toFixed(1)}]</title></circle>`),
      );
    }
  });
  let lx = 12;
  for (const s of panels[0].series) {
    out.push(`<rect x="${lx}" y="${H - 22}" width="14" height="4" fill="${s.color}"/><text x="${lx + 20}" y="${H - 17}" fill="#1d2330">${esc(s.name)}</text>`);
    lx += 30 + s.name.length * 6.2;
  }
  if (o.band) out.push(`<rect x="${lx}" y="${H - 26}" width="14" height="10" fill="#2fa36b" opacity="0.15"/><text x="${lx + 20}" y="${H - 17}" fill="#1d2330">35-65% fairness band</text>`);
  out.push("</svg>");
  return out.join("\n");
}
