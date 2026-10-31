import type { BlobAccess, StoreId } from "../contracts/blob-domain.ts";

/** The production Blob API, used unless `VERCEL_BLOB_API_URL` or an option overrides it. */
export const defaultApiUrl = "https://vercel.com/api/blob";

/** Where a store serves its blobs: `https://<storeId>.<access>.blob.vercel-storage.com/`. */
export const defaultBlobBaseUrl = (storeId: StoreId, access: BlobAccess): URL =>
  new URL(`https://${storeId}.${access}.blob.vercel-storage.com/`);

/**
 * The URL of the blob at `pathname` under a store's base URL (`BlobConfig.blobBaseUrl`), as the
 * SDK's `constructBlobUrl`: the pathname is appended as is, so URL syntax in it (`?`, `#`) keeps its
 * URL meaning exactly as with the SDK.
 */
export const blobUrl = (baseUrl: URL, pathname: string): URL => {
  const base = baseUrl.href.endsWith("/") ? baseUrl.href : `${baseUrl.href}/`;
  return new URL(`${base}${pathname}`);
};

/** True for strings the SDK treats as URLs rather than pathnames (`http://` or `https://`). */
export const isUrl = (urlOrPathname: string): boolean =>
  urlOrPathname.startsWith("http://") || urlOrPathname.startsWith("https://");

/**
 * Whether `get` may send credentials to `url`: hosts under `.blob.vercel-storage.com`, and, when
 * the API URL is overridden (an emulator or a test server), that API URL's origin.
 *
 * @param apiUrl - The configured API URL; the production default allows no extra origin.
 */
export const isAllowedBlobUrl = (url: URL, apiUrl: URL): boolean =>
  url.hostname.endsWith(".blob.vercel-storage.com") ||
  (apiUrl.href !== new URL(defaultApiUrl).href && apiUrl.origin === url.origin);

/**
 * The URL that makes browsers download a blob instead of displaying it: the blob URL with
 * `download=1` in its query.
 */
export const downloadUrl = (url: URL | string): URL => {
  const result = new URL(url);
  result.searchParams.set("download", "1");
  return result;
};
