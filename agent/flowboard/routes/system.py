"""Local-only service shutdown endpoint for zero-terminal Web and Desktop modes."""
from __future__ import annotations

import asyncio
import json
import logging
import os
import subprocess
import sys

from fastapi import APIRouter, Depends
from pydantic import BaseModel

from flowboard.config import STORAGE_DIR
from flowboard.db import engine
from flowboard.services.flow_client import flow_client
from flowboard.worker.processor import get_worker
from .local_only import local_origin

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/system", tags=["system"], dependencies=[Depends(local_origin)])

PID_FILE = STORAGE_DIR / "web-service-pids.json"


class ShutdownRequest(BaseModel):
    defer_process_exit: bool = False
    stop_frontend: bool = True


def _terminate_companion_frontend() -> None:
    """Terminate the background Vite frontend process recorded by the silent web launcher."""
    if not PID_FILE.is_file():
        return
    try:
        data = json.loads(PID_FILE.read_text(encoding="utf-8"))
    except Exception:
        return
    finally:
        try:
            PID_FILE.unlink(missing_ok=True)
        except OSError:
            pass

    frontend_pid = data.get("frontend_pid")
    if not isinstance(frontend_pid, int) or frontend_pid <= 0 or frontend_pid == os.getpid():
        return

    try:
        if sys.platform == "win32":
            subprocess.run(
                ["taskkill", "/PID", str(frontend_pid), "/T", "/F"],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0x08000000),
                timeout=3,
                check=False,
            )
        else:
            os.kill(frontend_pid, 15)
    except Exception:
        pass


async def _graceful_process_exit(stop_frontend: bool) -> None:
    await asyncio.sleep(0.45)
    worker = get_worker()
    worker.request_shutdown()
    try:
        await asyncio.wait_for(worker.drain(), timeout=1.5)
    except Exception:
        pass
    flow_client.clear_extension()
    try:
        engine.dispose()
    except Exception:
        pass
    if stop_frontend:
        _terminate_companion_frontend()
    logger.info("Flowboard service shutting down via /api/system/shutdown")
    os._exit(0)


@router.post("/shutdown")
async def shutdown_service(body: ShutdownRequest | None = None) -> dict:
    """Shut down local backend (and companion Vite frontend if running in silent web mode)."""
    opts = body or ShutdownRequest()
    worker = get_worker()
    worker.request_shutdown()
    if not opts.defer_process_exit:
        asyncio.create_task(_graceful_process_exit(opts.stop_frontend))
    return {"ok": True, "shutting_down": True}
