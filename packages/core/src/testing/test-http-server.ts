/// <reference types="node" />
import type { IncomingMessage, ServerResponse } from "node:http";

import { Context, Effect, Layer, Option, Queue, Ref, Stream } from "effect";
import { createServer } from "node:http";

/** One request received by {@link TestHttpServer}, with its body fully read. */
export interface TestHttpRequest {
  readonly method: string;

  /** Path and query string, such as `/api/v3/topic/orders?limit=1`. */
  readonly url: string;

  /** Header names in lower case; repeated headers are joined with `, `. */
  readonly headers: Readonly<Record<string, string>>;

  readonly body: Uint8Array;

  /** The body decoded as UTF-8. */
  readonly text: string;
}

/** A scripted reply. A stream body is written chunk by chunk, so clients see a streamed response. */
export interface TestHttpResponse {
  /** Defaults to 200. */
  readonly status?: number | undefined;
  readonly headers?: Readonly<Record<string, string>> | undefined;
  readonly body?: string | Uint8Array | Stream.Stream<Uint8Array> | undefined;
}

/** Computes the reply for requests that no queued response answers. */
export type TestHttpHandler = (
  request: TestHttpRequest,
) => TestHttpResponse | Effect.Effect<TestHttpResponse>;

/** Options for {@link TestHttpServerLive}. */
export interface TestHttpServerOptions {
  /** Initial handler; without one, unscripted requests get a 501 response. */
  readonly handler?: TestHttpHandler | undefined;
}

/**
 * A real HTTP server on `127.0.0.1` and a random port, for tests that exercise HTTP clients end to
 * end. Replies come first from the queue filled by `enqueue`, then from the handler; every request
 * is recorded.
 */
export class TestHttpServer extends Context.Service<
  TestHttpServer,
  {
    /** Base URL without a trailing slash, such as `http://127.0.0.1:53124`. */
    readonly url: string;

    /** Requests received so far, oldest first. */
    readonly requests: Effect.Effect<ReadonlyArray<TestHttpRequest>>;

    /** Queue replies for the next requests, in order, ahead of the handler. */
    readonly enqueue: (...responses: ReadonlyArray<TestHttpResponse>) => Effect.Effect<void>;

    /** Replace the handler used once the queue is empty. */
    readonly setHandler: (handler: TestHttpHandler) => Effect.Effect<void>;
  }
>()("@effect-vercel/core/TestHttpServer") {}

const notScripted: TestHttpHandler = (request) => ({
  status: 501,
  headers: { "content-type": "text/plain" },
  body: `TestHttpServer has no scripted response for ${request.method} ${request.url}`,
});

const readRequest = (request: IncomingMessage): Effect.Effect<TestHttpRequest> =>
  Effect.callback<TestHttpRequest>((resume) => {
    const chunks: Array<Buffer> = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const body = new Uint8Array(Buffer.concat(chunks));
      const headers: Record<string, string> = {};
      for (const [name, value] of Object.entries(request.headers)) {
        if (value !== undefined) {
          headers[name] = Array.isArray(value) ? value.join(", ") : value;
        }
      }
      resume(
        Effect.succeed({
          method: request.method ?? "GET",
          url: request.url ?? "/",
          headers,
          body,
          text: new TextDecoder().decode(body),
        }),
      );
    });
  });

const writeChunk = (response: ServerResponse, chunk: Uint8Array) =>
  Effect.callback<void>((resume) => {
    response.write(chunk, () => resume(Effect.void));
  });

const writeResponse = (response: ServerResponse, reply: TestHttpResponse) =>
  Effect.gen(function* () {
    response.writeHead(reply.status ?? 200, reply.headers);
    const body = reply.body;
    if (body === undefined || typeof body === "string" || body instanceof Uint8Array) {
      response.end(body);
      return;
    }
    response.flushHeaders();
    yield* Stream.runForEach(body, (chunk) => writeChunk(response, chunk));
    response.end();
  });

/**
 * Starts a {@link TestHttpServer} for the layer's scope and closes it, with any open connections,
 * when the scope ends.
 */
export const TestHttpServerLive = (options: TestHttpServerOptions = {}) =>
  Layer.effect(
    TestHttpServer,
    Effect.gen(function* () {
      const requests = yield* Ref.make<ReadonlyArray<TestHttpRequest>>([]);
      const queued = yield* Queue.unbounded<TestHttpResponse>();
      const handler = yield* Ref.make(options.handler ?? notScripted);
      const context = yield* Effect.context<never>();

      const reply = Effect.fnUntraced(function* (request: TestHttpRequest) {
        const next = yield* Queue.poll(queued);
        if (Option.isSome(next)) {
          return next.value;
        }
        const current = yield* Ref.get(handler);
        const result = current(request);
        return Effect.isEffect(result) ? yield* result : result;
      });

      const handle = (incoming: IncomingMessage, outgoing: ServerResponse) =>
        Effect.gen(function* () {
          const request = yield* readRequest(incoming);
          yield* Ref.update(requests, (all) => [...all, request]);
          yield* writeResponse(outgoing, yield* reply(request));
        }).pipe(
          Effect.catchCause((cause) =>
            Effect.sync(() => {
              if (!outgoing.headersSent) {
                outgoing.writeHead(500, { "content-type": "text/plain" });
              }
              outgoing.end(String(cause));
            }),
          ),
        );

      const server = yield* Effect.acquireRelease(
        Effect.callback<ReturnType<typeof createServer>>((resume) => {
          const server = createServer((incoming, outgoing) => {
            void Effect.runPromiseWith(context)(handle(incoming, outgoing));
          });
          server.listen(0, "127.0.0.1", () => resume(Effect.succeed(server)));
        }),
        (server) =>
          Effect.callback<void>((resume) => {
            server.closeAllConnections();
            server.close(() => resume(Effect.void));
          }),
      );

      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;

      return TestHttpServer.of({
        url: `http://127.0.0.1:${port}`,
        requests: Ref.get(requests),
        enqueue: (...responses) => Effect.asVoid(Queue.offerAll(queued, responses)),
        setHandler: (next) => Ref.set(handler, next),
      });
    }),
  );
