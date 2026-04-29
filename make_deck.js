const pptxgen = require("pptxgenjs");

let pres = new pptxgen();
pres.layout = 'LAYOUT_16x9';
pres.author = 'Victor';
pres.title = 'Kalshi Whale Tracker';

const BG    = "080B14";
const CARD  = "111820";
const CYAN  = "00D4FF";
const GOLD  = "E3B341";
const WHITE = "E6EDF3";
const MUTED = "6B7280";
const DIM   = "4A5568";
const GREEN = "3FB950";
const PURPLE= "BC8CFF";
const FOOTER= "0A1628";

// ─── SLIDE 1 — Title ───────────────────────────────────────────────────────
{
  let s = pres.addSlide();
  s.background = { color: BG };

  // Grid lines (decorative)
  for (let i = 0; i < 6; i++) {
    s.addShape(pres.shapes.LINE, { x: 0, y: 0.9 + i * 0.85, w: 10, h: 0,
      line: { color: "111820", width: 0.5 } });
  }
  for (let i = 0; i < 12; i++) {
    s.addShape(pres.shapes.LINE, { x: 0.85 * i, y: 0, w: 0, h: 5.625,
      line: { color: "0D1117", width: 0.5 } });
  }

  // Top accent
  s.addShape(pres.shapes.RECTANGLE, { x: 0, y: 0, w: 10, h: 0.06,
    fill: { color: CYAN }, line: { color: CYAN } });

  // Whale emoji
  s.addText("🐳", { x: 4.3, y: 0.85, w: 1.4, h: 1.0,
    fontSize: 52, align: "center", margin: 0 });

  // Title
  s.addText("KALSHI WHALE TRACKER", { x: 0.5, y: 1.85, w: 9, h: 0.9,
    fontSize: 42, bold: true, color: CYAN, fontFace: "Consolas",
    align: "center", charSpacing: 3, margin: 0 });

  // Subtitle
  s.addText("Real-Time Prediction Market Intelligence", { x: 0.5, y: 2.82, w: 9, h: 0.5,
    fontSize: 17, color: WHITE, fontFace: "Calibri", align: "center", margin: 0 });

  // Gold divider
  s.addShape(pres.shapes.LINE, { x: 3.8, y: 3.48, w: 2.4, h: 0,
    line: { color: GOLD, width: 1.5 } });

  // Author
  s.addText("Victor", { x: 0.5, y: 3.62, w: 9, h: 0.4,
    fontSize: 15, color: GOLD, bold: true, fontFace: "Calibri",
    align: "center", margin: 0 });

  // Tagline
  s.addText("Follow the smart money.", { x: 0.5, y: 4.12, w: 9, h: 0.35,
    fontSize: 12, color: MUTED, italic: true, fontFace: "Calibri",
    align: "center", margin: 0 });

  // Footer bar
  s.addShape(pres.shapes.RECTANGLE, { x: 0, y: 5.45, w: 10, h: 0.175,
    fill: { color: FOOTER }, line: { color: FOOTER } });
}

