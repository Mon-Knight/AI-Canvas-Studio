"""Out-of-process Windows native image file picker for Flowboard Desktop.

Runs in a standalone Python subprocess using Win32 GetOpenFileNameW so the
Electron main UI thread never enters a nested Win32 modal loop or sets
WS_DISABLED on the main canvas window.
"""
from __future__ import annotations

import argparse
import ctypes
from ctypes import wintypes
import json
import os
import sys

OFN_ALLOWMULTISELECT = 0x00000200
OFN_EXPLORER = 0x00080000
OFN_FILEMUSTEXIST = 0x00001000
OFN_PATHMUSTEXIST = 0x00000800
OFN_NOCHANGEDIR = 0x00000008
OFN_HIDEREADONLY = 0x00000004
OFN_DONTADDTORECENT = 0x02000000

WS_POPUP = 0x80000000
WS_EX_TOPMOST = 0x00000008
WS_EX_TOOLWINDOW = 0x00000080


class OPENFILENAMEW(ctypes.Structure):
    """Exact Win32 OPENFILENAMEW layout (152 bytes on x64, 88 bytes on x86)."""

    _fields_ = [
        ("lStructSize", wintypes.DWORD),
        ("hwndOwner", wintypes.HWND),
        ("hInstance", wintypes.HINSTANCE),
        ("lpstrFilter", ctypes.c_void_p),
        ("lpstrCustomFilter", ctypes.c_void_p),
        ("nMaxCustFilter", wintypes.DWORD),
        ("nFilterIndex", wintypes.DWORD),
        ("lpstrFile", ctypes.c_void_p),
        ("nMaxFile", wintypes.DWORD),
        ("lpstrFileTitle", ctypes.c_void_p),
        ("nMaxFileTitle", wintypes.DWORD),
        ("lpstrInitialDir", wintypes.LPCWSTR),
        ("lpstrTitle", wintypes.LPCWSTR),
        ("Flags", wintypes.DWORD),
        ("nFileOffset", wintypes.WORD),
        ("nFileExtension", wintypes.WORD),
        ("lpstrDefExt", wintypes.LPCWSTR),
        ("lCustData", wintypes.LPARAM),
        ("lpfnHook", ctypes.c_void_p),
        ("lpTemplateName", wintypes.LPCWSTR),
        ("pvReserved", ctypes.c_void_p),
        ("dwReserved", wintypes.DWORD),
        ("FlagsEx", wintypes.DWORD),
    ]


def _default_initial_dir() -> str | None:
    home = os.path.expanduser("~")
    for sub in ("Pictures", "Desktop", "Downloads"):
        candidate = os.path.join(home, sub)
        if os.path.isdir(candidate):
            return candidate
    return home if os.path.isdir(home) else None


def _build_filter_buffer() -> ctypes.Array[ctypes.c_wchar]:
    spec = (
        "图片文件 (*.png;*.jpg;*.jpeg;*.webp;*.gif)\0"
        "*.png;*.jpg;*.jpeg;*.webp;*.gif\0"
        "所有文件 (*.*)\0*.*\0\0"
    )
    return ctypes.create_unicode_buffer(spec)


def _decode_selected_paths(file_buf: ctypes.Array[ctypes.c_wchar], allow_multiple: bool) -> list[str]:
    raw = ctypes.wstring_at(ctypes.addressof(file_buf), len(file_buf))
    double_null = raw.find("\0\0")
    segment = raw[:double_null] if double_null != -1 else raw.rstrip("\0")
    if not segment:
        return []
    parts = [part for part in segment.split("\0") if part]
    if not parts:
        return []
    if not allow_multiple or len(parts) == 1:
        return [parts[0]]
    directory = parts[0]
    return [os.path.join(directory, name) for name in parts[1:]]


