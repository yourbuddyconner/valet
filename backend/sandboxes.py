"""Sandbox lifecycle management for Modal sandboxes."""

from __future__ import annotations

from dataclasses import dataclass

import logging
import modal

# ConflictError is public API (Modal v1.3+) but may not exist in older
# runtime SDKs injected into function containers. Fall back to catching
# the raw grpclib.GRPCError that Modal is migrating away from.
try:
    _ConflictError = modal.exception.ConflictError
except AttributeError:
    try:
        from grpclib.exceptions import GRPCError as _ConflictError
    except ImportError:
        _ConflictError = None

logger = logging.getLogger(__name__)

from config import (
    DEFAULT_IDLE_TIMEOUT_SECONDS,
    GATEWAY_PORT,
    MAX_TIMEOUT_SECONDS,
    MODAL_IDLE_TIMEOUT_BUFFER_SECONDS,
    OPENCODE_PORT,
    SANDBOX_DEFAULT_CPU_CORES,
    SANDBOX_DEFAULT_MEMORY_MIB,
    WHISPER_MODELS_MOUNT,
    WHISPER_MODELS_VOLUME,
    get_secret,
)
from images.base import get_base_image


class SandboxAlreadyFinishedError(Exception):
    """Raised when trying to snapshot a sandbox that has already exited."""

    def __init__(self, sandbox_id: str) -> None:
        self.sandbox_id = sandbox_id
        super().__init__(f"Sandbox {sandbox_id} has already finished and cannot be snapshotted")


@dataclass
class SandboxConfig:
    session_id: str
    user_id: str
    workspace: str
    do_ws_url: str
    runner_token: str
    jwt_secret: str
    image_type: str = "base"
    idle_timeout_seconds: int = DEFAULT_IDLE_TIMEOUT_SECONDS
    cpu_cores: float = SANDBOX_DEFAULT_CPU_CORES
    memory_mib: int = SANDBOX_DEFAULT_MEMORY_MIB
    env_vars: dict[str, str] | None = None
    persona_files: list[dict] | None = None


@dataclass
class SandboxResult:
    sandbox_id: str
    tunnel_urls: dict[str, str]


