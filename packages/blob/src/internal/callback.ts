import type { VercelSystemEnv } from "@panorama-industries/effect-vercel-core";

import { Effect, Option, Result } from "effect";
import { Base64, Hex } from "effect/encoding";

/*
 * Upload-completed callbacks, as the SDK's `client.ts` handles them: where the store sends them
 * (`getCallbackUrl`) and how their `x-vercel-signature` is verified.
 */

/** Header that carries the signature of an upload-completed callback. */
export const callbackSignatureHeader = "x-vercel-signature";

/** The SDK's warning when an upload route has `onUploadCompleted` but no callback URL. */
export const callbackUrlUndeterminedWarning =
  "onUploadCompleted provided but no callbackUrl could be determined. Please provide a callbackUrl in onBeforeGenerateToken or set the VERCEL_BLOB_CALLBACK_URL environment variable.";

/** The SDK's warning when an upload route returns a callback URL but has no `onUploadCompleted`. */
export const callbackUrlUnhandledWarning =
  "callbackUrl was provided but onUploadCompleted is not defined. The callback will not be handled.";

/**
 * Path and query of a request URL, absolute or relative, as the SDK's `getPathFromRequestUrl`.
 *
 * @returns None when the URL cannot be parsed.
 */
export const requestPath = (url: string): Option.Option<string> => {
  const base = "https://dummy.com";
  if (!URL.canParse(url, base)) {
    return Option.none();
  }
  const parsed = new URL(url, base);
  return Option.some(parsed.pathname + parsed.search);
};

/**
 * Where the store should send the upload-completed callback of this route when the route gave no
 * URL, as the SDK's `getCallbackUrl`, in order: `callbackBaseUrl` (`VERCEL_BLOB_CALLBACK_URL`) plus
 * the request's path and query; on Vercel, the branch URL, else the deployment URL, of a preview, or
 * the production URL of production. Logs the SDK's warning when the request URL cannot be parsed or
 * the code runs neither with a callback base URL nor on Vercel.
 *
 * @param requestUrl - The request's original URL, absolute or a path.
 */
export const deriveCallbackUrl = Effect.fnUntraced(function* (args: {
  readonly requestUrl: string;
  readonly callbackBaseUrl: Option.Option<string>;
  readonly env: VercelSystemEnv["Service"];
}) {
  const path = requestPath(args.requestUrl);
  if (Option.isNone(path)) {
    yield* Effect.logWarning(callbackUrlUndeterminedWarning);
    return Option.none<string>();
  }
  if (Option.isSome(args.callbackBaseUrl)) {
    return Option.some(`${args.callbackBaseUrl.value}${path.value}`);
  }
  const { env } = args;
  if (!env.isVercel) {
    yield* Effect.logWarning(callbackUrlUndeterminedWarning);
    return Option.none<string>();
  }
  const onHost = (host: string) => `https://${host}${path.value}`;
  if (Option.contains(env.target, "preview")) {
    const previewHost = Option.orElse(env.branchUrl, () => env.url);
    if (Option.isSome(previewHost)) {
      return Option.some(onHost(previewHost.value));
    }
  }
  if (Option.contains(env.target, "production")) {
    return Option.map(env.projectProductionUrl, onHost);
  }
  return Option.none<string>();
});

/**
 * The callback URL to sign into an upload, as `handleUpload` and `handleUploadPresigned` choose it:
 * the route's URL, else (with `onUploadCompleted`) the derived one. Without `onUploadCompleted`, a
 * route URL is kept and the SDK's warning logged, since nothing will handle the callback.
 *
 * @param derive - {@link deriveCallbackUrl} for this request; run only when needed.
 */
