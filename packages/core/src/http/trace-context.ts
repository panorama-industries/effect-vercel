import type { Tracer } from "effect";

import { Effect, Option } from "effect";
import { Headers, HttpTraceContext } from "effect/http";

/**
 * Build a span link from a W3C `traceparent` value, such as one carried in a message header.
 *
 * @returns `Option.none()` when the value is not a valid version `00` traceparent.
 */
export const spanLinkFromTraceparent = (
  traceparent: string,
  attributes: Readonly<Record<string, unknown>> = {},
): Option.Option<Tracer.SpanLink> =>
  Option.map(HttpTraceContext.w3c(Headers.fromRecordUnsafe({ traceparent })), (span) => ({
    span,
    attributes,
  }));

/**
 * The W3C `traceparent` of the current span under `headerName`, or no headers outside a span.
 *
 * Use it when a custom header (for example `x-vercel-queue-traceparent`) must carry the trace
 * context; `HttpClient` already propagates the standard `traceparent` header.
 */
export const traceparentHeaders = (
  headerName = "traceparent",
): Effect.Effect<Readonly<Record<string, string>>> =>
  Effect.map(Effect.option(Effect.currentSpan), (span) =>
    span.pipe(
      Option.flatMap((span) => Headers.get(HttpTraceContext.toHeaders(span), "traceparent")),
      Option.match({
        onNone: () => ({}),
        onSome: (traceparent) => ({ [headerName]: traceparent }),
      }),
    ),
  );