// ─── SLIDE 2 — The Problem ────────────────────────────────────────────────
{
  let s = pres.addSlide();
  s.background = { color: BG };

  s.addShape(pres.shapes.RECTANGLE, { x: 0, y: 0, w: 10, h: 0.06,
    fill: { color: CYAN }, line: { color: CYAN } });
  s.addText("01 / 04", { x: 8.5, y: 0.18, w: 1.2, h: 0.25,
    fontSize: 8, color: DIM, fontFace: "Consolas", align: "right", margin: 0 });
  s.addText("PROBLEM", { x: 0.5, y: 0.18, w: 2, h: 0.25,
    fontSize: 8, color: CYAN, fontFace: "Consolas", charSpacing: 3, margin: 0 });
  s.addText("The Problem", { x: 0.5, y: 0.52, w: 9, h: 0.72,
    fontSize: 34, bold: true, color: WHITE, fontFace: "Calibri", margin: 0 });

  const problems = [
    { icon: "?", title: "No Signal Filtering",
      body: "Kalshi surfaces thousands of trades daily with no way to isolate high-conviction whale bets from the noise." },
    { icon: "$", title: "Smart Money Is Invisible",
      body: "A $50,000 single-direction trade looks identical to a $5 trade in the default Kalshi UI." },
    { icon: "!", title: "No Automation or Monitoring",
      body: "No way to automatically act on signals or monitor system health without constant manual supervision." }
  ];

  const cX = [0.4, 3.65, 6.9], cW = 2.9, cH = 3.3, cY = 1.48;

  problems.forEach((p, i) => {
    s.addShape(pres.shapes.RECTANGLE, { x: cX[i], y: cY, w: cW, h: cH,
      fill: { color: CARD }, line: { color: "1E2530", width: 1 },
      shadow: { type: "outer", blur: 8, offset: 2, angle: 135, color: "000000", opacity: 0.3 } });
    s.addShape(pres.shapes.RECTANGLE, { x: cX[i], y: cY, w: cW, h: 0.05,
      fill: { color: CYAN }, line: { color: CYAN } });
    s.addShape(pres.shapes.OVAL, { x: cX[i]+0.2, y: cY+0.18, w: 0.56, h: 0.56,
      fill: { color: "0D1F2D" }, line: { color: CYAN, width: 1.5 } });
    s.addText(p.icon, { x: cX[i]+0.2, y: cY+0.18, w: 0.56, h: 0.56,
      fontSize: 16, bold: true, color: CYAN, fontFace: "Consolas",
      align: "center", valign: "middle", margin: 0 });
    s.addText(p.title, { x: cX[i]+0.18, y: cY+0.88, w: cW-0.36, h: 0.46,
      fontSize: 14, bold: true, color: WHITE, fontFace: "Calibri", margin: 0 });
    s.addShape(pres.shapes.LINE, { x: cX[i]+0.18, y: cY+1.42, w: cW-0.36, h: 0,
      line: { color: "1E2530", width: 1 } });
    s.addText(p.body, { x: cX[i]+0.18, y: cY+1.55, w: cW-0.36, h: 1.55,
      fontSize: 11.5, color: MUTED, fontFace: "Calibri", wrap: true, margin: 0 });
  });

  s.addShape(pres.shapes.RECTANGLE, { x: 0, y: 5.45, w: 10, h: 0.175,
    fill: { color: FOOTER }, line: { color: FOOTER } });
}

// ─── SLIDE 3 — What We Built ──────────────────────────────────────────────
{
  let s = pres.addSlide();
  s.background = { color: BG };

  s.addShape(pres.shapes.RECTANGLE, { x: 0, y: 0, w: 10, h: 0.06,
    fill: { color: CYAN }, line: { color: CYAN } });
  s.addText("02 / 04", { x: 8.5, y: 0.18, w: 1.2, h: 0.25,
    fontSize: 8, color: DIM, fontFace: "Consolas", align: "right", margin: 0 });
  s.addText("SOLUTION", { x: 0.5, y: 0.18, w: 2, h: 0.25,
    fontSize: 8, color: CYAN, fontFace: "Consolas", charSpacing: 3, margin: 0 });
  s.addText("What We Built", { x: 0.5, y: 0.52, w: 9, h: 0.72,
    fontSize: 34, bold: true, color: WHITE, fontFace: "Calibri", margin: 0 });

  const solutions = [
    { num: "01", title: "Live Data Pipeline", color: CYAN,
      items: ["WebSocket feed + RSA-PSS auth", "SQLite with WAL mode", "REST backfill for metadata", "Category mapping via events API"] },
    { num: "02", title: "Terminal Dashboard", color: GOLD,
      items: ["Real-time streaming trade feed", "Whale highlighting by size", "PRE / LIVE timing badge", "Resizable columns + filters"] },
    { num: "03", title: "Auto-Trader", color: GREEN,
      items: ["Mirrors Sports whale trades", "1 share per signal via REST", "Email alert per execution", "Enable/disable via API"] }
  ];

  const sX = [0.4, 3.65, 6.9], sW = 2.9, sH = 3.5, sY = 1.48;

  solutions.forEach((sol, i) => {
    s.addShape(pres.shapes.RECTANGLE, { x: sX[i], y: sY, w: sW, h: sH,
      fill: { color: CARD }, line: { color: "1E2530", width: 1 },
      shadow: { type: "outer", blur: 8, offset: 2, angle: 135, color: "000000", opacity: 0.3 } });
    s.addShape(pres.shapes.RECTANGLE, { x: sX[i], y: sY, w: sW, h: 0.05,
      fill: { color: sol.color }, line: { color: sol.color } });
    s.addText(sol.num, { x: sX[i]+0.18, y: sY+0.18, w: 0.6, h: 0.4,
      fontSize: 22, bold: true, color: sol.color, fontFace: "Consolas", margin: 0 });
    s.addText(sol.title, { x: sX[i]+0.18, y: sY+0.68, w: sW-0.36, h: 0.44,
      fontSize: 14, bold: true, color: WHITE, fontFace: "Calibri", margin: 0 });
    s.addShape(pres.shapes.LINE, { x: sX[i]+0.18, y: sY+1.18, w: sW-0.36, h: 0,
      line: { color: "1E2530", width: 1 } });
    sol.items.forEach((item, j) => {
      s.addShape(pres.shapes.RECTANGLE, { x: sX[i]+0.18, y: sY+1.42+j*0.52, w: 0.06, h: 0.06,
        fill: { color: sol.color }, line: { color: sol.color } });
      s.addText(item, { x: sX[i]+0.32, y: sY+1.33+j*0.52, w: sW-0.5, h: 0.46,
        fontSize: 11, color: MUTED, fontFace: "Calibri", wrap: true, margin: 0 });
    });
  });

  s.addShape(pres.shapes.RECTANGLE, { x: 0, y: 5.45, w: 10, h: 0.175,
    fill: { color: FOOTER }, line: { color: FOOTER } });
}

