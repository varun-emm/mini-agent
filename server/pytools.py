"""Trusted helpers for the Mini Agent server: shrink images and turn documents into HTML for screenshots.

python3 pytools.py thumb <path> <max_side> <jpeg|png>      -> {"b64", "format", "w", "h"}
python3 pytools.py shot <path> <max_w> <max_h>             -> {"b64", "w", "h", "cropped"} (JPEG on white)
python3 pytools.py docx2html <path>                        -> HTML
python3 pytools.py xlsx2html <path> <sheet_number>         -> {"html", "index", "count", "name"}
python3 pytools.py csv2html <path> <separator>             -> HTML
"""
import base64
import csv
import html
import io
import json
import sys


def _encode(img, fmt, quality=86):
    buf = io.BytesIO()
    if fmt == "png":
        img.save(buf, "PNG", optimize=True)
    else:
        img.convert("RGB").save(buf, "JPEG", quality=quality, optimize=True)
    return base64.b64encode(buf.getvalue()).decode()


def _open(path):
    from PIL import Image, ImageOps
    img = Image.open(path)
    img = ImageOps.exif_transpose(img)
    img.seek(0) if getattr(img, "is_animated", False) else None
    return img


def thumb(path, max_side, fmt):
    from PIL import Image
    img = _open(path)
    img.thumbnail((int(max_side), int(max_side)))
    if fmt != "png" and img.mode in ("RGBA", "LA", "P"):
        bg = Image.new("RGB", img.size, "white")
        bg.paste(img.convert("RGBA"), mask=img.convert("RGBA").split()[-1])
        img = bg
    print(json.dumps({"b64": _encode(img, fmt), "format": "png" if fmt == "png" else "jpeg", "w": img.width, "h": img.height}))


def shot(path, max_w, max_h):
    from PIL import Image
    img = _open(path).convert("RGBA")
    max_w, max_h = int(max_w), int(max_h)
    scale = min(1.0, max_w / img.width)
    img = img.resize((max(1, round(img.width * scale)), max(1, round(img.height * scale))))
    cropped = img.height > max_h
    if cropped:
        img = img.crop((0, 0, img.width, max_h))
    bg = Image.new("RGB", img.size, "white")
    bg.paste(img, mask=img.split()[-1])
    print(json.dumps({"b64": _encode(bg, "jpeg"), "w": bg.width, "h": bg.height, "cropped": cropped}))


def docx2html(path):
    import docx
    d = docx.Document(path)
    out = []
    body = d.element.body
    for child in body.iterchildren():
        tag = child.tag.split("}")[-1]
        if tag == "p":
            p = docx.text.paragraph.Paragraph(child, d)
            style = (p.style.name or "").lower() if p.style is not None else ""
            runs = "".join(
                ("<b>" if r.bold else "") + ("<i>" if r.italic else "") + html.escape(r.text)
                + ("</i>" if r.italic else "") + ("</b>" if r.bold else "") for r in p.runs)
            if not runs.strip():
                out.append("<p>&nbsp;</p>")
            elif style.startswith("heading"):
                level = "".join(ch for ch in style if ch.isdigit()) or "2"
                out.append(f"<h{min(int(level), 6)}>{runs}</h{min(int(level), 6)}>")
            elif style.startswith("title"):
                out.append(f"<h1>{runs}</h1>")
            elif "list" in style:
                out.append(f"<ul><li>{runs}</li></ul>")
            else:
                align = {1: "center", 2: "right", 3: "justify"}.get(int(p.alignment) if p.alignment is not None else 0, "left")
                out.append(f'<p style="text-align:{align}">{runs}</p>')
        elif tag == "tbl":
            t = docx.table.Table(child, d)
            rows = []
            for i, row in enumerate(t.rows):
                cells = "".join(f"<{'th' if i == 0 else 'td'}>{html.escape(c.text)}</{'th' if i == 0 else 'td'}>" for c in row.cells)
                rows.append(f"<tr>{cells}</tr>")
            out.append(f"<table>{''.join(rows)}</table><br>")
    print("\n".join(out))


def _cell_text(v, number_format):
    if v is None:
        return ""
    if isinstance(v, float):
        if "%" in (number_format or ""):
            return f"{v * 100:.2f}%".replace(".00%", "%")
        return f"{v:,.2f}".rstrip("0").rstrip(".") if abs(v) < 1e15 else str(v)
    if isinstance(v, int):
        return f"{v:,}"
    return str(v)


def xlsx2html(path, sheet_no):
    import openpyxl
    wb_v = openpyxl.load_workbook(path, data_only=True)
    wb_f = openpyxl.load_workbook(path, data_only=False)
    names = wb_v.sheetnames
    idx = max(1, min(int(sheet_no), len(names)))
    ws, wf = wb_v[names[idx - 1]], wb_f[names[idx - 1]]
    rows = []
    max_r, max_c = min(ws.max_row, 300), min(ws.max_column, 30)
    for r in range(1, max_r + 1):
        cells = []
        for c in range(1, max_c + 1):
            cell, fcell = ws.cell(r, c), wf.cell(r, c)
            v = cell.value
            # formulas never calculated by Excel have no stored value: show the formula instead of a blank
            if v is None and isinstance(fcell.value, str) and fcell.value.startswith("="):
                text = fcell.value
            else:
                text = _cell_text(v, cell.number_format)
            bold = cell.font is not None and cell.font.b
            tag = "th" if bold else "td"
            cells.append(f"<{tag}>{html.escape(text)}</{tag}>")
        rows.append(f"<tr>{''.join(cells)}</tr>")
    note = "" if ws.max_row <= 300 else f"<p>… {ws.max_row - 300} more rows</p>"
    body = f'<p class="sheet-name">{html.escape(names[idx - 1])}</p><table>{"".join(rows)}</table>{note}'
    print(json.dumps({"html": body, "index": idx, "count": len(names), "name": names[idx - 1]}))


def csv2html(path, sep):
    with open(path, newline="", encoding="utf-8", errors="replace") as f:
        rows = list(csv.reader(f, delimiter=sep))[:300]
    out = []
    for i, row in enumerate(rows):
        tag = "th" if i == 0 else "td"
        out.append("<tr>" + "".join(f"<{tag}>{html.escape(c)}</{tag}>" for c in row[:30]) + "</tr>")
    print(f"<table>{''.join(out)}</table>")


if __name__ == "__main__":
    cmd, args = sys.argv[1], sys.argv[2:]
    {"thumb": thumb, "shot": shot, "docx2html": docx2html, "xlsx2html": xlsx2html, "csv2html": csv2html}[cmd](*args)
