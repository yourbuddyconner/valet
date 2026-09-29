/**
 * `valet` CLI entry point / dispatcher.
 *
 * `valet serve` boots the full product; every other subcommand is a client
 * of a running instance. All command modules — and the TUI/prompt/client
 * deps they pull in — are loaded via DYNAMIC import so `serve` pays nothing
 * for them.
 *
 * This module is the bundle entry (see `build.mjs`). Importing it must not
 * have side effects beyond running `main()` at the bottom.
 */
import { loadConfig } from "./cli/config.js";
import { CliError, ExitCode } from "./cli/exit.js";
import { printErr, printLine } from "./cli/output.js";
import type { CommandModule } from "./cli/types.js";
import { VALET_VERSION } from "./version.js";

/** Lazy importer for a command module. */
type CommandImporter = () => Promise<CommandModule>;

/**
 * The subcommand dispatch table. `serve` boots the product; every other
 * command is a client of a running instance.
 *
 * Every entry is a lazy importer so unrelated deps stay off any single
 * command's path — `serve` never pays for the client/TUI deps, and the client
 * commands never pay for the heavy server graph (`serve` itself imports
 * `main.ts` lazily, inside `run`).
 */
const COMMANDS: Record<string, CommandImporter> = {
  serve: () => import("./cli/commands/serve.js"),
  threads: () => import("./cli/commands/threads.js"),
  sessions: () => import("./cli/commands/sessions.js"),
  send: () => import("./cli/commands/send.js"),
  upload: () => import("./cli/commands/upload.js"),
  handoff: () => import("./cli/commands/handoff.js"),
  gates: () => import("./cli/commands/gates.js"),
  status: () => import("./cli/commands/status.js"),
  login: () => import("./cli/commands/login.js"),
  logout: () => import("./cli/commands/logout.js"),
  instance: () => import("./cli/commands/instance.js"),
  config: () => import("./cli/commands/config.js"),
  chat: () => import("./cli/commands/chat.js"),
  mcp: () => import("./cli/commands/mcp.js"),
  reset: () => import("./cli/commands/reset.js"),
  prebuild: () => import("./cli/commands/prebuild.js"),
};

const USAGE = `valet <command> [options]

Commands:
  serve       Boot the Valet server (the full product)
  threads     List, create, and inspect workspace threads
  sessions    Legacy runtime commands (compatible with existing scripts)
  send        Send a prompt to a thread
  upload      Upload files to a session sandbox
  handoff     Hand off work from a local agent to Valet
  gates       List and resolve decision gates
  status      Show instance / session status
  login       Add or authenticate an instance profile
  logout      Remove an instance profile
  instance    Manage instance profiles
  config      View or edit CLI config
  chat        Interactive chat with a thread
  mcp         MCP client operations
  reset       Reset local state
  prebuild    Test a repo's .valet/prebuild.yaml locally (plan / docker build)

Global options:
  --json          Machine-readable JSON output (where supported)
  --instance <n>  Select an instance profile
  -h, --help      Show this help
  -V, --version   Show the CLI version`;

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const first = argv[0];

  // No subcommand → usage to stderr, exit 2.
  if (first === undefined) {
    printErr(USAGE);
    return ExitCode.Usage;
  }

  // Global help / version, only when they are the leading token.
  if (first === "--help" || first === "-h") {
    printLine(USAGE);
    return ExitCode.OK;
  }
  if (first === "--version" || first === "-V") {
    printLine(VALET_VERSION);
    return ExitCode.OK;
  }

  const rest = argv.slice(1);

  const importer = COMMANDS[first];
  if (importer === undefined) {
    printErr(`unknown command: ${first}\n`);
    printErr(USAGE);
    return ExitCode.Usage;
  }

  const config = loadConfig();
  const mod = await importer();
  return await mod.run(rest, { command: first, config });
}

main()
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    printErr(message);
    process.exit(err instanceof CliError ? err.exitCode : 1);
  });
