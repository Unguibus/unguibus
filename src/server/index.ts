import { version as pkgVersion } from "../../package.json";
import { loadConfig } from "../config/config.ts";
import { resolvePaths } from "../config/paths.ts";
import { openDb } from "../db/schema.ts";
import { Service } from "../service/service.ts";
import { makeHandler } from "./router.ts";

export function startServer(opts?: { port?: number; home?: string }): {
  stop: () => Promise<void>;
  port: number;
  url: string;
} {
  const env = opts?.home ? { ...process.env, UNGUIBUS_HOME: opts.home } : process.env;
  const paths = resolvePaths(env);
  const config = loadConfig(paths.configFile);
  const port = opts?.port ?? config.server.port;
  const db = openDb(paths.dbFile);
  const service = new Service(db, config);
  const handler = makeHandler(service, pkgVersion);

  const server = Bun.serve({
    port,
    hostname: "127.0.0.1",
    fetch: handler,
  });

  return {
    port: server.port,
    url: `http://127.0.0.1:${server.port}`,
    stop: async () => {
      await server.stop(true);
      db.close();
    },
  };
}

if (import.meta.main) {
  const started = startServer();
  console.log(`unguibus v${pkgVersion} listening on ${started.url}`);
  const shutdown = async (signal: string) => {
    console.log(`received ${signal}, shutting down`);
    await started.stop();
    process.exit(0);
  };
  process.on("SIGINT", () => {
    void shutdown("SIGINT");
  });
  process.on("SIGTERM", () => {
    void shutdown("SIGTERM");
  });
}
