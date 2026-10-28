import type { ConfigProvider, PlatformError } from "effect";

import { Clock, Effect, FileSystem, Option, Path, Predicate, Random, Schema } from "effect";

import { OidcTokenUnavailable } from "../contracts/vercel-oidc.ts";
import { optionalEnv } from "./oidc-token-sources.ts";

export interface LocalEnvironment {
  readonly platform: string;
  readonly home: Option.Option<string>;
  readonly xdgDataHome: Option.Option<string>;
  readonly xdgDataDirs: Option.Option<string>;
  readonly appData: Option.Option<string>;
  readonly localAppData: Option.Option<string>;
  readonly tokenStorage: Option.Option<string>;
  readonly path: Option.Option<string>;
}

const currentPlatform = (): string => {
  const process: unknown = Reflect.get(globalThis, "process");
  return Predicate.hasProperty(process, "platform") && Predicate.isString(process.platform)
    ? process.platform
    : "unknown";
};

export const readLocalEnvironment = Effect.fnUntraced(function* (
  provider: ConfigProvider.ConfigProvider,
) {
  const env = (name: string) => optionalEnv(provider, name);
  const home = yield* env("HOME");
  return {
    platform: currentPlatform(),
    home: Option.isSome(home) ? home : yield* env("USERPROFILE"),
    xdgDataHome: yield* env("XDG_DATA_HOME"),
    xdgDataDirs: yield* env("XDG_DATA_DIRS"),
    appData: yield* env("APPDATA"),
    localAppData: yield* env("LOCALAPPDATA"),
    tokenStorage: yield* env("VERCEL_TOKEN_STORAGE"),
    path: yield* env("PATH"),
  } satisfies LocalEnvironment;
});

export const unavailable = (message: string, cause?: unknown) =>
  new OidcTokenUnavailable(cause === undefined ? { message } : { message, cause });

export const fileFailure = (what: string) => (error: PlatformError.PlatformError) =>
  unavailable(`${what}: ${error.message}`, error);

export const isNotFound = (error: PlatformError.PlatformError) =>
  Predicate.isTagged(error.reason, "NotFound");

const xdgDataHome = (env: LocalEnvironment, path: Path.Path): Option.Option<string> => {
  if (Option.isSome(env.xdgDataHome)) {
    return env.xdgDataHome;
  }
  if (env.platform === "darwin") {
    return Option.map(env.home, (home) => path.join(home, "Library", "Application Support"));
  }
  if (env.platform.startsWith("win")) {
    return Option.orElse(env.appData, () =>
      Option.map(env.home, (home) => path.join(home, "AppData", "Roaming")),
    ).pipe(Option.map((appData) => path.join(appData, "xdg.data")));
  }
  return Option.map(env.home, (home) => path.join(home, ".local", "share"));
};

const dataDirectories = (env: LocalEnvironment, path: Path.Path, appName: string) => {
  const delimiter = env.platform.startsWith("win") ? ";" : ":";
  const extra = Option.match(env.xdgDataDirs, {
    onNone: () => [],
    onSome: (dirs) => dirs.split(delimiter),
  });
  return [...Option.toArray(xdgDataHome(env, path)), ...extra].map((dir) =>
    path.join(dir, appName),
  );
};

export const userDataDirectory = (
  env: LocalEnvironment,
  path: Path.Path,
): Option.Option<string> => {
  if (Option.isSome(env.xdgDataHome)) {
    return env.xdgDataHome;
  }
  switch (env.platform) {
    case "darwin":
      return Option.map(env.home, (home) => path.join(home, "Library", "Application Support"));
    case "linux":
      return Option.map(env.home, (home) => path.join(home, ".local", "share"));
    case "win32":
      return env.localAppData;
    default:
      return Option.none();
  }
};

export const globalConfigDirectory = Effect.fnUntraced(function* (env: LocalEnvironment) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const vercelDirectories = dataDirectories(env, path, "com.vercel.cli");
  const candidates = [
    ...vercelDirectories,
    ...Option.toArray(Option.map(env.home, (home) => path.join(home, ".now"))),
    ...dataDirectories(env, path, "now"),
  ];
  for (const candidate of candidates) {
    const isDirectory = yield* fs.stat(candidate).pipe(
      Effect.map((info) => info.type === "Directory"),
      Effect.orElseSucceed(() => false),
    );
    if (isDirectory) {
      return candidate;
    }
  }
  const fallback = vercelDirectories[0];
  if (fallback === undefined) {
    return yield* unavailable(
      "Unable to find the Vercel CLI data directory: set HOME or XDG_DATA_HOME.",
    );
  }
  return fallback;
});

