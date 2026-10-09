/**
 * The throwaway Postgres the backup is restored into: a new cluster made by `initdb` in a temporary
 * directory, started on 127.0.0.1 only, on a free port, with a random password and no Unix socket.
 * Nothing outside this process knows the password, and nothing in the restored copy can reach out:
 * the extensions that schedule work or make HTTP requests are never created in it (src/scope.ts).
 * `stop()` shuts it down and deletes the directory; the drill calls it on every path out, including
 * Ctrl-C.
 */
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fail } from "./errors.js";
import { pgEnv, run, tail, type PgBin } from "./pg.js";

export interface Cluster {
  /** libpq environment for the copy's `postgres` database */
  env: Record<string, string>;
  port: number;
  dir: string;
  stop(): Promise<void>;
}

/** A free TCP port on 127.0.0.1, as the OS hands one out. */
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

const live = new Set<Cluster>();
let hooked = false;

/** Stop every cluster still running when the process is interrupted. */
function hookSignals(): void {
  if (hooked) return;
  hooked = true;
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const)
    process.once(sig, () => {
      void Promise.allSettled([...live].map((c) => c.stop())).then(() => process.exit(130));
    });
}

function serverLog(dir: string): string {
  try {
    return readFileSync(path.join(dir, "server.log"), "utf8");
  } catch {
    return "";
  }
}

export interface StartOptions {
  bin: PgBin;
  baseEnv: Record<string, string | undefined>;
  /** where the temporary directory goes; default the OS temp directory */
  parent?: string;
  /** seconds to wait for start-up */
  waitSeconds?: number;
}

export async function startCluster(opts: StartOptions): Promise<Cluster> {
  hookSignals();
  const dir = mkdtempSync(path.join(opts.parent ?? tmpdir(), "restoreproof-"));
  const data = path.join(dir, "data");
  const password = randomBytes(24).toString("hex");
  const pwfile = path.join(dir, "pw");
  writeFileSync(pwfile, password + "\n", { mode: 0o600 });
  // LC_ALL=C: on macOS a postmaster started with no locale set becomes multithreaded and refuses to
  // run ("postmaster became multithreaded during startup"); the copy uses no locale anyway
  const env = { ...pgEnv(opts.baseEnv, {}), LC_ALL: "C" };
  const remove = () => rmSync(dir, { recursive: true, force: true });

  const init = await run(
    opts.bin.path("initdb"),
    [
      "-D",
      data,
      "-U",
      "restoreproof",
      "--auth=scram-sha-256",
      `--pwfile=${pwfile}`,
      "-E",
      "UTF8",
      "--no-locale",
      "--no-sync",
    ],
    { env, timeoutMs: 120_000 },
  );
  rmSync(pwfile, { force: true });
  if (init.code !== 0) {
    remove();
    throw fail(
      "COPY_INIT_FAILED",
      `initdb could not make the throwaway cluster:\n${tail(init.stderr)}`,
      "Check that the temporary directory is writable and has free space.",
      true,
    );
  }

  let started: { port: number } | null = null;
  let lastErr = "";
  for (let attempt = 0; attempt < 3 && !started; attempt++) {
    const port = await freePort();
    const settings = [
      "listen_addresses=127.0.0.1",
      `port=${port}`,
      "unix_socket_directories=''",
      "fsync=off",
      "full_page_writes=off",
      "synchronous_commit=off",
      "max_wal_size=4GB",
      "checkpoint_timeout=30min",
      "max_locks_per_transaction=1024",
      "shared_preload_libraries=''",
      "log_min_messages=warning",
    ];
    const r = await run(
      opts.bin.path("pg_ctl"),
      [
        "-D",
        data,
        "-l",
        path.join(dir, "server.log"),
        "-w",
        "-t",
        String(opts.waitSeconds ?? 60),
        "-o",
        settings.map((s) => `-c ${s}`).join(" "),
        "start",
      ],
      { env, timeoutMs: ((opts.waitSeconds ?? 60) + 15) * 1000 },
    );
    if (r.code === 0) started = { port };
    else lastErr = tail([r.stderr || r.stdout, serverLog(dir)].join("\n"), 8);
  }
  if (!started) {
    remove();
    throw fail(
      "COPY_START_FAILED",
      `the throwaway cluster did not start:\n${lastErr}`,
      "Run it again; if it persists, check free disk space and that 127.0.0.1 accepts connections.",
      true,
    );
  }

  let stopped = false;
  const cluster: Cluster = {
    port: started.port,
    dir,
    env: {
      PGHOST: "127.0.0.1",
      PGPORT: String(started.port),
      PGUSER: "restoreproof",
      PGPASSWORD: password,
      PGDATABASE: "postgres",
      PGSSLMODE: "disable",
    },
    async stop() {
      if (stopped) return;
      stopped = true;
      live.delete(cluster);
      try {
        await run(
          opts.bin.path("pg_ctl"),
          ["-D", data, "-m", "immediate", "-w", "-t", "30", "stop"],
          { env, timeoutMs: 45_000 },
        );
      } finally {
        remove();
      }
    },
  };
  live.add(cluster);
  return cluster;
}
