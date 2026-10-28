import { Schema, SchemaTransformation } from "effect";

import { TopicName } from "./queue-domain.ts";

/**
 * A queue topic and the schema of its payloads, shared by the code that publishes to it and the
 * code that consumes it.
 *
 * @template A - Payload type handlers receive and producers send.
 * @template I - Encoded form of the payload before it is serialized to bytes.
 */
export interface Topic<A, I = A> {
  readonly name: TopicName;

  /** Schema of the payload, as given by the topic's author. */
  readonly schema: Schema.Codec<A, I>;

  /** Content type sent with every message of this topic. */
  readonly contentType: string;

  /** Converts between the payload and the bytes stored in the queue. */
  readonly wire: Schema.Codec<A, Uint8Array>;
}

const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder();

const Utf8String = Schema.Uint8Array.pipe(
  Schema.decodeTo(
    Schema.String,
    SchemaTransformation.transform<string, Uint8Array>({
      decode: (bytes) => utf8Decoder.decode(bytes),
      encode: (text) => utf8Encoder.encode(text),
    }),
  ),
);

/**
 * Define a topic whose payloads travel as JSON (`application/json`).
 *
 * @param name - Topic name; an invalid name is a defect raised where the topic is defined.
 * @param schema - Payload schema; its encoded form must be JSON-serializable.
 */
const json = <A, I>(name: string, schema: Schema.Codec<A, I>): Topic<A, I> => ({
  name: TopicName.make(name),
  schema,
  contentType: "application/json",
  wire: Utf8String.pipe(Schema.decodeTo(Schema.fromJsonString(schema))),
});

/**
 * Define a topic whose payloads are raw bytes (`application/octet-stream`).
 *
 * @param name - Topic name; an invalid name is a defect raised where the topic is defined.
 */
const bytes = (name: string): Topic<Uint8Array> => ({
  name: TopicName.make(name),
  schema: Schema.Uint8Array,
  contentType: "application/octet-stream",
  wire: Schema.Uint8Array,
});

/** Constructors for {@link Topic} definitions. */
export const Topic = { json, bytes };

/** Type helpers for {@link Topic}. */
export declare namespace Topic {
  /** Any topic, regardless of payload type. */
  export type Any = Topic<any, any>;

  /** Payload type of a topic, like `Schema.Type`. */
  export type Type<T extends Any> = T extends Topic<infer A, any> ? A : never;

  /** Encoded payload type of a topic, like `Schema.Encoded`. */
  export type Encoded<T extends Any> = T extends Topic<any, infer I> ? I : never;
}