const stripBom = (text: string) => text.replace(/^﻿/, "");

export const AuthConfig = Schema.Struct({
  token: Schema.optionalKey(Schema.String),
  refreshToken: Schema.optionalKey(Schema.String),
  expiresAt: Schema.optionalKey(Schema.Finite),
});

export type AuthConfig = typeof AuthConfig.Type;

const decodeAuthConfig = Schema.decodeUnknownOption(Schema.fromJsonString(AuthConfig));

export const readAuthConfig = Effect.fnUntraced(function* (configDir: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  return yield* fs.readFileString(path.join(configDir, "auth.json")).pipe(
    Effect.map((text) => decodeAuthConfig(stripBom(text))),
    Effect.orElseSucceed(() => Option.none<AuthConfig>()),
  );
});

export const writeAuthConfig = Effect.fnUntraced(
  function* (configDir: string, config: AuthConfig) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const target = path.join(configDir, "auth.json");
    const suffix = `${yield* Clock.currentTimeMillis}.${yield* Random.nextInt}`;
    const temp = path.join(configDir, `.auth.json.${suffix}.tmp`);
    yield* fs.makeDirectory(configDir, { recursive: true });
    yield* fs.writeFileString(temp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 }).pipe(
      Effect.andThen(fs.rename(temp, target)),
      Effect.tapError(() => Effect.ignore(fs.remove(temp, { force: true }))),
    );
  },
  Effect.mapError(fileFailure("Failed to write the Vercel CLI auth file")),
);

const credStorageValues = ["auto", "file", "keyring"] as const;

type CredStorage = (typeof credStorageValues)[number];

const isCredStorage = (value: unknown): value is CredStorage =>
  Predicate.isString(value) && credStorageValues.some((storage) => storage === value);

const invalidCredStorage = (value: unknown, source: string) =>
  unavailable(
    `Invalid value for \`${source}\`: ${JSON.stringify(value)}. Expected one of: ${credStorageValues
      .map((storage) => JSON.stringify(storage))
      .join(", ")}.`,
  );

const GlobalConfig = Schema.fromJsonString(
  Schema.Struct({ credStorage: Schema.optionalKey(Schema.Unknown) }),
);

const readConfiguredCredStorage = Effect.fnUntraced(function* (configDir: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const text = yield* fs.readFileString(path.join(configDir, "config.json")).pipe(
    Effect.map(Option.some),
    Effect.catchIf(isNotFound, () => Effect.succeedNone),
    Effect.mapError(fileFailure("Failed to read the Vercel CLI config file")),
  );
  if (Option.isNone(text)) {
    return Option.none<CredStorage>();
  }
  const config = yield* Schema.decodeUnknownEffect(GlobalConfig)(stripBom(text.value)).pipe(
    Effect.mapError((error) =>
      unavailable(`Invalid Vercel CLI config file: ${error.message}`, error),
    ),
  );
  if (config.credStorage === undefined) {
    return Option.none<CredStorage>();
  }
  if (!isCredStorage(config.credStorage)) {
    return yield* invalidCredStorage(config.credStorage, "credStorage");
  }
  return Option.some(config.credStorage);
});

/** Whether the CLI most likely keeps its credentials in auth.json (`file`) or the OS keyring. */
export const likelyCredentialStorage = Effect.fnUntraced(function* (
  configDir: string,
  env: LocalEnvironment,
) {
  let configured: Option.Option<CredStorage>;
  if (Option.isSome(env.tokenStorage)) {
    if (!isCredStorage(env.tokenStorage.value)) {
      return yield* invalidCredStorage(env.tokenStorage.value, "VERCEL_TOKEN_STORAGE");
    }
    configured = Option.some(env.tokenStorage.value);
  } else {
    configured = yield* readConfiguredCredStorage(configDir);
  }
  if (Option.contains(configured, "keyring")) {
    return "keyring";
  }
  if (!Option.contains(configured, "auto")) {
    return "file";
  }
  const auth = yield* readAuthConfig(configDir);
  const usable = Option.exists(
    auth,
    (auth) => (auth.token ?? "").length > 0 || (auth.refreshToken ?? "").length > 0,
  );
  return usable ? "file" : "keyring";
});
