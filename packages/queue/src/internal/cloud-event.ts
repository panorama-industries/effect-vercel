import type { Headers } from "effect/http";

import { VercelRegion } from "@panorama-industries/effect-vercel-core";
import { DateTime, Duration, Effect, Option, Predicate, Schema } from "effect";

import type { LeaseDeadline } from "./lease.ts";

import {
  ConsumerGroupName,
  MessageHandle,
  MessageId,
  MessageMetadata,
  ReceiptHandle,
  ReceivedMessage,
  TopicName,
} from "../contracts/queue-domain.ts";

export const CLOUD_EVENT_TYPE_V1BETA = "com.vercel.queue.v1beta";
export const CLOUD_EVENT_TYPE_V2BETA = "com.vercel.queue.v2beta";

const REGION_HEADER_PATTERN = /^[a-z]{2,5}[0-9]{1,2}$/;
const DEFAULT_RETENTION = Duration.hours(24);

/** A push delivery the queue could not have sent: answered with HTTP 400. */
export class MalformedCloudEvent extends Schema.TaggedError<MalformedCloudEvent>()(
  "MalformedCloudEvent",
  { message: Schema.String },
) {}

export interface CallbackRoute {
  readonly topic: TopicName;
  readonly consumerGroup: ConsumerGroupName;
  readonly messageId: MessageId;
  readonly region: Option.Option<VercelRegion>;
}

/** Binary-mode delivery whose lease and payload arrived with the request. */
export interface InlineLease {
  readonly receiptHandle: ReceiptHandle;
  readonly deliveryCount: Option.Option<string>;
  readonly createdAt: Option.Option<string>;
  readonly expiresAt: Option.Option<string>;
  readonly contentType: Option.Option<string>;
  readonly visibilityDeadline: Option.Option<string>;
  readonly handoffCount: Option.Option<number>;
}

export interface ParsedCallback extends CallbackRoute {
  readonly inline: Option.Option<InlineLease>;
}

const malformed = (message: string) => Effect.fail(new MalformedCloudEvent({ message }));

const header = (headers: Headers.Headers, name: string): Option.Option<string> =>
  Option.fromNullishOr(headers[name]);

const nonEmptyHeader = (headers: Headers.Headers, name: string): Option.Option<string> =>
  Option.filter(header(headers, name), (value) => value.length > 0);

/** Reads `Vqs-Experimental-Handoff-Count`-style values: only positive integers count. */
export const parseHandoffCount = (value: Option.Option<string>): Option.Option<number> =>
  Option.flatMap(value, (raw) => {
    if (raw.length === 0) return Option.none();
    const count = Number(raw);
    return Number.isInteger(count) && count > 0 ? Option.some(count) : Option.none();
  });

const brand = <S extends Schema.Top & Schema.Decoder<unknown>>(
  schema: S,
  field: string,
  value: string,
) =>
  Schema.decodeUnknownEffect(schema)(value).pipe(
    Effect.catch(() =>
      malformed(`Invalid CloudEvent: ${field} ${JSON.stringify(value)} is not valid`),
    ),
  );

const route = Effect.fnUntraced(function* (
  topic: string,
  consumerGroup: string,
  messageId: string,
  region: Option.Option<VercelRegion>,
) {
  return {
    topic: yield* brand(TopicName, "queueName", topic),
    consumerGroup: yield* brand(ConsumerGroupName, "consumerGroup", consumerGroup),
    messageId: yield* brand(MessageId, "messageId", messageId),
    region,
  } satisfies CallbackRoute;
});

const parseStructured = Effect.fnUntraced(function* (
  body: unknown,
  contentType: Option.Option<string>,
) {
  if (Option.isNone(contentType) || !contentType.value.includes("application/cloudevents+json")) {
    return yield* malformed("Invalid content type: expected 'application/cloudevents+json'");
  }
  const event = Predicate.isObjectOrArray(body) ? (body as Record<string, unknown>) : undefined;
  const data = Predicate.isObjectOrArray(event?.["data"])
    ? (event["data"] as Record<string, unknown>)
    : undefined;
  if (event === undefined || !event["type"] || !event["source"] || !event["id"] || !data) {
    return yield* malformed("Invalid CloudEvent: missing required fields");
  }
  if (event["type"] !== CLOUD_EVENT_TYPE_V1BETA) {
    return yield* malformed(
      // oxlint-disable-next-line typescript/no-base-to-string -- matches @vercel/queue's message
      `Invalid CloudEvent type: expected '${CLOUD_EVENT_TYPE_V1BETA}', got '${String(event["type"])}'`,
    );
  }
  const missing = ["queueName", "consumerGroup", "messageId"].filter((field) => !(field in data));
  if (missing.length > 0) {
    return yield* malformed(`Missing required CloudEvent data fields: ${missing.join(", ")}`);
  }
  const parsed = yield* route(
    String(data["queueName"]),
    String(data["consumerGroup"]),
    String(data["messageId"]),
    Option.none(),
  );
  return { ...parsed, inline: Option.none() } satisfies ParsedCallback;
});