export const resolveCallbackUrl = Effect.fnUntraced(function* <E, R>(args: {
  readonly provided: string | undefined;
  readonly handlesCallback: boolean;
  readonly derive: Effect.Effect<Option.Option<string>, E, R>;
}) {
  let callbackUrl = Option.filter(Option.fromUndefinedOr(args.provided), (url) => url !== "");
  if (args.handlesCallback && Option.isNone(callbackUrl)) {
    callbackUrl = yield* args.derive;
  }
  if (!args.handlesCallback && Option.isSome(callbackUrl)) {
    yield* Effect.logWarning(callbackUrlUnhandledWarning);
  }
  return callbackUrl;
});

/**
 * The text a callback signature covers: the body re-serialized as `JSON.stringify(JSON.parse(body))`,
 * as the SDK signs the parsed body.
 *
 * @returns None when the body is not JSON.
 */
export const parseCallbackBody = (
  body: string,
): Option.Option<{ readonly json: unknown; readonly normalized: string }> => {
  try {
    const json: unknown = JSON.parse(body);
    return Option.some({ json, normalized: JSON.stringify(json) });
  } catch {
    return Option.none();
  }
};

const utf8 = new TextEncoder();

/**
 * Whether `signatureHex` is the HMAC-SHA256 (hex) of `body` keyed by the store's read-write token,
 * as `handleUpload` verifies `x-vercel-signature`. Compared in constant time by Web Crypto `verify`;
 * a signature that is not hex never verifies.
 */
export const verifyHmacCallbackSignature = Effect.fnUntraced(function* (
  readWriteToken: string,
  signatureHex: string,
  body: string,
) {
  const signature = Result.getSuccess(Hex.decode(signatureHex));
  if (Option.isNone(signature)) {
    return false;
  }
  const key = yield* Effect.promise(() =>
    globalThis.crypto.subtle.importKey(
      "raw",
      utf8.encode(readWriteToken),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["verify"],
    ),
  );
  return yield* Effect.promise(() =>
    globalThis.crypto.subtle.verify(
      "HMAC",
      key,
      Uint8Array.from(signature.value),
      utf8.encode(body),
    ),
  );
});

/**
 * DER bytes of a PEM `-----BEGIN PUBLIC KEY-----` (SPKI) block, as the SDK's
 * `publicKeyDerFromPem`.
 *
 * @returns None when there is no such block or its content is not base64.
 */
export const publicKeyDerFromPem = (pem: string): Option.Option<Uint8Array> => {
  const match = /-----BEGIN PUBLIC KEY-----([^-]*)-----END PUBLIC KEY-----/s.exec(pem.trim());
  const base64 = match?.[1]?.replace(/\s+/g, "");
  if (!base64) {
    return Option.none();
  }
  return Result.getSuccess(Base64.decode(base64));
};

const ed25519SignatureHex = /^[0-9a-fA-F]{128}$/;

/**
 * Whether `signatureHex` is an Ed25519 signature of `body` by the key in `publicKeyPem` (SPKI PEM,
 * `BLOB_WEBHOOK_PUBLIC_KEY`), as `handleUploadPresigned` verifies `x-vercel-signature`. The
 * signature must be 128 hex characters; a key that cannot be imported never verifies.
 */
export const verifyEd25519CallbackSignature = Effect.fnUntraced(function* (
  publicKeyPem: string,
  signatureHex: string,
  body: string,
) {
  if (!ed25519SignatureHex.test(signatureHex)) {
    return false;
  }
  const der = publicKeyDerFromPem(publicKeyPem);
  const signature = Result.getSuccess(Hex.decode(signatureHex));
  if (Option.isNone(der) || Option.isNone(signature)) {
    return false;
  }
  return yield* Effect.tryPromise(async () => {
    const key = await globalThis.crypto.subtle.importKey(
      "spki",
      Uint8Array.from(der.value),
      { name: "Ed25519" },
      false,
      ["verify"],
    );
    return globalThis.crypto.subtle.verify(
      "Ed25519",
      key,
      Uint8Array.from(signature.value),
      utf8.encode(body),
    );
  }).pipe(Effect.orElseSucceed(() => false));
});
