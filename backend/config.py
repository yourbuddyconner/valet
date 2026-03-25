"""Configuration and constants for the Valet backend."""

import os

# Sandbox defaults
DEFAULT_IDLE_TIMEOUT_SECONDS = 15 * 60  # 15 minutes
SANDBOX_DEFAULT_CPU_CORES = 0.25
SANDBOX_DEFAULT_MEMORY_MIB = 512
MODAL_IDLE_TIMEOUT_BUFFER_SECONDS = 30 * 60  # 30-minute safety buffer beyond DO's idle timeout
MAX_TIMEOUT_SECONDS = 24 * 60 * 60  # 24 hours
OPENCODE_PORT = 4096
GATEWAY_PORT = 9000

# Whisper (speech-to-text)
WHISPER_MODELS_VOLUME = "whisper-models"
WHISPER_MODELS_MOUNT = "/models/whisper"

# Image defaults
BASE_IMAGE_TAG = "debian:bookworm-slim"
NODE_VERSION = "22"
BUN_VERSION = "latest"


def get_secret(name: str, default: str = "") -> str:
    """Get a secret from environment variables."""
    return os.environ.get(name, default)
