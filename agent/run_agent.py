"""Standalone entrypoint for packaged flowboard-agent.exe (server + Win32 file picker)."""
from __future__ import annotations

import argparse
import multiprocessing
import sys


def main() -> int:
    multiprocessing.freeze_support()
    if "--pick-images" in sys.argv[1:]:
        picker_args = [a for a in sys.argv[1:] if a != "--pick-images"]
        from flowboard.win_file_picker import main as picker_main

        return picker_main(picker_args)

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
