import packageJson from "../../package.json" with { type: "json" };
import {
  BUILD_FORK_MIGRATION_HEAD,
  BUILD_MIGRATION_HEAD,
  recordedMigrations,
} from "../persistence/databaseMigrationHead.ts";
import {
  isSupportedLauncherProtocol,
  SERVICE_LAUNCHER_PROTOCOL,
  type SupportedLauncherProtocol,
} from "./serviceProtocol.ts";

export type ServicePreflightResult =
  | {
      readonly status: "ready";
      readonly version: string;
      /** The launcher protocol the server named; it accepts no other in reply. */
      readonly launcherProtocol: SupportedLauncherProtocol;
    }
  | {
      readonly status: "blocked";
      readonly version: string;
      readonly reason: string;
    };

export function runServicePreflight(input: {
  readonly databasePath: string;
  readonly launcherProtocol: number;
  readonly version?: string;
}): ServicePreflightResult {
  const version = input.version ?? packageJson.version;
  const { launcherProtocol } = input;
  if (!isSupportedLauncherProtocol(launcherProtocol)) {
    return {
      status: "blocked",
      version,
      reason: [
        `The installed service launcher speaks protocol ${launcherProtocol}, but styal@${version} requires protocol ${SERVICE_LAUNCHER_PROTOCOL}.`,
        `On the server machine, run: npx @styal/cli@${version} service update`,
        `Check that \`styal --version\` prints ${version} and that \`which -a styal\` lists no older styal first.`,
        "Updating the desktop app does not update this CLI, and `styal service update` only repairs the service with whichever CLI runs it.",
      ].join(" "),
    };
  }

  const newer = newerRecordedMigrations(input.databasePath);
  if (newer === null) {
    return {
      status: "blocked",
      version,
      reason: `Could not read this database to confirm @styal/cli@${version} supports it.`,
    };
  }
  if (newer.length > 0) {
    return {
      status: "blocked",
      version,
      reason: `This database has migrations that @styal/cli@${version} does not know: ${newer.join(", ")}. A newer build wrote them, and running @styal/cli@${version} on this database is not safe. Stay on the newer release, or wait for a release that includes these migrations.`,
    };
  }

  return { status: "ready", version, launcherProtocol };
}

/** Migrations a newer build recorded, or null when the database exists but cannot be read.
 * Startup already handles renamed ids this build knows. */
function newerRecordedMigrations(databasePath: string): ReadonlyArray<string> | null {
  const recorded = recordedMigrations(databasePath);
  if (recorded === null) return null;
  const newer = (
    migrations: ReadonlyArray<{ readonly id: number; readonly name: string }>,
    head: number,
  ) => migrations.filter(({ id }) => id > head).map(({ id, name }) => `${id}_${name}`);
  return [
    ...newer(recorded.upstream, BUILD_MIGRATION_HEAD),
    ...newer(recorded.fork, BUILD_FORK_MIGRATION_HEAD),
  ];
}

export function decodeServicePreflightResult(
  value: unknown,
  launcherProtocol: SupportedLauncherProtocol,
): ServicePreflightResult | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (
    record.status === "ready" &&
    record.launcherProtocol === launcherProtocol &&
    typeof record.version === "string"
  ) {
    return { status: "ready", version: record.version, launcherProtocol };
  }
  if (
    record.status === "blocked" &&
    typeof record.version === "string" &&
    typeof record.reason === "string"
  ) {
    return { status: "blocked", version: record.version, reason: record.reason };
  }
  return undefined;
}
