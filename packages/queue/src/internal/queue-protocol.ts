import { DateTime, Duration, Option, Predicate, Schema } from "effect";

import type { OutgoingMessage } from "../contracts/queue-api.ts";

export const errorCodeHeader = "Vqs-Error-Code";

export const apiBaseUrl = (url: URL): string =>
  `${url.origin}${url.pathname.replace(/\/+$/, "")}/api/v3/topic`;

export const topicPath = (topic: string, ...segments: ReadonlyArray<string>): string =>
  [topic, ...segments].map((segment) => `/${encodeURIComponent(segment)}`).join("");

export const wholeSeconds = (input: Duration.Input): number =>
  Math.ceil(Duration.toMillis(Duration.fromInputUnsafe(input)) / 1000);

const trimHeaderValue = (value: string) => value.replace(/^[\t\n\r ]+|[\t\n\r ]+$/g, "");

/** A case-insensitive header set with the same overwrite semantics as `Headers.set`. */
export class HeaderSet {
  private readonly entries = new Map<string, string>();

  constructor(init: Readonly<Record<string, string>> = {}) {
    for (const [name, value] of Object.entries(init)) this.set(name, value);
  }

  set(name: string, value: string): this {
    this.entries.set(name.toLowerCase(), trimHeaderValue(value));
    return this;
  }

  delete(name: string): this {
    this.entries.delete(name.toLowerCase());
    return this;
  }

  get(name: string): string | undefined {
    return this.entries.get(name.toLowerCase());
  }

  toRecord(): Record<string, string> {
    return Object.fromEntries(this.entries);
  }

  /** Entries sorted by name, as `Headers` iterates them. */
  sorted(): Array<readonly [string, string]> {
    return [...this.entries].toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  }
}

const isReservedMessageHeader = (name: string) => {
  const lower = name.toLowerCase();
  return lower === "authorization" || lower === "content-type" || lower.startsWith("vqs-");
};

export const messageHeaders = (
  custom: Readonly<Record<string, string>>,
  message: OutgoingMessage,
): HeaderSet => {
  const headers = new HeaderSet(custom).delete("authorization");
  for (const [name, value] of Object.entries(message.headers ?? {})) {
    if (!isReservedMessageHeader(name)) headers.set(name, value);
  }
  headers.set("content-type", message.contentType);
  if (message.idempotencyKey) headers.set("vqs-idempotency-key", message.idempotencyKey);
  if (message.retention !== undefined) {
    headers.set("vqs-retention-seconds", String(wholeSeconds(message.retention)));
  }
  if (message.delay !== undefined) {
    headers.set("vqs-delay-seconds", String(wholeSeconds(message.delay)));
  }
  if (message.experimentalConcurrencyKey) {
    headers.set("vqs-experimental-concurrency-key", message.experimentalConcurrencyKey);
  }
  return headers;
};

export const retryAfterFromHeader = (
  value: string | undefined,
  nowMillis: number,
): Option.Option<Duration.Duration> => {
  if (!value) return Option.none();
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Option.some(Duration.seconds(seconds));
  const dateMillis = Date.parse(value);
  return Number.isNaN(dateMillis)
    ? Option.none()
    : Option.some(Duration.millis(Math.max(0, dateMillis - nowMillis)));
};

export interface ErrorBody {
  readonly text: string;
  readonly message: string;
  readonly originalMessageId: Option.Option<string>;
}

const decodeJsonObject = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
);

export const errorBodyOf = (text: string, contentType: string | undefined): ErrorBody => {
  const plain: ErrorBody = { text, message: text, originalMessageId: Option.none() };
  if (!contentType?.toLowerCase().includes("json")) return plain;
  return Option.match(decodeJsonObject(text), {
    onNone: () => plain,
    onSome: (body) => {
      const error = body["error"];
      const message = Predicate.isString(error)
        ? error
        : Predicate.isObject(error) && Predicate.isString(error["message"])
          ? error["message"]
          : text;
      const original = body["originalMessageId"];
      return {
        text,
        message,
        originalMessageId: Predicate.isString(original) ? Option.some(original) : Option.none(),
      };
    },
  });
};

const positiveInt = (value: unknown): Option.Option<number> =>
  Predicate.isNumber(value) && Number.isInteger(value) && value > 0
    ? Option.some(value)
    : Option.none();

export const coalescedPendingCount = (
  errorCode: string | undefined,
  coalescedHeader: string | undefined,
  text: string,
): Option.Option<number> => {
  if (errorCode !== "concurrency_coalesced_pending") return Option.none();
  return Option.orElse(positiveInt(Number(coalescedHeader ?? null)), () =>
    Option.flatMap(decodeJsonObject(text), (body) => positiveInt(body["coalescedCount"])),
  );
};

export interface QueuePartHeaders {
  readonly messageId: string;
  readonly receiptHandle: string;
  readonly deliveryCount: number;
  readonly timestamp: string;
  readonly expiresAt: Option.Option<string>;
  readonly contentType: string;
  readonly handoffCount: Option.Option<number>;
}

export const queuePartHeaders = (
  headers: Readonly<Record<string, string>>,
): Option.Option<QueuePartHeaders> => {
  const messageId = headers["vqs-message-id"];
  const timestamp = headers["vqs-timestamp"];
  const receiptHandle = headers["vqs-receipt-handle"];
  if (!messageId || !timestamp || !receiptHandle) return Option.none();
  const deliveryCount = Number.parseInt(headers["vqs-delivery-count"] || "0", 10);
  if (Number.isNaN(deliveryCount)) return Option.none();
  return Option.some({
    messageId,
    receiptHandle,
    deliveryCount,
    timestamp,
    expiresAt: Option.fromUndefinedOr(headers["vqs-expires-at"] || undefined),
    contentType: headers["content-type"] || "application/octet-stream",
    handoffCount: positiveInt(Number(headers["vqs-experimental-handoff-count"] || Number.NaN)),
  });
};

export const parseDate = (value: string): Option.Option<DateTime.Utc> =>
  DateTime.make(new Date(value));