class SandboxManager:
    """Manages Modal sandbox creation, termination, and health checks."""

    def __init__(self, app: modal.App) -> None:
        self.app = app

    @staticmethod
    def workspace_volume_name(session_id: str) -> str:
        """Return the Modal volume name used for a session workspace.

        For orchestrator sessions with rotated IDs (orchestrator:<userId>:<uuid>),
        strip the rotation suffix so the volume is stable across refreshes.
        """
        # orchestrator:<userId>:<rotationUuid> → orchestrator:<userId>
        parts = session_id.split(":")
        if len(parts) >= 3 and parts[0] == "orchestrator":
            session_id = f"{parts[0]}:{parts[1]}"
        return f"workspace-{session_id.replace(':', '-')}"

    async def create_sandbox(self, config: SandboxConfig) -> SandboxResult:
        """Create a new Modal sandbox for a session."""
        image = self._get_image(config.image_type)

        # Start with caller-provided env vars (LLM keys, repo config, etc.)
        secrets_dict: dict[str, str] = dict(config.env_vars) if config.env_vars else {}

        # Core secrets are set last so env_vars cannot override them
        secrets_dict.update({
            "DO_WS_URL": config.do_ws_url,
            "RUNNER_TOKEN": config.runner_token,
            "SESSION_ID": config.session_id,
            "JWT_SECRET": config.jwt_secret,
            "OPENCODE_SERVER_PASSWORD": get_secret("OPENCODE_SERVER_PASSWORD"),
        })

        # Strip empty values so Modal doesn't set blank env vars
        secrets_dict = {k: v for k, v in secrets_dict.items() if v}

        sandbox = await modal.Sandbox.create.aio(
            "/bin/bash", "/start.sh",
            app=self.app,
            image=image,
            cpu=config.cpu_cores,
            memory=config.memory_mib,
            encrypted_ports=[OPENCODE_PORT, GATEWAY_PORT],
            timeout=MAX_TIMEOUT_SECONDS,
            idle_timeout=config.idle_timeout_seconds + MODAL_IDLE_TIMEOUT_BUFFER_SECONDS,
            secrets=[modal.Secret.from_dict(secrets_dict)],
            volumes={
                "/workspace": modal.Volume.from_name(
                    self.workspace_volume_name(config.session_id),
                    create_if_missing=True,
                ),
                WHISPER_MODELS_MOUNT: modal.Volume.from_name(WHISPER_MODELS_VOLUME),
            },
        )

        tunnels = await sandbox.tunnels.aio()

        tunnel_urls: dict[str, str] = {}
        if OPENCODE_PORT in tunnels:
            tunnel_urls["opencode"] = tunnels[OPENCODE_PORT].url
        if GATEWAY_PORT in tunnels:
            gateway_url = tunnels[GATEWAY_PORT].url
            tunnel_urls["gateway"] = gateway_url
            tunnel_urls["vscode"] = f"{gateway_url}/vscode"
            tunnel_urls["vnc"] = f"{gateway_url}/vnc"
            tunnel_urls["ttyd"] = f"{gateway_url}/ttyd"

        return SandboxResult(
            sandbox_id=sandbox.object_id,
            tunnel_urls=tunnel_urls,
        )

    async def terminate_sandbox(self, sandbox_id: str) -> None:
        """Terminate a running sandbox."""
        sandbox = await modal.Sandbox.from_id.aio(sandbox_id)
        await sandbox.terminate.aio()

    async def delete_workspace_volume(self, session_id: str) -> bool:
        """Delete a session's workspace volume. Returns True when deleted."""
        volume_name = self.workspace_volume_name(session_id)
        try:
            await modal.Volume.delete.aio(volume_name)
            return True
        except modal.exception.NotFoundError:
            return False

    async def get_sandbox_status(self, sandbox_id: str) -> dict:
        """Check sandbox status."""
        try:
            sandbox = await modal.Sandbox.from_id.aio(sandbox_id)
            return {
                "sandbox_id": sandbox_id,
                "status": "running",
            }
        except Exception:
            return {
                "sandbox_id": sandbox_id,
                "status": "terminated",
            }

    async def snapshot_and_terminate(self, sandbox_id: str) -> str:
        """Snapshot a sandbox's filesystem and terminate it. Returns the snapshot image ID."""
        sandbox = await modal.Sandbox.from_id.aio(sandbox_id)
        try:
            image = await sandbox.snapshot_filesystem.aio(timeout=55)
        except Exception as exc:
            # Sandbox already exited (e.g. idle timeout) — can't snapshot.
            # Use the resolved _ConflictError type when available, otherwise
            # fall back to duck-typing the exception for resilience across
            # Modal runtime SDK versions.
            if _ConflictError is not None and isinstance(exc, _ConflictError):
                raise SandboxAlreadyFinishedError(sandbox_id)
            exc_type = type(exc).__name__
            if exc_type in ("GRPCError", "ConflictError") and "already finished" in str(exc).lower():
                raise SandboxAlreadyFinishedError(sandbox_id)
            logger.warning(
                "snapshot_and_terminate: unhandled %s for sandbox %s: %s",
                exc_type, sandbox_id, exc,
            )
            raise
        await sandbox.terminate.aio()
        return image.object_id

    async def restore_sandbox(self, config: SandboxConfig, snapshot_image_id: str) -> SandboxResult:
        """Restore a sandbox from a filesystem snapshot image."""
        image = modal.Image.from_id(snapshot_image_id)

        secrets_dict: dict[str, str] = dict(config.env_vars) if config.env_vars else {}

        secrets_dict.update({
            "DO_WS_URL": config.do_ws_url,
            "RUNNER_TOKEN": config.runner_token,
            "SESSION_ID": config.session_id,
            "JWT_SECRET": config.jwt_secret,
            "OPENCODE_SERVER_PASSWORD": get_secret("OPENCODE_SERVER_PASSWORD"),
        })

        secrets_dict = {k: v for k, v in secrets_dict.items() if v}

        sandbox = await modal.Sandbox.create.aio(
            "/bin/bash", "/start.sh",
            app=self.app,
            image=image,
            cpu=config.cpu_cores,
            memory=config.memory_mib,
            encrypted_ports=[OPENCODE_PORT, GATEWAY_PORT],
            timeout=MAX_TIMEOUT_SECONDS,
            idle_timeout=config.idle_timeout_seconds + MODAL_IDLE_TIMEOUT_BUFFER_SECONDS,
            secrets=[modal.Secret.from_dict(secrets_dict)],
            volumes={
                "/workspace": modal.Volume.from_name(
                    self.workspace_volume_name(config.session_id),
                    create_if_missing=True,
                ),
                WHISPER_MODELS_MOUNT: modal.Volume.from_name(WHISPER_MODELS_VOLUME),
            },
        )

        tunnels = await sandbox.tunnels.aio()

        tunnel_urls: dict[str, str] = {}
        if OPENCODE_PORT in tunnels:
            tunnel_urls["opencode"] = tunnels[OPENCODE_PORT].url
        if GATEWAY_PORT in tunnels:
            gateway_url = tunnels[GATEWAY_PORT].url
            tunnel_urls["gateway"] = gateway_url
            tunnel_urls["vscode"] = f"{gateway_url}/vscode"
            tunnel_urls["vnc"] = f"{gateway_url}/vnc"
            tunnel_urls["ttyd"] = f"{gateway_url}/ttyd"

        return SandboxResult(
            sandbox_id=sandbox.object_id,
            tunnel_urls=tunnel_urls,
        )

    def _get_image(self, image_type: str) -> modal.Image:
        """Get the appropriate image for the workspace type."""
        # Phase 1: always use base image
        # Future: repo-specific images
        return get_base_image()
