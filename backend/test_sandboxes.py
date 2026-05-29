from __future__ import annotations

import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

from config import MAX_TIMEOUT_SECONDS
from sandboxes import SandboxConfig, SandboxManager


class _FakeTunnels:
    async def aio(self) -> dict:
        return {}


class _FakeSandbox:
    object_id = "sb-test"
    tunnels = _FakeTunnels()


def _config() -> SandboxConfig:
    return SandboxConfig(
        session_id="session-1",
        user_id="user-1",
        workspace="test",
        do_ws_url="wss://worker/runner",
        runner_token="token",
        jwt_secret="jwt",
        idle_timeout_seconds=900,
    )


class SandboxManagerCreateTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self) -> None:
        self.manager = SandboxManager(app=object())
        self.manager._get_image = lambda _image_type: object()  # type: ignore[method-assign]

    async def test_create_sandbox_does_not_set_modal_idle_timeout(self) -> None:
        create = AsyncMock(return_value=_FakeSandbox())

        with (
            patch("sandboxes.modal.Sandbox.create.aio", create),
            patch("sandboxes.modal.Secret.from_dict", return_value=SimpleNamespace()),
            patch("sandboxes.modal.Volume.from_name", return_value=SimpleNamespace()),
        ):
            await self.manager.create_sandbox(_config())

        kwargs = create.await_args.kwargs
        self.assertEqual(kwargs["timeout"], MAX_TIMEOUT_SECONDS)
        self.assertNotIn("idle_timeout", kwargs)

    async def test_restore_sandbox_does_not_set_modal_idle_timeout(self) -> None:
        create = AsyncMock(return_value=_FakeSandbox())

        with (
            patch("sandboxes.modal.Sandbox.create.aio", create),
            patch("sandboxes.modal.Image.from_id", return_value=object()),
            patch("sandboxes.modal.Secret.from_dict", return_value=SimpleNamespace()),
            patch("sandboxes.modal.Volume.from_name", return_value=SimpleNamespace()),
        ):
            await self.manager.restore_sandbox(_config(), "im-snapshot")

        kwargs = create.await_args.kwargs
        self.assertEqual(kwargs["timeout"], MAX_TIMEOUT_SECONDS)
        self.assertNotIn("idle_timeout", kwargs)


if __name__ == "__main__":
    unittest.main()
