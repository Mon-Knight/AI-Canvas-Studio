"""Generate Jimeng-style Obsidian + Aurora Cyan-Blue desktop icons (.png & multi-size .ico).

Pure Python stdlib (no Pillow required) using signed-distance rendering + 2x2
supersampling and PNG-compressed ICO directory entries.
"""
from __future__ import annotations

import math
import struct
import zlib
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT_DIR = ROOT / "desktop" / "assets"
PNG_PATH = OUT_DIR / "icon.png"
ICO_PATH = OUT_DIR / "icon.ico"

RENDER_SIZE = 256
ICO_SIZES = (16, 32, 48, 64, 128, 256)


def _clamp(v: float, lo: float = 0.0, hi: float = 1.0) -> float:
    return lo if v < lo else hi if v > hi else v


def _smoothstep(edge0: float, edge1: float, x: float) -> float:
    t = _clamp((x - edge0) / (edge1 - edge0))
    return t * t * (3.0 - 2.0 * t)


def _lerp(a: float, b: float, t: float) -> float:
    return a + (b - a) * t


def _lerp_rgb(c0: tuple[float, float, float], c1: tuple[float, float, float], t: float) -> tuple[float, float, float]:
    t = _clamp(t)
    return (_lerp(c0[0], c1[0], t), _lerp(c0[1], c1[1], t), _lerp(c0[2], c1[2], t))


def _sd_rounded_box(px: float, py: float, bx: float, by: float, r: float) -> float:
    qx = abs(px) - bx + r
    qy = abs(py) - by + r
    out = math.hypot(max(qx, 0.0), max(qy, 0.0))
    inside = min(max(qx, qy), 0.0)
    return out + inside - r


def _sd_segment(px: float, py: float, ax: float, ay: float, bx: float, by: float) -> float:
    pax, pay = px - ax, py - ay
    bax, bay = bx - ax, by - ay
    denom = bax * bax + bay * bay
    h = _clamp((pax * bax + pay * bay) / denom) if denom > 1e-9 else 0.0
    return math.hypot(pax - bax * h, pay - bay * h)


def _sd_triangle(px: float, py: float, ax: float, ay: float, bx: float, by: float, cx: float, cy: float) -> float:
    e0x, e0y = bx - ax, by - ay
    e1x, e1y = cx - bx, cy - by
    e2x, e2y = ax - cx, ay - cy
    v0x, v0y = px - ax, py - ay
    v1x, v1y = px - bx, py - by
    v2x, v2y = px - cx, py - cy

    def _proj(ex: float, ey: float, vx: float, vy: float) -> tuple[float, float]:
        denom = ex * ex + ey * ey
        t = _clamp((vx * ex + vy * ey) / denom) if denom > 1e-9 else 0.0
        return vx - ex * t, vy - ey * t

    p0x, p0y = _proj(e0x, e0y, v0x, v0y)
    p1x, p1y = _proj(e1x, e1y, v1x, v1y)
    p2x, p2y = _proj(e2x, e2y, v2x, v2y)

    s = 1.0 if (e0x * e2y - e0y * e2x) >= 0.0 else -1.0
    d0 = (p0x * p0x + p0y * p0y, s * (v0x * e0y - v0y * e0x))
    d1 = (p1x * p1x + p1y * p1y, s * (v1x * e1y - v1y * e1x))
    d2 = (p2x * p2x + p2y * p2y, s * (v2x * e2y - v2y * e2x))
    min_d2 = min(d0[0], d1[0], d2[0])
    min_side = min(d0[1], d1[1], d2[1])
    return -math.sqrt(min_d2) * (1.0 if min_side >= 0.0 else -1.0)


def _blend(dst: tuple[float, float, float, float], src_rgb: tuple[float, float, float], src_a: float) -> tuple[float, float, float, float]:
    sa = _clamp(src_a)
    if sa <= 0.0:
        return dst
    r0, g0, b0, a0 = dst
    out_a = sa + a0 * (1.0 - sa)
    if out_a <= 1e-6:
        return (0.0, 0.0, 0.0, 0.0)
    r = (src_rgb[0] * sa + r0 * a0 * (1.0 - sa)) / out_a
    g = (src_rgb[1] * sa + g0 * a0 * (1.0 - sa)) / out_a
    b = (src_rgb[2] * sa + b0 * a0 * (1.0 - sa)) / out_a
    return (r, g, b, out_a)


