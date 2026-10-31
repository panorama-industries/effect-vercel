import { Schema, SchemaGetter } from "effect";

import {
  BlobMetadata,
  CreateFolderResult,
  ListPage,
  PutBlobResult,
} from "../contracts/blob-domain.ts";

/*
 * JSON bodies of Blob API responses, decoded into the contract classes. Unknown fields are ignored
 * so newer API versions keep decoding. Pass these as `response` to `BlobRequester.call`.
 */

/** `PUT /`, `PUT ?pathname&fromUrl` (copy), rename, put-image and multipart `complete`. */
export const PutBlobResponse = Schema.Struct({
  url: Schema.URLFromString,
  downloadUrl: Schema.URLFromString,
  pathname: Schema.String,
  contentType: Schema.String,
  contentDisposition: Schema.String,
  etag: Schema.String,
}).pipe(Schema.decodeTo(PutBlobResult));

/** `PUT /?pathname=<folder>/`: only `url` and `pathname` are kept, as the SDK does. */
export const CreateFolderResponse = Schema.Struct({
  url: Schema.URLFromString,
  pathname: Schema.String,
}).pipe(Schema.decodeTo(CreateFolderResult));

/** `GET ?url=…` (head). `uploadedAt` is an ISO 8601 string. */
export const HeadBlobResponse = Schema.Struct({
  url: Schema.URLFromString,
  downloadUrl: Schema.URLFromString,
  pathname: Schema.String,
  size: Schema.Int,
  uploadedAt: Schema.DateTimeUtcFromString,
  contentType: Schema.String,
  contentDisposition: Schema.String,
  cacheControl: Schema.String,
  etag: Schema.String,
}).pipe(Schema.decodeTo(BlobMetadata));

const ListedBlobWire = Schema.Struct({
  url: Schema.URLFromString,
  downloadUrl: Schema.URLFromString,
  pathname: Schema.String,
  size: Schema.Int,
  uploadedAt: Schema.DateTimeUtcFromString,
  etag: Schema.String,
});

const ListWire = Schema.Struct({
  blobs: Schema.Array(ListedBlobWire),
  folders: Schema.optionalKey(Schema.Array(Schema.String)),
  cursor: Schema.OptionFromOptionalNullOr(Schema.String),
  hasMore: Schema.Boolean,
});

/**
 * `GET ?limit&prefix&cursor&mode` (list). `folders` is only sent for `mode=folded`; it decodes to
 * an empty array otherwise.
 */
export const ListResponse = ListWire.pipe(
  Schema.decodeTo(ListPage, {
    decode: SchemaGetter.transform(({ folders, ...page }) => ({ ...page, folders: folders ?? [] })),
    encode: SchemaGetter.transform((page) => page),
  }),
);

/** `POST /mpu` with `x-mpu-action: create`. */
export const CreateMultipartUploadResponse = Schema.Struct({
  uploadId: Schema.String,
  key: Schema.String,
});

/** `POST /mpu` with `x-mpu-action: upload`. */
export const UploadPartResponse = Schema.Struct({
  etag: Schema.String,
});
