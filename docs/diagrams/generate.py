"""Generate the two coduo-afk README diagrams in the diagram-design default skin."""
import sys
from pathlib import Path

OUT = Path(sys.argv[1])
PAPER, INK, MUTED, SOFT, ACCENT = "#f5f5f5", "#2d3142", "#4f5d75", "#5a6580", "#bf4520"
SANS = "'Geist', system-ui, sans-serif"
MONO = "'Geist Mono', ui-monospace, monospace"
TREAT = {
    "focal": ("rgba(191,69,32,0.08)", ACCENT, ""),
    "backend": ("#ffffff", INK, ""),
    "store": ("rgba(45,49,66,0.05)", MUTED, ""),
    "input": ("rgba(79,93,117,0.10)", SOFT, ""),
}


def node(x, y, w, h, name, sub, kind):
    fill, stroke, dash = TREAT[kind]
    cx, cy = x + w / 2, y + h / 2
    return (f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="6" fill="{PAPER}"/>'
            f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="6" fill="{fill}" stroke="{stroke}" stroke-width="1"{dash}/>'
            f'<text x="{cx:g}" y="{cy - 2:g}" fill="{INK}" font-size="12" font-weight="600" font-family="{SANS}" text-anchor="middle">{name}</text>'
            f'<text x="{cx:g}" y="{cy + 14:g}" fill="{MUTED}" font-size="9" font-family="{MONO}" text-anchor="middle">{sub}</text>')


def path(points, accent=False):
    """Orthogonal path through points, each bend a quarter arc of r=8."""
    r = 8
    d = f"M{points[0][0]},{points[0][1]}"
    for i in range(1, len(points) - 1):
        (x0, y0), (x1, y1), (x2, y2) = points[i - 1], points[i], points[i + 1]
        dx0, dy0 = (x1 > x0) - (x1 < x0), (y1 > y0) - (y1 < y0)
        dx1, dy1 = (x2 > x1) - (x2 < x1), (y2 > y1) - (y2 < y1)
        sweep = 1 if dx0 * dy1 - dy0 * dx1 > 0 else 0
        d += f" L{x1 - dx0 * r},{y1 - dy0 * r} A{r},{r} 0 0 {sweep} {x1 + dx1 * r},{y1 + dy1 * r}"
    d += f" L{points[-1][0]},{points[-1][1]}"
    color, marker = (ACCENT, "arrow-accent") if accent else (MUTED, "arrow")
    return f'<path d="{d}" fill="none" stroke="{color}" stroke-width="1.2" marker-end="url(#{marker})"/>'


def label(mid_x, arrow_y, text):
    w = round(len(text) * 8 * 0.62 + 12)
    w += w % 2
    return (f'<rect x="{mid_x - w / 2:g}" y="{arrow_y - 20}" width="{w}" height="12" rx="2" fill="{PAPER}"/>'
            f'<text x="{mid_x:g}" y="{arrow_y - 11}" fill="{SOFT}" font-size="8" font-family="{MONO}" text-anchor="middle" letter-spacing="0.06em">{text}</text>')


def legend(y, width, kinds, backend="Agent step"):
    names = {"focal": "Focal output", "backend": backend, "store": "Git state", "input": "Input"}
    out = [f'<line x1="24" y1="{y - 8}" x2="{width - 24}" y2="{y - 8}" stroke="rgba(45,49,66,0.10)" stroke-width="0.8"/>',
           f'<text x="24" y="{y + 12}" fill="{MUTED}" font-size="8" font-family="{MONO}" letter-spacing="0.14em">LEGEND</text>']
    x = 104
    for k in kinds:
        fill, stroke, _ = TREAT[k]
        out.append(f'<rect x="{x}" y="{y + 4}" width="16" height="10" rx="2" fill="{fill}" stroke="{stroke}" stroke-width="1"/>'
                   f'<text x="{x + 24}" y="{y + 12}" fill="{MUTED}" font-size="9" font-family="{MONO}">{names[k]}</text>')
        x += 152
    return "".join(out)


def page(slug, eyebrow, title, desc, width, height, body):
    markers = "".join(
        f'<marker id="{i}" markerWidth="8" markerHeight="6" refX="7" refY="3" orient="auto"><polygon points="0 0, 8 3, 0 6" fill="{c}"/></marker>'
        for i, c in (("arrow", MUTED), ("arrow-accent", ACCENT), ("arrow-link", "#2e5aa8")))
    return f"""<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>{title}</title>
  <link href="https://fonts.googleapis.com/css2?family=Instrument+Serif:ital@0;1&family=Geist:wght@400;500;600&family=Geist+Mono:wght@400;500;600&display=swap" rel="stylesheet">
  <style>
    *, *::before, *::after {{ box-sizing: border-box; margin: 0; padding: 0; }}
    body {{ font-family: {SANS}; background: {PAPER}; color: {INK}; padding: 3rem 2rem; }}
    .frame {{ max-width: {width + 40}px; margin: 0 auto; }}
    .diagram-container {{ width: 100%; overflow-x: auto; }}
    .eyebrow {{ font-family: {MONO}; font-size: 0.66rem; font-weight: 500; letter-spacing: 0.18em; text-transform: uppercase; color: {MUTED}; margin-bottom: 0.5rem; }}
    h1 {{ font-family: 'Instrument Serif', serif; font-size: 2rem; font-weight: 400; letter-spacing: -0.02em; margin-bottom: 1.5rem; }}
    svg {{ width: 100%; min-width: {width}px; display: block; }}
    @media print {{ .diagram-container {{ overflow-x: visible; }} svg {{ min-width: 0; }} }}
  </style>
</head>
<body>
  <div class="frame">
    <p class="eyebrow">{eyebrow}</p>
    <h1>{title}</h1>
    <div class="diagram-container">
      <svg viewBox="0 0 {width} {height}" xmlns="http://www.w3.org/2000/svg" role="img" aria-labelledby="{slug}-title {slug}-desc">
        <title id="{slug}-title">{title}</title>
        <desc id="{slug}-desc">{desc}</desc>
        <defs>{markers}</defs>
        <rect width="100%" height="100%" fill="{PAPER}"/>
        {body}
      </svg>
    </div>
  </div>
</body>
</html>
"""