def _sample_icon(u: float, v: float) -> tuple[float, float, float, float]:
    # Normalized coordinates [-1, 1] with origin at center
    px = u * 2.0 - 1.0
    py = v * 2.0 - 1.0
    aa = 0.012

    # 1. Rounded Obsidian squircle background
    box_d = _sd_rounded_box(px, py, 0.90, 0.90, 0.42)
    bg_alpha = 1.0 - _smoothstep(-aa, aa, box_d)
    if bg_alpha <= 0.001:
        return (0.0, 0.0, 0.0, 0.0)

    diag = _clamp((u + v) * 0.5)
    bg_rgb = _lerp_rgb((20.0 / 255.0, 20.0 / 255.0, 24.0 / 255.0), (9.0 / 255.0, 9.0 / 255.0, 11.0 / 255.0), diag)

    # Subtle radial Aurora Cyan-Blue glow
    radial_dist = math.hypot(px, py + 0.06)
    glow = math.exp(-radial_dist * radial_dist * 3.2) * 0.34
    glow_rgb = _lerp_rgb((56.0 / 255.0, 189.0 / 255.0, 248.0 / 255.0), (37.0 / 255.0, 99.0 / 255.0, 235.0 / 255.0), _clamp(radial_dist))
    col = (
        _lerp(bg_rgb[0], glow_rgb[0], glow),
        _lerp(bg_rgb[1], glow_rgb[1], glow),
        _lerp(bg_rgb[2], glow_rgb[2], glow),
        bg_alpha,
    )

    # Crisp glass inner rim
    rim_alpha = (1.0 - _smoothstep(0.0, 0.024, abs(box_d + 0.016))) * 0.22 * bg_alpha
    col = _blend(col, (1.0, 1.0, 1.0), rim_alpha)

    # 2. Diagonal workflow flow lines connecting anchor nodes to central prism
    aurora_t = _clamp(u)
    line_rgb = _lerp_rgb((0.0, 229.0 / 255.0, 1.0), (37.0 / 255.0, 99.0 / 255.0, 235.0 / 255.0), aurora_t)
    d_line1 = min(_sd_segment(px, py, -0.56, 0.39, 0.0, 0.0), _sd_segment(px, py, 0.0, 0.0, 0.56, -0.39))
    d_line2 = min(_sd_segment(px, py, -0.56, -0.39, 0.0, 0.0), _sd_segment(px, py, 0.0, 0.0, 0.56, 0.39))
    col = _blend(col, line_rgb, (1.0 - _smoothstep(0.018, 0.032, d_line1)) * 0.62 * bg_alpha)
    col = _blend(col, line_rgb, (1.0 - _smoothstep(0.012, 0.026, d_line2)) * 0.42 * bg_alpha)

    # 3. Outer aurora glass prism triangle + luminous inner prism
    cyan = (0.0, 229.0 / 255.0, 1.0)
    sky = (56.0 / 255.0, 189.0 / 255.0, 248.0 / 255.0)
    blue = (37.0 / 255.0, 99.0 / 255.0, 235.0 / 255.0)
    ice = (224.0 / 255.0, 247.0 / 255.0, 1.0)

    prism_t = _clamp((px + 0.45) * 0.6 + (py + 0.55) * 0.4)
    prism_rgb = _lerp_rgb(cyan, blue, prism_t)

    d_outer = _sd_triangle(px, py, 0.0, -0.52, -0.46, 0.34, 0.46, 0.34)
    outer_fill = (1.0 - _smoothstep(-aa, aa, d_outer)) * 0.24 * bg_alpha
    outer_stroke = (1.0 - _smoothstep(0.018, 0.034, abs(d_outer))) * 0.95 * bg_alpha
    col = _blend(col, prism_rgb, outer_fill)
    col = _blend(col, prism_rgb, outer_stroke)

    d_inner = _sd_triangle(px, py, 0.0, -0.31, -0.27, 0.21, 0.27, 0.21)
    inner_rgb = _lerp_rgb(ice, sky, _clamp((py + 0.32) / 0.55))
    inner_fill = (1.0 - _smoothstep(-aa, aa, d_inner)) * 0.98 * bg_alpha
    col = _blend(col, inner_rgb, inner_fill)

    # 4. Corner workflow nodes
    nodes = (
        (-0.56, -0.39, 0.095, cyan, False),
        (-0.56, 0.39, 0.095, sky, False),
        (0.56, -0.39, 0.105, sky, True),
        (0.56, 0.39, 0.090, blue, False),
    )
    dark = (9.0 / 255.0, 9.0 / 255.0, 11.0 / 255.0)
    for nx, ny, nr, nrgb, filled in nodes:
        dn = math.hypot(px - nx, py - ny) - nr
        ring = 1.0 - _smoothstep(-aa, aa, dn)
        if filled:
            col = _blend(col, nrgb, ring * bg_alpha)
            inner_dot = 1.0 - _smoothstep(-aa, aa, dn + 0.042)
            col = _blend(col, ice, inner_dot * 0.85 * bg_alpha)
        else:
            col = _blend(col, nrgb, ring * bg_alpha)
            hole = 1.0 - _smoothstep(-aa, aa, dn + 0.040)
            col = _blend(col, dark, hole * bg_alpha)

    return col


