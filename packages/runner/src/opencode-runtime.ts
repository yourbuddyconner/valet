import { join } from "path";

export interface OpenCodeRuntimePaths {
  runtimeDir: string;
  configHome: string;
  dataHome: string;
  stateHome: string;
  cacheHome: string;
  homeDir: string;
  configDir: string;
  authJsonPath: string;
  databasePath: string;
  personaDir: string;
}

export function getOpenCodeRuntimePaths(
  runtimeDir = process.env.OPENCODE_RUNTIME_DIR || "/tmp/valet-opencode",
): OpenCodeRuntimePaths {
  const configHome = join(runtimeDir, "config");
  const dataHome = join(runtimeDir, "data");
  const stateHome = join(runtimeDir, "state");
  const cacheHome = join(runtimeDir, "cache");

  return {
    runtimeDir,
    configHome,
    dataHome,
    stateHome,
    cacheHome,
    homeDir: join(runtimeDir, "home"),
    configDir: join(configHome, "opencode"),
    authJsonPath: join(dataHome, "opencode", "auth.json"),
    databasePath: join(dataHome, "opencode", "opencode.db"),
    personaDir: join(runtimeDir, "persona"),
  };
}
