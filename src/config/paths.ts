import { homedir, platform } from "node:os";
import { join } from "node:path";

export interface Paths {
  home: string;
  configFile: string;
  dbFile: string;
  hooksDir: string;
}

function platformDefault(): Pick<Paths, "configFile" | "dbFile" | "hooksDir"> {
  const home = homedir();
  const p = platform();
  if (p === "darwin") {
    const base = join(home, "Library", "Application Support", "unguibus");
    return {
      configFile: join(base, "config.toml"),
      dbFile: join(base, "unguibus.db"),
      hooksDir: join(base, "hooks"),
    };
  }
  if (p === "win32") {
    const localAppData = process.env.LOCALAPPDATA ?? join(home, "AppData", "Local");
    const roaming = process.env.APPDATA ?? join(home, "AppData", "Roaming");
    return {
      configFile: join(roaming, "unguibus", "config.toml"),
      dbFile: join(localAppData, "unguibus", "unguibus.db"),
      hooksDir: join(localAppData, "unguibus", "hooks"),
    };
  }
  const configBase = process.env.XDG_CONFIG_HOME ?? join(home, ".config");
  const dataBase = process.env.XDG_DATA_HOME ?? join(home, ".local", "share");
  return {
    configFile: join(configBase, "unguibus", "config.toml"),
    dbFile: join(dataBase, "unguibus", "unguibus.db"),
    hooksDir: join(dataBase, "unguibus", "hooks"),
  };
}

export function resolvePaths(env: NodeJS.ProcessEnv = process.env): Paths {
  const override = env.UNGUIBUS_HOME;
  if (override && override.length > 0) {
    return {
      home: override,
      configFile: join(override, "config.toml"),
      dbFile: join(override, "unguibus.db"),
      hooksDir: join(override, "hooks"),
    };
  }
  const defaults = platformDefault();
  return { home: "", ...defaults };
}
