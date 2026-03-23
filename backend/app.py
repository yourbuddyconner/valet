"""Valet Modal backend — web endpoints for session/sandbox management."""

from __future__ import annotations

import os

import modal

from config import WHISPER_MODELS_MOUNT, WHISPER_MODELS_VOLUME

app = modal.App("valet-backend")

# Image for the web functions — includes our backend Python modules
# Also mount runner package and docker files so sandbox image builds can reference them
fn_image = (
    modal.Image.debian_slim()
    .pip_install("fastapi[standard]")
    .add_local_python_source("session", "sandboxes", "config", "images")
    .add_local_dir("docker", remote_path="/root/docker")
    .add_local_dir("packages/runner", remote_path="/root/packages/runner")
    .add_local_dir("packages/shared", remote_path="/root/packages/shared")
)

from sandboxes import SandboxAlreadyFinishedError
from session import CreateSessionRequest, SessionManager

session_manager = SessionManager(app)


@app.function(image=fn_image, timeout=1800)
@modal.fastapi_endpoint(method="POST", label="create-session")
async def create_session(request: dict) -> dict:
    """Create a new session and spawn a sandbox.

    Request body:
        sessionId: str
        userId: str
        workspace: str
        imageType: str (default "base")
        doWsUrl: str
        runnerToken: str
        jwtSecret: str
        idleTimeoutSeconds: int (default 900)
        envVars: dict[str, str] (optional)

    Returns:
        sandboxId: str
        tunnelUrls: dict[str, str]
    """
    req = CreateSessionRequest(
        session_id=request["sessionId"],
        user_id=request["userId"],
        workspace=request["workspace"],
        image_type=request.get("imageType", "base"),
        do_ws_url=request["doWsUrl"],
        runner_token=request["runnerToken"],
        jwt_secret=request["jwtSecret"],
        idle_timeout_seconds=request.get("idleTimeoutSeconds", 900),
        cpu_cores=request.get("sandboxCpuCores"),
        memory_mib=request.get("sandboxMemoryMib"),
        env_vars=request.get("envVars"),
        persona_files=request.get("personaFiles"),
    )

    result = await session_manager.create(req)

    return {
        "sandboxId": result.sandbox_id,
        "tunnelUrls": result.tunnel_urls,
    }


@app.function(image=fn_image)
@modal.fastapi_endpoint(method="POST", label="terminate-session")
async def terminate_session(request: dict) -> dict:
    """Terminate a session's sandbox.

    Request body:
        sandboxId: str

    Returns:
        success: bool
    """
    sandbox_id = request["sandboxId"]
    await session_manager.terminate(sandbox_id)
    return {"success": True}


@app.function(image=fn_image)
@modal.fastapi_endpoint(method="POST", label="hibernate-session")
async def hibernate_session(request: dict) -> dict:
    """Hibernate a session by snapshotting the sandbox filesystem and terminating it.

    Request body:
        sandboxId: str

    Returns:
        snapshotImageId: str
    """
    from fastapi.responses import JSONResponse

    sandbox_id = request["sandboxId"]
    try:
        snapshot_image_id = await session_manager.hibernate(sandbox_id)
    except SandboxAlreadyFinishedError:
        return JSONResponse(
            status_code=409,
            content={"error": "sandbox_already_finished", "message": "Sandbox has already exited (idle timeout). Cannot hibernate."},
        )
    return {"snapshotImageId": snapshot_image_id}


@app.function(image=fn_image, timeout=1800)
@modal.fastapi_endpoint(method="POST", label="restore-session")
async def restore_session(request: dict) -> dict:
    """Restore a session from a filesystem snapshot.

    Request body:
        sessionId: str
        userId: str
        workspace: str
        imageType: str (default "base")
        doWsUrl: str
        runnerToken: str
        jwtSecret: str
        idleTimeoutSeconds: int (default 900)
        envVars: dict[str, str] (optional)
        snapshotImageId: str

    Returns:
        sandboxId: str
        tunnelUrls: dict[str, str]
    """
    req = CreateSessionRequest(
        session_id=request["sessionId"],
        user_id=request["userId"],
        workspace=request["workspace"],
        image_type=request.get("imageType", "base"),
        do_ws_url=request["doWsUrl"],
        runner_token=request["runnerToken"],
        jwt_secret=request["jwtSecret"],
        idle_timeout_seconds=request.get("idleTimeoutSeconds", 900),
        cpu_cores=request.get("sandboxCpuCores"),
        memory_mib=request.get("sandboxMemoryMib"),
        env_vars=request.get("envVars"),
        persona_files=request.get("personaFiles"),
    )

    result = await session_manager.restore(req, request["snapshotImageId"])

    return {
        "sandboxId": result.sandbox_id,
        "tunnelUrls": result.tunnel_urls,
    }


@app.function(image=fn_image)
@modal.fastapi_endpoint(method="POST", label="session-status")
async def session_status(request: dict) -> dict:
    """Get status of a session's sandbox.

    Request body:
        sandboxId: str

    Returns:
        sandboxId: str
        status: str
    """
    sandbox_id = request["sandboxId"]
    return await session_manager.status(sandbox_id)


@app.function(image=fn_image)
@modal.fastapi_endpoint(method="POST", label="delete-workspace")
async def delete_workspace(request: dict) -> dict:
    """Delete a session's persisted workspace volume.

    Request body:
        sessionId: str

    Returns:
        success: bool
        deleted: bool
    """
    session_id = request["sessionId"]
    deleted = await session_manager.delete_workspace(session_id)
    return {"success": True, "deleted": deleted}


@app.function(
    image=fn_image,
    volumes={WHISPER_MODELS_MOUNT: modal.Volume.from_name(WHISPER_MODELS_VOLUME, create_if_missing=True)},
    timeout=1800,
)
def setup_whisper_models():
    """Download whisper.cpp GGML models into the shared volume. Run once.

    Usage: modal run backend/app.py::setup_whisper_models
    """
    import urllib.request

    mount = "/models/whisper"
    base_url = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main"
    models = [
        ("ggml-base.en.bin", 142_000_000),
        ("ggml-large-v3.bin", 3_095_000_000),
    ]
    for name, expected_size in models:
        path = f"{mount}/{name}"
        if os.path.exists(path) and os.path.getsize(path) > expected_size * 0.9:
            print(f"Already exists: {name} ({os.path.getsize(path)} bytes)")
            continue
        print(f"Downloading {name}...")
        urllib.request.urlretrieve(f"{base_url}/{name}", path)
        print(f"Downloaded {name} ({os.path.getsize(path)} bytes)")

    modal.Volume.from_name("whisper-models").commit()