def pick_images_windows(multiple: bool = False, title: str = "选择要上传的图片") -> dict:
    user32 = ctypes.windll.user32
    comdlg32 = ctypes.windll.comdlg32

    try:
        user32.SetProcessDPIAware()
    except Exception:
        pass

    user32.CreateWindowExW.restype = wintypes.HWND
    hwnd = user32.CreateWindowExW(
        WS_EX_TOPMOST | WS_EX_TOOLWINDOW,
        "STATIC",
        "",
        WS_POPUP,
        -32000,
        -32000,
        1,
        1,
        None,
        None,
        None,
        None,
    )
    if hwnd:
        try:
            user32.SetForegroundWindow(hwnd)
        except Exception:
            pass

    buf_size = 65536 if multiple else 4096
    file_buf = ctypes.create_unicode_buffer(buf_size)
    filter_buf = _build_filter_buffer()
    init_dir = _default_initial_dir()

    flags = (
        OFN_EXPLORER
        | OFN_FILEMUSTEXIST
        | OFN_PATHMUSTEXIST
        | OFN_NOCHANGEDIR
        | OFN_HIDEREADONLY
        | OFN_DONTADDTORECENT
    )
    if multiple:
        flags |= OFN_ALLOWMULTISELECT

    ofn = OPENFILENAMEW()
    ofn.lStructSize = ctypes.sizeof(OPENFILENAMEW)
    ofn.hwndOwner = hwnd
    ofn.lpstrFilter = ctypes.addressof(filter_buf)
    ofn.nFilterIndex = 1
    ofn.lpstrFile = ctypes.addressof(file_buf)
    ofn.nMaxFile = buf_size
    ofn.lpstrInitialDir = init_dir
    ofn.lpstrTitle = title
    ofn.Flags = flags

    comdlg32.GetOpenFileNameW.argtypes = [ctypes.POINTER(OPENFILENAMEW)]
    comdlg32.GetOpenFileNameW.restype = wintypes.BOOL
    comdlg32.CommDlgExtendedError.restype = wintypes.DWORD

    try:
        ok = bool(comdlg32.GetOpenFileNameW(ctypes.byref(ofn)))
        if ok:
            paths = _decode_selected_paths(file_buf, multiple)
            return {"canceled": len(paths) == 0, "paths": paths}
        err_code = int(comdlg32.CommDlgExtendedError())
        if err_code == 0:
            return {"canceled": True, "paths": []}
        return {
            "canceled": True,
            "paths": [],
            "error": f"Windows 文件对话框返回错误码 0x{err_code:04X}",
        }
    finally:
        if hwnd:
            try:
                user32.DestroyWindow(hwnd)
            except Exception:
                pass


def run_self_test() -> dict:
    expected = 152 if ctypes.sizeof(ctypes.c_void_p) == 8 else 88
    actual = ctypes.sizeof(OPENFILENAMEW)
    if actual != expected:
        raise AssertionError(f"OPENFILENAMEW size mismatch: expected {expected}, got {actual}")

    fbuf = _build_filter_buffer()
    single_buf = ctypes.create_unicode_buffer(128)
    single_raw = "C:\\Temp\\hero.png\0"
    single_buf[: len(single_raw)] = single_raw
    assert _decode_selected_paths(single_buf, True) == ["C:\\Temp\\hero.png"]

    multi_buf = ctypes.create_unicode_buffer(128)
    multi_raw = "C:\\Temp\0a.png\0b.jpg\0"
    multi_buf[: len(multi_raw)] = multi_raw
    assert _decode_selected_paths(multi_buf, True) == [
        os.path.join("C:\\Temp", "a.png"),
        os.path.join("C:\\Temp", "b.jpg"),
    ]
    return {
        "ok": True,
        "structSize": actual,
        "filterChars": len(fbuf),
        "initialDir": _default_initial_dir(),
    }


def main() -> int:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    parser = argparse.ArgumentParser(description="Out-of-process Windows native image picker")
    parser.add_argument("--multiple", action="store_true", help="Allow selecting multiple files")
    parser.add_argument("--title", default="选择要上传的图片", help="Dialog title")
    parser.add_argument("--self-test", action="store_true", help="Verify ctypes layout and buffer parsing")
    args = parser.parse_args()

    if args.self_test:
        print(json.dumps(run_self_test(), ensure_ascii=False))
        return 0

    if sys.platform != "win32":
        print(json.dumps({"canceled": True, "paths": [], "error": "仅 Windows 支持进程外对话框"}, ensure_ascii=False))
        return 1

    print(json.dumps(pick_images_windows(multiple=args.multiple, title=args.title), ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
