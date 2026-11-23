"""Standalone entrypoint for packaged flowboard-agent.exe (server + Win32 file picker)."""
from __future__ import annotations

import argparse
import json
import multiprocessing
import os
import sys
import tempfile


def main() -> int:
    multiprocessing.freeze_support()
    if sys.stdout is None:
        sys.stdout = open(os.devnull, "w", encoding="utf-8")
    if sys.stderr is None:
        sys.stderr = open(os.devnull, "w", encoding="utf-8")

    if "--pick-images" in sys.argv[1:]:
        picker_args = [a for a in sys.argv[1:] if a != "--pick-images"]
        from flowboard.win_file_picker import main as picker_main

        return picker_main(picker_args)

    if "--self-test-server" in sys.argv[1:]:
        with tempfile.TemporaryDirectory(
            prefix="flowboard-selftest-", ignore_cleanup_errors=True
        ) as tmpdir:
            os.environ["FLOWBOARD_STORAGE"] = tmpdir
            from flowboard.db import engine, init_db
            from flowboard.main import app

            try:
                init_db()
                route_count = len(app.routes)
                assert route_count > 10, f"unexpected route count: {route_count}"
                print(json.dumps({"ok": True, "routes": route_count}))
                return 0
            finally:
                engine.dispose()

    parser = argparse.ArgumentParser(description="AI Canvas Studio Local Agent")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8434)
    args = parser.parse_args()

    import uvicorn
    from flowboard.main import app

    uvicorn.run(
        app,
        host=args.host,
        port=args.port,
        timeout_graceful_shutdown=2,
        log_level="info",
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