# 1. From idea to merged code: five artifacts, the skill that makes each one on the arrow.
W1, Y, H, NW, GAP = 1124, 40, 64, 132, 104
xs = [24 + i * (NW + GAP) for i in range(5)]
cy = Y + H // 2
arrows = [path([(xs[i] + NW, cy), (xs[i + 1], cy)], accent=(i == 2)) for i in range(4)]
labels = [label(xs[i] + NW + GAP / 2, cy, t) for i, t in enumerate(["CODUO-EPIC", "CODUO-TICKETS", "AFK EPIC", "CODUO-LAND-PR"])]
nodes = [node(xs[0], Y, NW, H, "An idea", "a conversation", "input"),
         node(xs[1], Y, NW, H, "Epic issue", "spec + afk: block", "backend"),
         node(xs[2], Y, NW, H, "Child issues", "tasks: DAG", "backend"),
         node(xs[3], Y, NW, H, "Pull request", "1 commit per task", "focal"),
         node(xs[4], Y, NW, H, "main", "issues closed", "store")]
H1 = 168
(OUT / "pipeline.html").write_text(page(
    "pipeline", "Process · coduo-afk", "From an idea to merged code",
    "Pipeline from an idea to an epic issue, its child issues, a pull request built unattended by afk epic, and the merge to main, with the skill that produces each step.",
    W1, H1, "".join(arrows + labels + nodes) + legend(H1 - 40, W1, ["input", "backend", "focal", "store"], backend="GitHub issue")))

# 2. Inside one afk epic run.
W2, RY, RH = 1312, 160, 64
col = {"dag": (24, 120), "sch": (200, 120), "lane": (384, 152), "merge": (600, 136), "epic": (800, 120), "close": (984, 128), "pr": (1176, 112)}
lane_y = [64, 160, 256]
mid = RY + RH // 2
fan = [RY + RH * k // 4 for k in (1, 2, 3)]
right = lambda k: col[k][0] + col[k][1]
a = [path([(right("dag"), mid), (col["sch"][0], mid)])]
for i, ly in enumerate(lane_y):
    lc = ly + RH // 2
    bend_out = right("sch") + 24 if i != 1 else None
    a.append(path([(right("sch"), fan[i]), (bend_out, fan[i]), (bend_out, lc), (col["lane"][0], lc)]) if bend_out
             else path([(right("sch"), fan[i]), (col["lane"][0], fan[i])]))
    bend_in = right("lane") + 32 if i != 1 else None
    a.append(path([(right("lane"), lc), (bend_in, lc), (bend_in, fan[i]), (col["merge"][0], fan[i])]) if bend_in
             else path([(right("lane"), lc), (col["merge"][0], lc)]))
a += [path([(right("merge"), mid), (col["epic"][0], mid)]),
      path([(right("epic"), mid), (col["close"][0], mid)]),
      path([(right("close"), mid), (col["pr"][0], mid)], accent=True)]
lab = [label((right("merge") + col["epic"][0]) / 2, mid, "SERIAL")]
n = [node(*col["dag"][:1], RY, col["dag"][1], RH, "Epic + tickets", "afk: block", "input"),
     node(col["sch"][0], RY, col["sch"][1], RH, "Scheduler", "DAG order", "backend")]
n += [node(col["lane"][0], ly, col["lane"][1], RH, f"Lane · task {i + 1}", "worktree · builder · gate", "backend") for i, ly in enumerate(lane_y)]
n += [node(col["merge"][0], RY, col["merge"][1], RH, "Merge queue", "fresh merger · re-gate", "backend"),
      node(col["epic"][0], RY, col["epic"][1], RH, "Epic branch", "1 commit per task", "store"),
      node(col["close"][0], RY, col["close"][1], RH, "Closeout review", "code-review · fixer", "backend"),
      node(col["pr"][0], RY, col["pr"][1], RH, "Pull request", "you merge", "focal")]
H2 = 392
(OUT / "run.html").write_text(page(
    "run", "Architecture · coduo-afk", "Inside one afk epic run",
    "One afk epic run: the scheduler starts each ready task in its own worktree lane, a merge queue lands finished lanes one at a time on the epic branch, and a closeout review gates the pull request.",
    W2, H2, "".join(a + lab + n) + legend(H2 - 40, W2, ["input", "backend", "store", "focal"])))
print("wrote", OUT / "pipeline.html", OUT / "run.html")
