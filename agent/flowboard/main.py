import asyncio
import hmac
import logging
import os
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import Depends, FastAPI, HTTPException, Header, Request as FastAPIRequest
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from flowboard.config import EXTENSION_WS_PORT, ROOT, WS_HOST
from flowboard.db import get_session, init_db
from flowboard.db.models import Node, PipelineRun, Request
from flowboard.routes import activity, auth, boards, chat, edges, flow_projects, llm, media, nodes, plans, projects, prompt, system, upload, vision
from flowboard.routes import flow_accounts as flow_accounts_route
from flowboard.routes.local_only import EXTENSION_ORIGIN_REGEX, allowed_ui_origins, local_origin
from flowboard.routes import provider_jobs as provider_jobs_route
from flowboard.routes import references as references_route
from flowboard.routes import requests as requests_route
from flowboard.services.flow_client import flow_client
from flowboard.services.ws_server import run_ws_server
from flowboard.worker.processor import get_worker

# Guard rail: the dedicated WS server is unauthenticated and would expose the
# callback secret to any process that can reach it. Refuse to boot if someone
# overrode WS_HOST to a non-loopback address.
if WS_HOST not in ("127.0.0.1", "localhost", "::1"):
    raise RuntimeError(
        f"FLOWBOARD_WS_HOST must be loopback (got {WS_HOST!r}); the extension WS "
        "is unauthenticated by design and must not be network-reachable."
    )

logger = logging.getLogger(__name__)
logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(name)s: %(message)s")


class _RedactOAuthCallbackQuery(logging.Filter):
    def filter(self, record: logging.LogRecord) -> bool:
        # uvicorn access records carry the request path as their third arg.
        args = record.args
        if isinstance(args, tuple) and len(args) == 5 and isinstance(args[2], str):
            path, _, _ = args[2].partition("?")
            if path == "/api/flow-accounts/google/callback":
                record.args = (*args[:2], path, *args[3:])
        return True


logging.getLogger("uvicorn.access").addFilter(_RedactOAuthCallbackQuery())


def _recover_orphan_running_requests() -> int:
    """Fail every request a restart orphaned, so nothing is left to poll.

    Both in-flight statuses are orphaned by a restart, for different
    reasons. A `running` row lost the handler that was driving it. A
    `queued` row lost its *consumer*: the worker's queue is an in-process
    ``asyncio.Queue`` filled only by ``enqueue()`` at dispatch time, and
    nothing replays it at boot — so a queued row that survives a restart
    has no path to ever being picked up. `ACTIVE_REQUEST_STATUSES` in
    routes/boards.py counts both as in-flight, which means a reloaded
    board would hand those dead rows to the browser and spin on them
    forever.

    Deliberately NOT re-enqueued. Every generation type here dispatches a
    paid Flow job, and we cannot tell from the row whether the dispatch
    already went out before the process died; replaying it risks
    double-firing. Failing loud and letting the user re-run is the safe
    direction.

    The two get distinct `error` strings so the activity feed can tell
    "never started" from "died mid-run" — only the latter may have burned
    credits upstream.
    """
    from datetime import datetime, timezone
    from sqlmodel import select as _select

    touched = 0
    with get_session() as s:
        rows = s.exec(
            _select(Request).where(Request.status.in_(("queued", "running")))
        ).all()
        node_ids = set()
        for r in rows:
            r.error = (
                "agent_restart_never_started"
                if r.status == "queued"
                else "agent_restart_lost"
            )
            r.status = "failed"
            r.finished_at = datetime.now(timezone.utc)
            s.add(r)
            if r.node_id is not None:
                node_ids.add(r.node_id)
            touched += 1
        # The worker stamps Node.status='running' at dispatch so a reloaded
        # board still renders the card as busy. Nobody is going to finish
        # these now, so clear that stamp in the same pass — otherwise the
        # node spins forever with no in-flight request left to poll.
        if node_ids:
            for n in s.exec(_select(Node).where(Node.id.in_(node_ids))).all():
                if n.status in ("queued", "running"):
                    n.status = "error"
                    s.add(n)
        if touched:
            s.commit()
    return touched


def _recover_orphan_pipeline_runs() -> None:
    from datetime import datetime, timezone
    from sqlmodel import select

    with get_session() as session:
        rows = session.exec(select(PipelineRun).where(PipelineRun.status.in_(("pending", "running")))).all()
        for row in rows:
            row.status = "failed"
            row.error = "agent_restart_lost"
            row.finished_at = datetime.now(timezone.utc)
            session.add(row)
        if rows:
            session.commit()