// ─── SLIDE 4 — Results ────────────────────────────────────────────────────
{
  let s = pres.addSlide();
  s.background = { color: BG };

  s.addShape(pres.shapes.RECTANGLE, { x: 0, y: 0, w: 10, h: 0.06,
    fill: { color: CYAN }, line: { color: CYAN } });
  s.addText("03 / 04", { x: 8.5, y: 0.18, w: 1.2, h: 0.25,
    fontSize: 8, color: DIM, fontFace: "Consolas", align: "right", margin: 0 });
  s.addText("RESULTS", { x: 0.5, y: 0.18, w: 2, h: 0.25,
    fontSize: 8, color: CYAN, fontFace: "Consolas", charSpacing: 3, margin: 0 });
  s.addText("Results & Scale", { x: 0.5, y: 0.52, w: 9, h: 0.72,
    fontSize: 34, bold: true, color: WHITE, fontFace: "Calibri", margin: 0 });

  const stats = [
    { value: "14,725+", label: "Trades Captured", sub: "Across 4 weeks of live data", color: CYAN },
    { value: "$154M",   label: "YES Volume Tracked", sub: "$89M NO volume — heavy YES market bias", color: GOLD },
    { value: "3 Layers",label: "Independent Monitoring", sub: "UptimeRobot · Hourly agent · Daily briefing", color: GREEN },
    { value: "$5.2M+",  label: "Whale Signals in 24 Hours", sub: "MIN $3.5M · RCB $1.5M · Celtics $145K", color: PURPLE }
  ];

  const pos = [{ x: 0.4, y: 1.5 }, { x: 5.2, y: 1.5 }, { x: 0.4, y: 3.2 }, { x: 5.2, y: 3.2 }];
  const stW = 4.4, stH = 1.55;

  stats.forEach((stat, i) => {
    const p = pos[i];
    s.addShape(pres.shapes.RECTANGLE, { x: p.x, y: p.y, w: stW, h: stH,
      fill: { color: CARD }, line: { color: "1E2530", width: 1 },
      shadow: { type: "outer", blur: 8, offset: 2, angle: 135, color: "000000", opacity: 0.3 } });
    s.addShape(pres.shapes.RECTANGLE, { x: p.x, y: p.y, w: 0.07, h: stH,
      fill: { color: stat.color }, line: { color: stat.color } });
    s.addText(stat.value, { x: p.x+0.22, y: p.y+0.1, w: stW-0.32, h: 0.65,
      fontSize: 30, bold: true, color: stat.color, fontFace: "Consolas", margin: 0 });
    s.addText(stat.label, { x: p.x+0.22, y: p.y+0.75, w: stW-0.32, h: 0.3,
      fontSize: 12, bold: true, color: WHITE, fontFace: "Calibri", margin: 0 });
    s.addText(stat.sub, { x: p.x+0.22, y: p.y+1.07, w: stW-0.32, h: 0.35,
      fontSize: 10, color: MUTED, fontFace: "Calibri", margin: 0 });
  });

  s.addShape(pres.shapes.RECTANGLE, { x: 0, y: 5.45, w: 10, h: 0.175,
    fill: { color: FOOTER }, line: { color: FOOTER } });
}

