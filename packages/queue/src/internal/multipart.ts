import { Data, Effect, Option, Stream } from "effect";

export interface MultipartPart {
  /** Header names in lower case; repeated headers are joined with `, `. */
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Uint8Array;
}

export interface OutgoingPart {
  readonly headers: ReadonlyArray<readonly [name: string, value: string]>;
  readonly body: Uint8Array;
}

export class MultipartMixedError extends Data.TaggedError("MultipartMixedError")<{
  readonly message: string;
}> {}

const maxHeaderSize = 65_536;

const encoder = new TextEncoder();
const latin1 = new TextDecoder("latin1");

export const boundaryFromContentType = (contentType: string): Option.Option<string> => {
  const match = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType);
  return Option.fromNullishOr(match?.[1] ?? match?.[2]);
};

const concatBytes = (chunks: ReadonlyArray<Uint8Array>): Uint8Array => {
  const out = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
};

export const encodeMultipartMixed = (
  boundary: string,
  parts: ReadonlyArray<OutgoingPart>,
): Uint8Array =>
  concatBytes([
    ...parts.flatMap((part) => [
      encoder.encode(
        `--${boundary}\r\n${part.headers.map(([name, value]) => `${name}: ${value}\r\n`).join("")}\r\n`,
      ),
      part.body,
      encoder.encode("\r\n"),
    ]),
    encoder.encode(`--${boundary}--\r\n`),
  ]);

const indexOf = (haystack: Uint8Array, needle: Uint8Array, from: number): number => {
  const last = haystack.length - needle.length;
  const first = needle[0];
  outer: for (let i = Math.max(0, from); i <= last; i++) {
    if (haystack[i] !== first) continue;
    for (let j = 1; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  return -1;
};

const startsWith = (haystack: Uint8Array, needle: Uint8Array): boolean =>
  haystack.length >= needle.length && indexOf(haystack.subarray(0, needle.length), needle, 0) === 0;

const parseHeaders = (bytes: Uint8Array): Record<string, string> => {
  const headers: Record<string, string> = {};
  for (const line of latin1.decode(bytes).trim().split(/\r?\n/)) {
    const colon = line.indexOf(":");
    if (colon <= 0) continue;
    const name = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    headers[name] = name in headers ? `${headers[name]}, ${value}` : value;
  }
  return headers;
};

const crlfcrlf = encoder.encode("\r\n\r\n");
const lflf = encoder.encode("\n\n");

type State = "start" | "afterBoundary" | "headers" | "body" | "done";

const growableBuffer = () => {
  let storage = new Uint8Array(0);
  let start = 0;
  let end = 0;
  return {
    view: () => storage.subarray(start, end),
    append: (chunk: Uint8Array) => {
      const length = end - start;
      if (end + chunk.length > storage.length) {
        const next = new Uint8Array(Math.max(storage.length * 2, length + chunk.length, 1024));
        next.set(storage.subarray(start, end));
        storage = next;
        start = 0;
        end = length;
      }
      storage.set(chunk, end);
      end += chunk.length;
    },
    consume: (count: number) => {
      start += count;
      if (start === end) {
        start = 0;
        end = 0;
      }
    },
    clear: () => {
      start = 0;
      end = 0;
    },
  };
};

const mixedParser = (boundary: string) => {
  const opening = encoder.encode(`--${boundary}`);
  const delimiter = encoder.encode(`\r\n--${boundary}`);
  const buffer = growableBuffer();
  let state: State = "start";
  let searchFrom = 0;
  let headers: Record<string, string> = {};

  const failure = (message: string) => Effect.fail(new MultipartMixedError({ message }));

  const step = (parts: Array<MultipartPart>): Option.Option<string> | "wait" => {
    const bytes = buffer.view();
    switch (state) {
      case "start": {
        if (bytes.length < opening.length) return "wait";
        if (!startsWith(bytes, opening)) {
          return Option.some("Invalid multipart stream: missing initial boundary");
        }
        buffer.consume(opening.length);
        state = "afterBoundary";
        return Option.none();
      }
      case "afterBoundary": {
        if (bytes.length < 2) return "wait";
        if (bytes[0] === 45 && bytes[1] === 45) {
          state = "done";
          buffer.clear();
          return "wait";
        }
        if (bytes[0] === 13 && bytes[1] === 10) {
          buffer.consume(2);
        } else if (bytes[0] === 10) {
          buffer.consume(1);
        } else {
          return Option.some("Invalid character after multipart boundary");
        }
        state = "headers";
        return Option.none();
      }
      case "headers": {
        let end = -1;
        let skip = 0;
        if (bytes[0] === 13 && bytes[1] === 10) {
          end = 0;
          skip = 2;
        } else if (bytes[0] === 10) {
          end = 0;
          skip = 1;
        } else {
          const crlf = indexOf(bytes, crlfcrlf, 0);
          const lf = indexOf(bytes, lflf, 0);
          if (crlf !== -1 && (lf === -1 || crlf < lf)) {
            end = crlf;
            skip = 4;
          } else {
            end = lf;
            skip = 2;
          }
        }
        if (end === -1) {
          return bytes.length > maxHeaderSize
            ? Option.some("Multipart part headers are too large")
            : "wait";
        }
        headers = parseHeaders(bytes.subarray(0, end));
        buffer.consume(end + skip);
        searchFrom = 0;
        state = "body";
        return Option.none();
      }
      case "body": {
        const end = indexOf(bytes, delimiter, searchFrom);
        if (end === -1) {
          searchFrom = Math.max(0, bytes.length - delimiter.length + 1);
          return "wait";
        }
        parts.push({ headers, body: bytes.slice(0, end) });
        buffer.consume(end + delimiter.length);
        state = "afterBoundary";
        return Option.none();
      }
      case "done":
        return "wait";
    }
  };

  const push = (chunk: Uint8Array): Effect.Effect<Array<MultipartPart>, MultipartMixedError> => {
    if (state === "done") return Effect.succeed([]);
    buffer.append(chunk);
    const parts: Array<MultipartPart> = [];
    while (true) {
      const result = step(parts);
      if (result === "wait") return Effect.succeed(parts);
      if (Option.isSome(result)) return failure(result.value);
    }
  };

  const finish = Effect.suspend(() => {
    if (state === "done") return Effect.void;
    return failure(
      state === "start"
        ? "Invalid multipart stream: missing initial boundary"
        : "Unexpected end of multipart stream",
    );
  });

  return { push, finish };
};

/** Parses a `multipart/mixed` body as it streams in, emitting each part once it is complete. */
export const decodeMultipartMixed =
  (boundary: string) =>
  <E, R>(
    source: Stream.Stream<Uint8Array, E, R>,
  ): Stream.Stream<MultipartPart, E | MultipartMixedError, R> =>
    Stream.suspend(() => {
      const parser = mixedParser(boundary);
      return source.pipe(
        Stream.mapEffect(parser.push),
        Stream.flattenIterable,
        Stream.concat(Stream.fromEffectDrain(parser.finish)),
      );
    });