@asynccontextmanager
async def lifespan(app: FastAPI):
    init_db()
    recovered = _recover_orphan_running_requests()
    _recover_orphan_pipeline_runs()
    if recovered:
        logger.info("recovered %d orphan in-flight request(s) → failed", recovered)
    worker = get_worker()
    ws_task = asyncio.create_task(run_ws_server(), name="ext-ws-server")
    worker_task = asyncio.create_task(worker.start(), name="request-worker")
    logger.info("flowboard agent started (ws:%d + worker)", EXTENSION_WS_PORT)
    try:
        yield
    finally:
        worker.request_shutdown()
        try:
            await asyncio.wait_for(worker.drain(), timeout=5.0)
        except asyncio.TimeoutError:
            logger.warning("worker drain timed out")
        for t in (ws_task, worker_task):
            t.cancel()
        await asyncio.gather(ws_task, worker_task, return_exceptions=True)
        logger.info("flowboard agent stopped")


app = FastAPI(title="AI Canvas Studio Agent", version="1.1.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=sorted(allowed_ui_origins()),
    allow_origin_regex=EXTENSION_ORIGIN_REGEX,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

_LOCAL_DEPS = [Depends(local_origin)]

app.include_router(boards.router, dependencies=_LOCAL_DEPS)
app.include_router(nodes.router, dependencies=_LOCAL_DEPS)
app.include_router(edges.router, dependencies=_LOCAL_DEPS)
app.include_router(chat.router, dependencies=_LOCAL_DEPS)
app.include_router(projects.router, dependencies=_LOCAL_DEPS)
app.include_router(flow_projects.router, dependencies=_LOCAL_DEPS)
app.include_router(flow_accounts_route.router, dependencies=_LOCAL_DEPS)
app.include_router(references_route.router, dependencies=_LOCAL_DEPS)
app.include_router(requests_route.router, dependencies=_LOCAL_DEPS)
app.include_router(media.bytes_router, dependencies=_LOCAL_DEPS)
app.include_router(media.api_router, dependencies=_LOCAL_DEPS)
app.include_router(upload.router, dependencies=_LOCAL_DEPS)
app.include_router(plans.router, dependencies=_LOCAL_DEPS)
app.include_router(vision.router, dependencies=_LOCAL_DEPS)
app.include_router(prompt.router, dependencies=_LOCAL_DEPS)
app.include_router(auth.router, dependencies=_LOCAL_DEPS)
app.include_router(llm.router, dependencies=_LOCAL_DEPS)
app.include_router(activity.router, dependencies=_LOCAL_DEPS)
app.include_router(provider_jobs_route.router, dependencies=_LOCAL_DEPS)
app.include_router(system.router, dependencies=_LOCAL_DEPS)


@app.get("/api/health", dependencies=_LOCAL_DEPS)
def health() -> dict:
    return {
        "ok": True,
        "extension_connected": flow_client.connected,
        "ws_stats": flow_client.ws_stats,
    }


@app.post("/api/ext/callback")
async def ext_callback(
    body: FastAPIRequest,
    x_callback_secret: str | None = Header(default=None, alias="X-Callback-Secret"),
) -> dict:
    """HTTP callback for the extension to deliver API responses."""
    if not x_callback_secret or not hmac.compare_digest(
        x_callback_secret, flow_client.callback_secret
    ):
        raise HTTPException(status_code=401, detail="invalid callback secret")

    try:
        payload = await body.json()
    except Exception:
        raise HTTPException(status_code=400, detail="invalid json body")

    if not isinstance(payload, dict) or "id" not in payload:
        raise HTTPException(status_code=400, detail="missing id")

    matched = flow_client.resolve_callback(payload)
    return {"ok": matched}


_FRONTEND_DIST = Path(
    os.getenv("FLOWBOARD_FRONTEND_DIST", str(ROOT / "frontend" / "dist"))
)
if (_FRONTEND_DIST / "assets").is_dir():
    app.mount("/assets", StaticFiles(directory=_FRONTEND_DIST / "assets"), name="frontend-assets")


@app.get("/", include_in_schema=False)
def serve_frontend_index():
    index_file = _FRONTEND_DIST / "index.html"
    if not index_file.is_file():
        raise HTTPException(status_code=404, detail="frontend dist not built")
    return FileResponse(index_file)
