"""Base sandbox image definition for Valet.

Full dev environment: Node.js, Bun, OpenCode CLI,
code-server, VNC stack (Xvfb + fluxbox + x11vnc + websockify + noVNC),
Chromium, TTYD.

Uses debian:bookworm-slim with add_python="3.12" (Debian 12, GLIBC 2.36).
This satisfies wrangler's requirement for GLIBC 2.32+ and ships Chromium
as a normal apt package.
"""

import modal

from config import NODE_VERSION

OPENCODE_VERSION = "1.1.52"


def get_base_image() -> modal.Image:
    """Build the full sandbox image with all dev environment services."""
    return (
        modal.Image.from_registry("debian:bookworm-slim", add_python="3.12")
        .apt_install(
            "git",
            "curl",
            "wget",
            "jq",
            "ripgrep",
            "build-essential",
            "ca-certificates",
            "gnupg",
            "sudo",
            "unzip",
            "openssh-client",
            "bash",
            "procps",
        )
        # Install Node.js
        .run_commands(
            f"curl -fsSL https://deb.nodesource.com/setup_{NODE_VERSION}.x | bash -",
            "apt-get install -y nodejs",
            "npm install -g npm@latest",
        )
        # Install Bun
        .run_commands(
            "curl -fsSL https://bun.sh/install | bash",
        )
        # Install OpenCode CLI + agent-browser
        .run_commands(
            f"npm install -g opencode-ai@{OPENCODE_VERSION} agent-browser",
        )
        # Preinstall Playwright Chromium that matches agent-browser's bundled
        # Playwright version so browser tools work without runtime installs.
        .run_commands(
            "mkdir -p /ms-playwright",
            "AGENT_BROWSER_ROOT=\"$(npm root -g)/agent-browser\"; "
            "if [ -f \"$AGENT_BROWSER_ROOT/node_modules/playwright/cli.js\" ]; then "
            "  PLAYWRIGHT_BROWSERS_PATH=/ms-playwright node \"$AGENT_BROWSER_ROOT/node_modules/playwright/cli.js\" install chromium; "
            "else "
            "  PLAYWRIGHT_BROWSERS_PATH=/ms-playwright npx --yes playwright install chromium; "
            "fi",
            "chmod -R a+rX /ms-playwright",
        )
        # code-server (VS Code in browser)
        .run_commands(
            "curl -fsSL https://code-server.dev/install.sh | sh",
        )
        # VNC stack: Xvfb + fluxbox + x11vnc + websockify + noVNC + Chromium
        .apt_install(
            "xvfb",
            "fluxbox",
            "x11vnc",
            "websockify",
            "novnc",
            "chromium",
            "imagemagick",
            "xdotool",
            "ffmpeg",
        )
        # TTYD (web terminal)
        .run_commands(
            'curl -fsSL -o /usr/local/bin/ttyd "https://github.com/tsl0922/ttyd/releases/download/1.7.7/ttyd.x86_64"',
            "chmod +x /usr/local/bin/ttyd",
        )
        # cloudflared (Cloudflare Quick Tunnels for unique per-tunnel hostnames)
        .run_commands(
            'curl -fsSL -o /usr/local/bin/cloudflared "https://github.com/cloudflare/cloudflared/releases/download/2026.2.0/cloudflared-linux-amd64"',
            "chmod +x /usr/local/bin/cloudflared",
        )
        # whisper.cpp (speech-to-text) — build from source with shared libs installed
        .apt_install("cmake")
        .run_commands(
            "git clone --depth 1 https://github.com/ggml-org/whisper.cpp /tmp/whisper-build",
            "cd /tmp/whisper-build && cmake -B build && cmake --build build --config Release -j$(nproc)",
            "cp /tmp/whisper-build/build/bin/whisper-cli /usr/local/bin/whisper-cli",
            "cp /tmp/whisper-build/build/src/libwhisper.so* /usr/local/lib/",
            "cp /tmp/whisper-build/build/ggml/src/libggml*.so* /usr/local/lib/",
            "ldconfig",
            "rm -rf /tmp/whisper-build",
        )
        # Cache-bust: place version BEFORE runner copy so bumping it invalidates the runner layer
        .run_commands("echo 'RUNNER_VERSION=2026-02-22-v113-v2-turn-id-fix'")
        # Runner package (Bun/TS — runs inside sandbox)
        # Exclude node_modules - it contains symlinks to monorepo root that cause timeouts
        # We run bun install inside the container anyway
        .add_local_dir(
            "/root/packages/runner",
            "/runner",
            copy=True,
            ignore=["node_modules", "*.log"],
        )
        .run_commands("cd /runner && /root/.bun/bin/bun install")
        # Expose workflow CLI as a first-class sandbox command
        .run_commands(
            "printf '#!/bin/bash\\nexec /root/.bun/bin/bun run /runner/src/workflow-cli.ts \"$@\"\\n' > /usr/local/bin/workflow",
            "chmod +x /usr/local/bin/workflow",
        )
        # Copy start.sh
        .add_local_file("/root/docker/start.sh", "/start.sh", copy=True)
        .run_commands("chmod +x /start.sh")
        # OpenCode config and custom tools (browser access)
        .add_local_dir(
            "/root/docker/opencode",
            "/opencode-config",
            copy=True,
        )
        .run_commands("cd /opencode-config && /root/.bun/bin/bun install")
        # Superpowers plugin + skills for OpenCode
        .run_commands(
            "git clone --depth 1 https://github.com/obra/superpowers.git /opencode-superpowers",
            "mkdir -p /opencode-config/plugins /opencode-config/skills",
            "ln -s /opencode-superpowers/.opencode/plugins/superpowers.js /opencode-config/plugins/superpowers.js",
            "ln -s /opencode-superpowers/skills /opencode-config/skills/superpowers",
        )
        # Create workspace directory
        .run_commands("mkdir -p /workspace")
        # Setup bash prompt and environment for terminals
        .run_commands(
            # Create a proper .bashrc with prompt using echo
            "echo 'export PS1=\"agent@sandbox:\\w\\$ \"' > /root/.bashrc",
            "echo 'alias ls=\"ls --color=auto\"' >> /root/.bashrc",
            "echo 'alias ll=\"ls -la\"' >> /root/.bashrc",
            "echo 'export BUN_INSTALL=\"/root/.bun\"' >> /root/.bashrc",
            "echo 'export PATH=\"$BUN_INSTALL/bin:$PATH\"' >> /root/.bashrc",
            # Also create /etc/bash.bashrc for system-wide defaults
            "cp /root/.bashrc /etc/bash.bashrc",
        )
        .env(
            {
                "BUN_INSTALL": "/root/.bun",
                "PATH": "/root/.bun/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
                "DISPLAY": ":99",
                "HOME": "/root",
                # Force image rebuild on deploy (change this value to trigger rebuild)
                "IMAGE_BUILD_VERSION": "2026-03-12-v8-reply-channel-attribution",
                "AGENT_BROWSER_EXECUTABLE_PATH": "/usr/bin/chromium",
                "AGENT_BROWSER_PROFILE": "/root/.agent-browser-profile",
                "PLAYWRIGHT_BROWSERS_PATH": "/ms-playwright",
                # 6 min default bash timeout (OpenCode default is 2 min)
                "OPENCODE_EXPERIMENTAL_BASH_DEFAULT_TIMEOUT_MS": "360000",
            }
        )
    )
