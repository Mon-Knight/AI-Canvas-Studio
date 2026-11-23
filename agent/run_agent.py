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
    parser.add_argument("--port", type=int, default=int(os.getenv("FLOWBOARD_HTTP_PORT", "8434")))
    args = parser.parse_args()

    from flowboard.port_probe import (
        HTTP_PORT_CANDIDATES,
        WS_PORT_CANDIDATES,
        pick_bindable_port,
        write_active_ports,
    )

    resolved_http = pick_bindable_port(args.port, HTTP_PORT_CANDIDATES, host=args.host)
    pref_ws = int(os.getenv("FLOWBOARD_EXT_WS_PORT", "8355") or "8355")
    resolved_ws = pick_bindable_port(
        pref_ws,
        WS_PORT_CANDIDATES,
        host=args.host,
        disallow={resolved_http},
    )
    os.environ["FLOWBOARD_HTTP_PORT"] = str(resolved_http)
    os.environ["FLOWBOARD_EXT_WS_PORT"] = str(resolved_ws)
    write_active_ports(http_port=resolved_http, ws_port=resolved_ws, pid=os.getpid())

    import uvicorn
    from flowboard.main import app

    uvicorn.run(
        app,
        host=args.host,
        port=resolved_http,
        timeout_graceful_shutdown=2,
        log_level="info",
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
