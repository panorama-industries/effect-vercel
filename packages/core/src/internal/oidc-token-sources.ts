import type { ConfigProvider } from "effect";

import { Config, Effect, Option, Predicate } from "effect";

const requestContextKey = Symbol.for("@vercel/request-context");

export const requestOidcToken = (): Option.Option<string> => {
  const store: unknown = Reflect.get(globalThis, requestContextKey);
  if (!Predicate.hasProperty(store, "get") || !Predicate.isFunction(store.get)) {
    return Option.none();
  }
  const context: unknown = store.get();
  if (!Predicate.hasProperty(context, "headers") || !Predicate.isObject(context.headers)) {
    return Option.none();
  }
  const value: unknown = Reflect.get(context.headers, "x-vercel-oidc-token");
  return Predicate.isString(value) && value.length > 0 ? Option.some(value) : Option.none();
};

export const optionalEnv = (provider: ConfigProvider.ConfigProvider, name: string) =>
  Config.option(Config.String(name))
    .parse(provider)
    .pipe(
      Effect.map(Option.filter((value) => value.length > 0)),
      Effect.orElseSucceed(() => Option.none<string>()),
    );

export const missingTokenMessage =
  "No Vercel OIDC token: the request has no `x-vercel-oidc-token` header and `VERCEL_OIDC_TOKEN` is not set. " +
  "On Vercel, enable OIDC for the project; locally, run `vercel env pull` or use VercelOidcRefreshingLive.";