def render_rgba(size: int) -> bytes:
    """Render square RGBA bitmap with 2x2 supersampling."""
    buf = bytearray(size * size * 4)
    offsets = (0.25, 0.75)
    for y in range(size):
        row_off = y * size * 4
        for x in range(size):
            ar = ag = ab = aa = 0.0
            for oy in offsets:
                v = (y + oy) / size
                for ox in offsets:
                    u = (x + ox) / size
                    r, g, b, a = _sample_icon(u, v)
                    ar += r * a
                    ag += g * a
                    ab += b * a
                    aa += a
            aa /= 4.0
            if aa > 1e-6:
                r_out = int(_clamp(ar / 4.0 / aa) * 255.0 + 0.5)
                g_out = int(_clamp(ag / 4.0 / aa) * 255.0 + 0.5)
                b_out = int(_clamp(ab / 4.0 / aa) * 255.0 + 0.5)
                a_out = int(_clamp(aa) * 255.0 + 0.5)
            else:
                r_out = g_out = b_out = a_out = 0
            idx = row_off + x * 4
            buf[idx : idx + 4] = bytes((r_out, g_out, b_out, a_out))
    return bytes(buf)


def encode_png(size: int, rgba: bytes) -> bytes:
    def _chunk(tag: bytes, data: bytes) -> bytes:
        crc = zlib.crc32(tag + data) & 0xFFFFFFFF
        return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", crc)

    raw_rows = bytearray()
    stride = size * 4
    for y in range(size):
        raw_rows.append(0)
        start = y * stride
        raw_rows.extend(rgba[start : start + stride])

    ihdr = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)
    idat = zlib.compress(bytes(raw_rows), level=9)
    return (
        b"\x89PNG\r\n\x1a\n"
        + _chunk(b"IHDR", ihdr)
        + _chunk(b"IDAT", idat)
        + _chunk(b"IEND", b"")
    )


def build_ico(png_frames: list[tuple[int, bytes]]) -> bytes:
    count = len(png_frames)
    header = struct.pack("<HHH", 0, 1, count)
    offset = 6 + count * 16
    entries: list[bytes] = []
    payloads: list[bytes] = []
    for size, data in png_frames:
        dim = 0 if size >= 256 else size
        entries.append(struct.pack("<BBBBHHII", dim, dim, 0, 0, 1, 32, len(data), offset))
        payloads.append(data)
        offset += len(data)
    return header + b"".join(entries) + b"".join(payloads)


def main() -> int:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    frames: list[tuple[int, bytes]] = []
    png_256 = b""
    for size in ICO_SIZES:
        png = encode_png(size, render_rgba(size))
        frames.append((size, png))
        if size == RENDER_SIZE:
            png_256 = png
    PNG_PATH.write_bytes(png_256)
    ICO_PATH.write_bytes(build_ico(frames))
    print(f"Generated {PNG_PATH} ({len(png_256)} B) and {ICO_PATH} ({ICO_PATH.stat().st_size} B)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