// ─── SLIDE 5 — Tech Stack ─────────────────────────────────────────────────
{
  let s = pres.addSlide();
  s.background = { color: BG };

  s.addShape(pres.shapes.RECTANGLE, { x: 0, y: 0, w: 10, h: 0.06,
    fill: { color: CYAN }, line: { color: CYAN } });
  s.addText("04 / 04", { x: 8.5, y: 0.18, w: 1.2, h: 0.25,
    fontSize: 8, color: DIM, fontFace: "Consolas", align: "right", margin: 0 });
  s.addText("TECH STACK", { x: 0.5, y: 0.18, w: 2.5, h: 0.25,
    fontSize: 8, color: CYAN, fontFace: "Consolas", charSpacing: 3, margin: 0 });
  s.addText("Tech Stack", { x: 0.5, y: 0.52, w: 9, h: 0.72,
    fontSize: 34, bold: true, color: WHITE, fontFace: "Calibri", margin: 0 });

  const cols = [
    { label: "BACKEND",      color: CYAN,
      items: ["Node.js + Fastify", "better-sqlite3 (WAL)", "WebSocket (ws)", "Resend email API"] },
    { label: "FRONTEND",     color: GOLD,
      items: ["React + Vite", "CSS custom properties", "Live WebSocket feed", "localStorage persist"] },
    { label: "INFRA",        color: GREEN,
      items: ["PM2 process mgr", "ngrok public tunnel", "UptimeRobot", "RSA-PSS auth signing"] },
    { label: "INTELLIGENCE", color: PURPLE,
      items: ["Claude hourly monitor", "Claude daily briefing", "Auto-trader engine", "Resend alert emails"] }
  ];

  const cX = [0.4, 2.9, 5.4, 7.9], cW = 2.1, cH = 3.35, cY = 1.48;

  cols.forEach((col, i) => {
    s.addShape(pres.shapes.RECTANGLE, { x: cX[i], y: cY, w: cW, h: cH,
      fill: { color: CARD }, line: { color: "1E2530", width: 1 },
      shadow: { type: "outer", blur: 8, offset: 2, angle: 135, color: "000000", opacity: 0.3 } });
    s.addShape(pres.shapes.RECTANGLE, { x: cX[i], y: cY, w: cW, h: 0.05,
      fill: { color: col.color }, line: { color: col.color } });
    s.addText(col.label, { x: cX[i]+0.14, y: cY+0.14, w: cW-0.28, h: 0.35,
      fontSize: 8.5, bold: true, color: col.color, fontFace: "Consolas",
      charSpacing: 2, margin: 0 });
    s.addShape(pres.shapes.LINE, { x: cX[i]+0.14, y: cY+0.58, w: cW-0.28, h: 0,
      line: { color: "1E2530", width: 1 } });
    col.items.forEach((item, j) => {
      s.addShape(pres.shapes.RECTANGLE, { x: cX[i]+0.14, y: cY+0.76+j*0.6, w: 0.05, h: 0.05,
        fill: { color: col.color }, line: { color: col.color } });
      s.addText(item, { x: cX[i]+0.26, y: cY+0.68+j*0.6, w: cW-0.4, h: 0.52,
        fontSize: 11, color: WHITE, fontFace: "Calibri", wrap: true, margin: 0 });
    });
  });

  // Footer tagline
  s.addShape(pres.shapes.RECTANGLE, { x: 0, y: 5.1, w: 10, h: 0.525,
    fill: { color: "0A1628" }, line: { color: "0A1628" } });
  s.addText("Built end-to-end in a single session with Claude.", {
    x: 0.5, y: 5.14, w: 9, h: 0.36,
    fontSize: 12, color: MUTED, italic: true, fontFace: "Calibri",
    align: "center", margin: 0 });
}

pres.writeFile({ fileName: "/Users/claude_bot/whale-tracker/whale-tracker/KalshiWhaleTracker.pptx" })
  .then(() => console.log("✅ Saved: KalshiWhaleTracker.pptx"))
  .catch(e => console.error("❌", e));
