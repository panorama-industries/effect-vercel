import type { Option, Redacted } from "effect";

import { Context, Data } from "effect";

import type { BlobAccess, StoreId } from "./blob-domain.ts";

/** How server-side calls authenticate to the Blob API. */
export type BlobAuth = Data.TaggedEnum<{
  /**
   * Use the Vercel OIDC token of the current request with the store's id. When no OIDC token is
   * available and `BlobConfig.readWriteToken` is set, a request falls back to that token, as the
   * SDK does.
   */
  Oidc: { readonly storeId: StoreId };
  /** Use a store's read-write token (`vercel_blob_rw_<storeId>_…`). */
  ReadWrite: { readonly token: Redacted.Redacted<string>; readonly storeId: StoreId };
}>;

/** Constructors and matchers for {@link BlobAuth}. */
export const BlobAuth = Data.taggedEnum<BlobAuth>();

/** Where and as whom the server-side Blob client talks to Vercel Blob. */
export class BlobConfig extends Context.Service<
  BlobConfig,
  {
    /** Blob API base URL, `https://vercel.com/api/blob` unless overridden for an emulator. */
    readonly apiUrl: URL;

    readonly auth: BlobAuth;

    /**
     * The store's read-write token, when one is configured. Besides the OIDC fallback, it signs
     * client tokens and verifies upload-completed callbacks, which OIDC cannot do.
     */
    readonly readWriteToken: Option.Option<Redacted.Redacted<string>>;

    /** Sent as `x-api-version`; selects the server's response format. */
    readonly apiVersion: string;

    /** Retries after the first attempt for network failures and retryable server errors. */
    readonly retries: number;

    /** Send `x-content-length` with every body, which local development servers need for streams. */
    readonly sendContentLength: boolean;

    /** Extra headers sent with every API request. */
    readonly headers: Readonly<Record<string, string>>;

    /**
     * Origin and path under which a store serves its blobs; `get` appends the pathname. Defaults to
     * `https://<storeId>.<access>.blob.vercel-storage.com/`.
     */
    readonly blobBaseUrl: (storeId: StoreId, access: BlobAccess) => URL;

    /** Ed25519 public key (PEM) that verifies presigned-upload callbacks. */
    readonly webhookPublicKey: Option.Option<string>;

    /**
     * Origin that upload-completed callbacks are sent to, such as a tunnel in local development
     * (`VERCEL_BLOB_CALLBACK_URL`); the upload route's path is appended.
     */
    readonly callbackBaseUrl: Option.Option<string>;
  }
>()("@effect-vercel/blob/BlobConfig") {}
