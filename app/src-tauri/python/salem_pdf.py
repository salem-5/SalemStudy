from __future__ import annotations

import base64
import html as htmllib
import io
import json
import os
import re
import sys

import pymupdf

PAGE = pymupdf.paper_rect("a4")
MARGIN = 56
FOOTER = 26

CSS = """
* { font-family: sans-serif; }
body { font-size: 10.5pt; line-height: 1.5; color: #111; }
h1 { font-size: 19pt; margin: 0 0 4pt; }
h2 { font-size: 14pt; margin: 14pt 0 4pt; }
h3 { font-size: 11.5pt; margin: 11pt 0 3pt; }
h4, h5, h6 { font-size: 10.5pt; margin: 9pt 0 3pt; }
p { margin: 0 0 7pt; }
ul, ol { margin: 0 0 7pt 16pt; }
li { margin: 0 0 3pt; }
blockquote { margin: 0 0 7pt 10pt; color: #444; }
code { font-family: monospace; font-size: 9.5pt; background: #f2f2f0; }
pre { font-family: monospace; font-size: 9pt; background: #f6f6f4; margin: 0 0 8pt; padding: 6pt; }
table { margin: 0 0 8pt; width: 100%; }
th { font-weight: bold; text-align: left; background: #f2f2f0; padding: 3pt 5pt; }
td { padding: 3pt 5pt; }
hr { margin: 10pt 0; }
img { margin: 2pt 0; }
.subtitle { color: #555; font-size: 9.5pt; margin: 0 0 14pt; }
.figure { margin: 6pt 0; }
.caption { color: #555; font-size: 9pt; margin: 0 0 8pt; }
.muted { color: #777; }

.question { margin: 0 0 16pt; }
.marks { color: #666; font-size: 9pt; }
.namefields { margin: 0 0 14pt; }
.namefields td { padding: 2pt 4pt; font-size: 9.5pt; color: #555; }
.namefields td.rule { border-bottom: 0.5pt solid #999; width: 22%; }
.answers-head { font-size: 9pt; color: #666; margin: 8pt 0 3pt; }
.answer-note { font-size: 9.5pt; color: #444; margin: 0 0 3pt; }
.answer-box { width: 100%; margin: 0 0 5pt; }
.answer-box td { padding: 2pt 4pt; }
.answer-label { width: 22pt; font-weight: bold; font-size: 9.5pt; }
.answer-space { border: 0.5pt solid #bbb; }
.answer-marks { width: 34pt; text-align: right; }
.opts { margin: 0 0 6pt; }
.opts td.opt { font-size: 9.5pt; padding: 2pt 6pt 2pt 0; }
.scheme { margin: 4pt 0 0; }
.scheme td { padding: 3pt 5pt; font-size: 9.5pt; border-bottom: 0.4pt solid #e5e5e5; }
.scheme td.scheme-q { width: 26pt; color: #666; }
"""


def _mathtext_png(latex: str, display: bool, dpi: int = 240) -> tuple[bytes, float, float] | None:
    import matplotlib
    matplotlib.use("Agg")
    from matplotlib import figure, mathtext
    from matplotlib.font_manager import FontProperties

    body = latex.strip()
    if not body:
        return None
    size = 13 if display else 10.5
    props = FontProperties(size=size)
    parser = mathtext.MathTextParser("path")
    try:
        width, height, _depth, _glyphs, _rects = parser.parse(f"${body}$", dpi=72, prop=props)
    except Exception:
        return None

    fig = figure.Figure(figsize=(max(width, 1) / 72, max(height, 1) / 72), dpi=dpi)
    fig.patch.set_alpha(0)
    try:
        fig.text(0, 0, f"${body}$", fontproperties=props, color="#111111")
        buffer = io.BytesIO()
        fig.savefig(buffer, format="png", dpi=dpi, transparent=True, bbox_inches="tight", pad_inches=0.01)
    except Exception:
        return None
    finally:
        fig.clf()
    return buffer.getvalue(), width, height


_MATH = re.compile(r"\\\((.+?)\\\)|\\\[(.+?)\\\]", re.S)


def render_maths(html: str, workdir: str) -> str:
    made = {"n": 0}

    def one(match: re.Match[str]) -> str:
        inline, display = match.group(1), match.group(2)
        latex = inline if inline is not None else display
        rendered = _mathtext_png(htmllib.unescape(latex), display=inline is None)
        if rendered is None:
            return f"<code>{htmllib.escape(latex.strip())}</code>"
        data, width, height = rendered
        made["n"] += 1
        name = f"math-{made['n']:04d}.png"
        with open(os.path.join(workdir, name), "wb") as f:
            f.write(data)
        style = "vertical-align: middle;" if inline is not None else "display: block; margin: 6pt auto;"
        return f'<img src="{name}" width="{width:.1f}" height="{height:.1f}" style="{style}" />'

    return _MATH.sub(one, html)



def build(job: dict, workdir: str) -> str:
    title = str(job.get("title") or "Document")
    subtitle = str(job.get("subtitle") or "")
    body = render_maths(str(job.get("html") or ""), workdir)

    head = f"<h1>{htmllib.escape(title)}</h1>"
    if subtitle:
        head += f'<p class="subtitle">{htmllib.escape(subtitle)}</p>'
    document = f"<html><head><style>{CSS}</style></head><body>{head}{body}</body></html>"

    out = job["out"]
    story = pymupdf.Story(html=document, archive=workdir)
    writer = pymupdf.DocumentWriter(out)
    frame = pymupdf.Rect(MARGIN, MARGIN, PAGE.width - MARGIN, PAGE.height - MARGIN - FOOTER)

    page = 0
    more = True
    while more:
        page += 1
        device = writer.begin_page(PAGE)
        more, _ = story.place(frame)
        story.draw(device)
        writer.end_page()

    writer.close()
    _number_pages(out, title)
    return out


def _number_pages(path: str, title: str) -> None:
    doc = pymupdf.open(path)
    total = doc.page_count
    for i, page in enumerate(doc, start=1):
        y = PAGE.height - MARGIN + 6
        page.insert_text((MARGIN, y), title[:70], fontsize=8, color=(0.42, 0.42, 0.42))
        label = f"{i} / {total}"
        width = pymupdf.get_text_length(label, fontsize=8)
        page.insert_text((PAGE.width - MARGIN - width, y), label, fontsize=8, color=(0.42, 0.42, 0.42))
    doc.saveIncr()
    doc.close()


def main() -> int:
    if len(sys.argv) < 2:
        print("usage: salem_pdf.py job.json", file=sys.stderr)
        return 2
    with open(sys.argv[1], encoding="utf-8") as f:
        job = json.load(f)
    workdir = os.path.dirname(os.path.abspath(sys.argv[1]))

    for image in job.get("images") or []:
        raw = str(image.get("data") or "")
        blob = raw.split(",", 1)[1] if raw.startswith("data:") else raw
        try:
            with open(os.path.join(workdir, str(image["file"])), "wb") as f:
                f.write(base64.b64decode(blob))
        except Exception as exc:
            print(f"skipped image {image.get('file')}: {exc}", file=sys.stderr)

    out = build(job, workdir)
    print(json.dumps({"ok": True, "pdf": out}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