const parseBinary = Effect.fnUntraced(function* (headers: Headers.Headers) {
  const queueName = nonEmptyHeader(headers, "ce-vqsqueuename");
  const consumerGroup = nonEmptyHeader(headers, "ce-vqsconsumergroup");
  const messageId = nonEmptyHeader(headers, "ce-vqsmessageid");
  if (Option.isNone(queueName) || Option.isNone(consumerGroup) || Option.isNone(messageId)) {
    const missing = [
      Option.isNone(queueName) ? ["ce-vqsqueuename"] : [],
      Option.isNone(consumerGroup) ? ["ce-vqsconsumergroup"] : [],
      Option.isNone(messageId) ? ["ce-vqsmessageid"] : [],
    ].flat();
    return yield* malformed(`Missing required CloudEvent headers: ${missing.join(", ")}`);
  }

  const rawRegion = header(headers, "ce-vqsregion");
  let region = Option.none<VercelRegion>();
  if (Option.isSome(rawRegion)) {
    const decoded = REGION_HEADER_PATTERN.test(rawRegion.value)
      ? Schema.decodeUnknownOption(VercelRegion)(rawRegion.value)
      : Option.none();
    if (Option.isNone(decoded)) {
      return yield* malformed(
        `Invalid ce-vqsregion header: ${JSON.stringify(rawRegion.value)}. ` +
          `Region must match /^[a-z]{2,5}[0-9]{1,2}$/ (e.g. "iad1", "lhr1").`,
      );
    }
    region = decoded;
  }

  const base = yield* route(queueName.value, consumerGroup.value, messageId.value, region);
  const receiptHandle = nonEmptyHeader(headers, "ce-vqsreceipthandle");
  if (Option.isNone(receiptHandle)) {
    return { ...base, inline: Option.none() } satisfies ParsedCallback;
  }

  const inline: InlineLease = {
    receiptHandle: yield* brand(ReceiptHandle, "receiptHandle", receiptHandle.value),
    deliveryCount: nonEmptyHeader(headers, "ce-vqsdeliverycount"),
    createdAt: nonEmptyHeader(headers, "ce-vqscreatedat"),
    expiresAt: nonEmptyHeader(headers, "ce-vqsexpiresat"),
    contentType: nonEmptyHeader(headers, "content-type"),
    visibilityDeadline: nonEmptyHeader(headers, "ce-vqsvisibilitydeadline"),
    handoffCount: parseHandoffCount(header(headers, "ce-vqsexperimentalhandoffcount")),
  };
  return { ...base, inline: Option.some(inline) } satisfies ParsedCallback;
});

const UnknownFromJson = Schema.fromJsonString(Schema.Unknown);

/**
 * Parses a push delivery like `@vercel/queue`'s `parseCallback`: binary mode
 * (`com.vercel.queue.v2beta`, metadata in `ce-*` headers) or structured mode (JSON CloudEvent).
 */
export const parseCallback = (
  headers: Headers.Headers,
  text: Effect.Effect<string, unknown>,
): Effect.Effect<ParsedCallback, MalformedCloudEvent> => {
  if (headers["ce-type"] === CLOUD_EVENT_TYPE_V2BETA) return parseBinary(headers);
  return text.pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(UnknownFromJson)),
    Effect.catch(() => malformed("Failed to parse CloudEvent from request body")),
    Effect.flatMap((body) => parseStructured(body, header(headers, "content-type"))),
  );
};

const parseDate = (value: Option.Option<string>): Option.Option<DateTime.Utc> =>
  Option.flatMap(value, (raw) => DateTime.make(raw)).pipe(Option.map(DateTime.toUtc));

/** Builds the leased message a binary-mode delivery carries inline. */
export const inlineDelivery = Effect.fnUntraced(function* (
  parsed: CallbackRoute,
  inline: InlineLease,
  region: VercelRegion,
  defaultContentType: string,
  body: Uint8Array,
) {
  const now = yield* DateTime.now;
  const createdAt = Option.getOrElse(parseDate(inline.createdAt), () => now);
  const deliveryCount = Option.getOrElse(
    Option.filter(
      Option.map(inline.deliveryCount, (raw) => Number.parseInt(raw, 10)),
      (count) => !Number.isNaN(count),
    ),
    () => 1,
  );
  const handle = new MessageHandle({
    topic: parsed.topic,
    consumerGroup: parsed.consumerGroup,
    messageId: parsed.messageId,
    receiptHandle: inline.receiptHandle,
    region,
  });
  const metadata = new MessageMetadata({
    messageId: parsed.messageId,
    deliveryCount,
    createdAt,
    expiresAt: Option.getOrElse(parseDate(inline.expiresAt), () =>
      DateTime.addDuration(createdAt, DEFAULT_RETENTION),
    ),
    topic: parsed.topic,
    consumerGroup: parsed.consumerGroup,
    region,
    ...Option.match(inline.handoffCount, {
      onNone: () => ({}),
      onSome: (experimentalHandoffCount) => ({ experimentalHandoffCount }),
    }),
  });
  const deadline: LeaseDeadline = Option.map(inline.visibilityDeadline, (raw) =>
    Option.getOrElse(parseDate(Option.some(raw)), () => "expired" as const),
  );
  return {
    message: new ReceivedMessage({
      handle,
      metadata,
      contentType: Option.getOrElse(inline.contentType, () => defaultContentType),
      body,
    }),
    deadline,
  };
});
