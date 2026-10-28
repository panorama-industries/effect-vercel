import { assert, describe, it } from "@effect/vitest";
import { Effect, Exit, Layer, Stream } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";

import { TestHttpServer, TestHttpServerLive } from "./test-http-server.ts";

const TestLayer = Layer.merge(TestHttpServerLive(), FetchHttpClient.layer);

const encoder = new TextEncoder();

describe("TestHttpServer", () => {
  it.effect("records method, URL, headers and body bytes", () =>
    Effect.gen(function* () {
      const server = yield* TestHttpServer;
      const client = yield* HttpClient.HttpClient;
      yield* server.enqueue({ status: 201, body: "created" });
      const response = yield* HttpClientRequest.post(`${server.url}/api/topic/orders?limit=1`).pipe(
        HttpClientRequest.setHeader("X-Custom", "yes"),
        HttpClientRequest.bodyText("hello", "text/plain"),
        client.execute,
      );
      assert.strictEqual(response.status, 201);
      assert.strictEqual(yield* response.text, "created");
      const [request] = yield* server.requests;
      assert.strictEqual(request?.method, "POST");
      assert.strictEqual(request?.url, "/api/topic/orders?limit=1");
      assert.strictEqual(request?.headers["x-custom"], "yes");
      assert.strictEqual(request?.headers["content-type"], "text/plain");
      assert.deepStrictEqual(request?.body, encoder.encode("hello"));
      assert.strictEqual(request?.text, "hello");
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("serves queued responses in order before the handler", () =>
    Effect.gen(function* () {
      const server = yield* TestHttpServer;
      const client = yield* HttpClient.HttpClient;
      yield* server.enqueue({ body: "first" }, { status: 202, body: "second" });
      yield* server.setHandler((request) =>
        Effect.succeed({ status: 200, headers: { "x-path": request.url }, body: "handled" }),
      );
      const bodies: Array<string> = [];
      for (let i = 0; i < 3; i++) {
        const response = yield* client.get(`${server.url}/n${i}`);
        bodies.push(`${response.status}:${yield* response.text}`);
      }
      assert.deepStrictEqual(bodies, ["200:first", "202:second", "200:handled"]);
      assert.strictEqual((yield* server.requests).length, 3);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("answers unscripted requests with 501", () =>
    Effect.gen(function* () {
      const server = yield* TestHttpServer;
      const response = yield* (yield* HttpClient.HttpClient).get(`${server.url}/missing`);
      assert.strictEqual(response.status, 501);
      assert.include(yield* response.text, "GET /missing");
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("streams a response body chunk by chunk", () =>
    Effect.gen(function* () {
      const server = yield* TestHttpServer;
      const chunks = [
        "--b\r\n",
        "Content-Type: application/json\r\n\r\n",
        '{"a":1}\r\n',
        "--b--\r\n",
      ];
      yield* server.enqueue({
        headers: { "content-type": 'multipart/mixed; boundary="b"' },
        body: Stream.fromIterable(chunks.map((chunk) => encoder.encode(chunk))),
      });
      const response = yield* (yield* HttpClient.HttpClient).get(`${server.url}/stream`);
      assert.strictEqual(response.headers["content-type"], 'multipart/mixed; boundary="b"');
      assert.strictEqual(response.headers["transfer-encoding"], "chunked");
      const text = yield* Stream.mkString(Stream.decodeText(response.stream));
      assert.strictEqual(text, chunks.join(""));
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("records binary multipart request bodies byte for byte", () =>
    Effect.gen(function* () {
      const server = yield* TestHttpServer;
      yield* server.enqueue({ status: 204 });
      const body = new Uint8Array([
        ...encoder.encode("--x\r\n\r\n"),
        0,
        255,
        128,
        ...encoder.encode("\r\n--x--"),
      ]);
      yield* HttpClientRequest.put(`${server.url}/upload`).pipe(
        HttpClientRequest.bodyUint8Array(body, 'multipart/mixed; boundary="x"'),
        (yield* HttpClient.HttpClient).execute,
      );
      const [request] = yield* server.requests;
      assert.deepStrictEqual(request?.body, body);
      assert.strictEqual(request?.headers["content-type"], 'multipart/mixed; boundary="x"');
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("stops listening when its scope closes", () =>
    Effect.gen(function* () {
      const url = yield* Effect.gen(function* () {
        return (yield* TestHttpServer).url;
      }).pipe(Effect.provide(TestHttpServerLive()));
      const exit = yield* Effect.exit((yield* HttpClient.HttpClient).get(url));
      assert.isTrue(Exit.isFailure(exit));
    }).pipe(Effect.provide(FetchHttpClient.layer)),
  );
});
