// Vendored from packages/shared/src/sdk/querystring.ts; refresh both copies together.
/**
 * OpenAPI 3.2 `in: querystring` serialization.
 *
 * A querystring parameter owns the complete URI query. Its parameter name is
 * descriptive only: this helper returns the query payload without a leading
 * `?` and never emits `name=value` for the parameter itself.
 */

type UnknownRecord = Record<string, unknown>;

export interface QuerystringEncoding {
  contentType?: unknown;
  headers?: unknown;
  style?: unknown;
  explode?: unknown;
  allowReserved?: unknown;
}

export interface QuerystringMediaType {
  schema?: unknown;
  encoding?: unknown;
}

export class QuerystringSerializationError extends Error {
  constructor(
    readonly code:
      | "QUERYSTRING_CONTENT_REQUIRED"
      | "QUERYSTRING_MEDIA_TYPE_UNSUPPORTED"
      | "QUERYSTRING_VALUE_INVALID"
      | "QUERYSTRING_ENCODING_UNSUPPORTED",
    message: string,
  ) {
    super(message);
    this.name = "QuerystringSerializationError";
  }
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** JSON from a spec editor is plain data. Reject exotic objects instead of
 * invoking an application-defined `toJSON` method during serialization. */
function isPlainDataRecord(value: unknown): value is UnknownRecord {
  if (!isRecord(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function dataEntries(
  value: UnknownRecord,
  context: string,
): [string, unknown][] {
  if (!isPlainDataRecord(value)) {
    throw new QuerystringSerializationError(
      "QUERYSTRING_VALUE_INVALID",
      `${context} must be a plain object.`,
    );
  }
  const entries: [string, unknown][] = [];
  for (const key of Object.keys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !("value" in descriptor)) {
      throw new QuerystringSerializationError(
        "QUERYSTRING_VALUE_INVALID",
        `${context} cannot contain accessor properties.`,
      );
    }
    entries.push([key, descriptor.value]);
  }
  return entries;
}

function validateFiniteSafeNumber(value: number, context: string): void {
  if (
    Number.isFinite(value) &&
    (!Number.isInteger(value) || Number.isSafeInteger(value))
  ) {
    return;
  }
  throw new QuerystringSerializationError(
    "QUERYSTRING_VALUE_INVALID",
    `${context} must be finite and safe when integral.`,
  );
}

function validateJsonValue(
  value: unknown,
  ancestors: WeakSet<object> = new WeakSet(),
  depth = 0,
): void {
  if (value === undefined) {
    throw new QuerystringSerializationError(
      "QUERYSTRING_VALUE_INVALID",
      "Querystring JSON value cannot contain undefined.",
    );
  }
  if (depth > 64) {
    throw new QuerystringSerializationError(
      "QUERYSTRING_VALUE_INVALID",
      "Querystring JSON value exceeds the maximum nesting depth of 64.",
    );
  }
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return;
  if (typeof value === "number") {
    validateFiniteSafeNumber(value, "Querystring JSON number");
    return;
  }
  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype || "toJSON" in value) {
      throw new QuerystringSerializationError(
        "QUERYSTRING_VALUE_INVALID",
        "Querystring JSON arrays must use the standard array prototype without toJSON.",
      );
    }
    if (ancestors.has(value)) {
      throw new QuerystringSerializationError(
        "QUERYSTRING_VALUE_INVALID",
        "Querystring JSON value cannot be cyclic.",
      );
    }
    ancestors.add(value);
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (descriptor === undefined || !("value" in descriptor)) {
        throw new QuerystringSerializationError(
          "QUERYSTRING_VALUE_INVALID",
          "Querystring JSON arrays cannot contain holes or accessor entries.",
        );
      }
      validateJsonValue(descriptor.value, ancestors, depth + 1);
    }
    ancestors.delete(value);
    return;
  }
  if (isPlainDataRecord(value)) {
    if (
      Object.getOwnPropertyDescriptor(value, "toJSON") === undefined &&
      "toJSON" in value
    ) {
      throw new QuerystringSerializationError(
        "QUERYSTRING_VALUE_INVALID",
        "Querystring JSON objects cannot inherit toJSON.",
      );
    }
    if (ancestors.has(value)) {
      throw new QuerystringSerializationError(
        "QUERYSTRING_VALUE_INVALID",
        "Querystring JSON value cannot be cyclic.",
      );
    }
    ancestors.add(value);
    for (const [, nested] of dataEntries(value, "Querystring JSON value")) {
      validateJsonValue(nested, ancestors, depth + 1);
    }
    ancestors.delete(value);
    return;
  }
  throw new QuerystringSerializationError(
    "QUERYSTRING_VALUE_INVALID",
    "Querystring JSON value must contain JSON data only.",
  );
}

function selectMediaType(
  content: UnknownRecord,
): [string, QuerystringMediaType] {
  const entries = Object.entries(content).filter(
    (entry): entry is [string, QuerystringMediaType] => isRecord(entry[1]),
  );
  if (entries.length === 0) {
    throw new QuerystringSerializationError(
      "QUERYSTRING_CONTENT_REQUIRED",
      "A querystring parameter needs one supported content media type.",
    );
  }
  if (entries.length !== 1 || Object.keys(content).length !== 1) {
    throw new QuerystringSerializationError(
      "QUERYSTRING_MEDIA_TYPE_UNSUPPORTED",
      "A querystring parameter must declare exactly one content media type.",
    );
  }
  const first = entries[0];
  if (first === undefined) {
    throw new QuerystringSerializationError(
      "QUERYSTRING_CONTENT_REQUIRED",
      "Querystring media type is missing.",
    );
  }
  return first;
}

function encodingValue(value: unknown, allowReserved: boolean): string {
  const encoded = encodeURIComponent(String(value)).replace(
    /[!'()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  if (!allowReserved) return encoded;
  // `#`, `&`, `=`, `+`, and brackets change a URI query's structure or form
  // decoding. They remain escaped even with allowReserved. The remaining
  // characters are legal data in a query component without changing fields.
  return encoded.replace(/%(3A|2F|3F|40|24|2C|3B)/gi, (match) =>
    String.fromCharCode(Number.parseInt(match.slice(1), 16)),
  );
}

function formValue(value: unknown, allowReserved: boolean): string {
  return encodingValue(value, allowReserved).replace(/%20/g, "+");
}

function keyValue(key: string, value: unknown, allowReserved: boolean): string {
  return `${formValue(key, false)}=${formValue(value, allowReserved)}`;
}

function keyJoined(
  key: string,
  values: readonly unknown[],
  delimiter: string,
  allowReserved: boolean,
): string {
  const encodeValue = (value: unknown): string => {
    const encoded = formValue(value, allowReserved);
    // The join delimiter belongs to the serialization, never to user data.
    // `allowReserved` permits commas, so protect form's comma delimiter after
    // serializing each value and before joining the values together.
    return delimiter === "," ? encoded.replace(/,/g, "%2C") : encoded;
  };
  return `${encodingValue(key, false)}=${values
    .map(encodeValue)
    .join(delimiter)}`;
}

function primitive(value: unknown, field: string): string | number | boolean {
  if (typeof value === "number") {
    validateFiniteSafeNumber(value, `Querystring field \"${field}\" number`);
    return value;
  }
  if (typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  throw new QuerystringSerializationError(
    "QUERYSTRING_VALUE_INVALID",
    `Querystring field \"${field}\" may only contain scalar values.`,
  );
}

function flatObject(value: unknown, field: string): UnknownRecord {
  if (!isPlainDataRecord(value)) {
    throw new QuerystringSerializationError(
      "QUERYSTRING_VALUE_INVALID",
      `Querystring field \"${field}\" must be an object.`,
    );
  }
  for (const [key, nested] of dataEntries(
    value,
    `Querystring field \"${field}\"`,
  )) {
    primitive(nested, `${field}.${key}`);
  }
  return value;
}

function flatArray(value: unknown, field: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new QuerystringSerializationError(
      "QUERYSTRING_VALUE_INVALID",
      `Querystring field \"${field}\" must be an array.`,
    );
  }
  const values: unknown[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined || !("value" in descriptor)) {
      throw new QuerystringSerializationError(
        "QUERYSTRING_VALUE_INVALID",
        `Querystring array field \"${field}\" cannot contain holes or accessor entries.`,
      );
    }
    primitive(descriptor.value, field);
    values.push(descriptor.value);
  }
  return values;
}

function formEncoding(
  raw: unknown,
  field: string,
): {
  style: "form" | "spaceDelimited" | "pipeDelimited" | "deepObject";
  explode: boolean;
  allowReserved: boolean;
} {
  if (raw !== undefined && !isRecord(raw)) {
    throw new QuerystringSerializationError(
      "QUERYSTRING_ENCODING_UNSUPPORTED",
      `Querystring encoding for \"${field}\" must be an object.`,
    );
  }
  const encoding = (raw ?? {}) as QuerystringEncoding;
  if (encoding.headers !== undefined || encoding.contentType !== undefined) {
    throw new QuerystringSerializationError(
      "QUERYSTRING_ENCODING_UNSUPPORTED",
      `Querystring encoding for \"${field}\" uses unsupported headers or contentType.`,
    );
  }
  const style = encoding.style ?? "form";
  if (
    style !== "form" &&
    style !== "spaceDelimited" &&
    style !== "pipeDelimited" &&
    style !== "deepObject"
  ) {
    throw new QuerystringSerializationError(
      "QUERYSTRING_ENCODING_UNSUPPORTED",
      `Querystring encoding for \"${field}\" has unsupported style \"${String(style)}\".`,
    );
  }
  if (encoding.explode !== undefined && typeof encoding.explode !== "boolean") {
    throw new QuerystringSerializationError(
      "QUERYSTRING_ENCODING_UNSUPPORTED",
      `Querystring encoding for \"${field}\" has a non-boolean explode value.`,
    );
  }
  if (
    encoding.allowReserved !== undefined &&
    typeof encoding.allowReserved !== "boolean"
  ) {
    throw new QuerystringSerializationError(
      "QUERYSTRING_ENCODING_UNSUPPORTED",
      `Querystring encoding for \"${field}\" has a non-boolean allowReserved value.`,
    );
  }
  return {
    style,
    explode: encoding.explode ?? style === "form",
    allowReserved: encoding.allowReserved ?? false,
  };
}

function serializeFormField(
  field: string,
  value: unknown,
  encoding: ReturnType<typeof formEncoding>,
): string[] {
  const { style, explode, allowReserved } = encoding;
  if ((style === "spaceDelimited" || style === "pipeDelimited") && explode) {
    throw new QuerystringSerializationError(
      "QUERYSTRING_ENCODING_UNSUPPORTED",
      `Querystring ${style} field \"${field}\" cannot use explode: true.`,
    );
  }
  if (Array.isArray(value)) {
    const values = flatArray(value, field);
    if (style === "deepObject") {
      throw new QuerystringSerializationError(
        "QUERYSTRING_ENCODING_UNSUPPORTED",
        `Querystring array \"${field}\" cannot use deepObject style.`,
      );
    }
    if (style === "form" && explode) {
      return values.map((item) =>
        keyValue(field, primitive(item, field), allowReserved),
      );
    }
    const delimiter =
      style === "spaceDelimited"
        ? "%20"
        : style === "pipeDelimited"
          ? "|"
          : ",";
    return [
      keyJoined(
        field,
        values.map((item) => primitive(item, field)),
        delimiter,
        allowReserved,
      ),
    ];
  }

  if (isRecord(value)) {
    const object = flatObject(value, field);
    if (style === "spaceDelimited" || style === "pipeDelimited") {
      throw new QuerystringSerializationError(
        "QUERYSTRING_ENCODING_UNSUPPORTED",
        `Querystring object \"${field}\" cannot use ${style} style.`,
      );
    }
    if (style === "deepObject") {
      if (!explode) {
        throw new QuerystringSerializationError(
          "QUERYSTRING_ENCODING_UNSUPPORTED",
          `Querystring object \"${field}\" requires explode: true with deepObject style.`,
        );
      }
      return Object.entries(object).map(([key, item]) =>
        keyValue(
          `${field}[${key}]`,
          primitive(item, `${field}.${key}`),
          allowReserved,
        ),
      );
    }
    if (explode) {
      return Object.entries(object).map(([key, item]) =>
        keyValue(key, primitive(item, `${field}.${key}`), allowReserved),
      );
    }
    const flattened: unknown[] = [];
    for (const [key, item] of Object.entries(object)) {
      flattened.push(key, primitive(item, `${field}.${key}`));
    }
    return [keyJoined(field, flattened, ",", allowReserved)];
  }

  if (style === "deepObject") {
    throw new QuerystringSerializationError(
      "QUERYSTRING_ENCODING_UNSUPPORTED",
      `Querystring scalar \"${field}\" cannot use deepObject style.`,
    );
  }
  if (style === "spaceDelimited" || style === "pipeDelimited") {
    throw new QuerystringSerializationError(
      "QUERYSTRING_ENCODING_UNSUPPORTED",
      `Querystring scalar \"${field}\" cannot use ${style} style.`,
    );
  }
  return [keyValue(field, primitive(value, field), allowReserved)];
}

function serializeForm(value: unknown, encoding: unknown): string {
  if (!isRecord(value)) {
    throw new QuerystringSerializationError(
      "QUERYSTRING_VALUE_INVALID",
      "application/x-www-form-urlencoded querystring content must be an object.",
    );
  }
  if (encoding !== undefined && !isRecord(encoding)) {
    throw new QuerystringSerializationError(
      "QUERYSTRING_ENCODING_UNSUPPORTED",
      "Querystring media encoding must be an object.",
    );
  }

  const fields: string[] = [];
  const encodings = (encoding ?? {}) as UnknownRecord;
  for (const [field, item] of dataEntries(
    value,
    "application/x-www-form-urlencoded querystring content",
  )) {
    fields.push(
      ...serializeFormField(field, item, formEncoding(encodings[field], field)),
    );
  }
  return fields.join("&");
}

/**
 * Serialize an OpenAPI 3.2 whole-query parameter into a raw URI query string.
 *
 * Supports `application/json` and `application/x-www-form-urlencoded`.
 * Unsupported media types and recursive/ambiguous form values fail before a
 * caller can send a request with a guessed wire representation.
 */
export function encodeQuerystring(
  value: unknown,
  content: UnknownRecord,
): string {
  const [declaredMediaType, media] = selectMediaType(content);
  const mediaType = (declaredMediaType.split(";", 1)[0] ?? "")
    .trim()
    .toLowerCase();
  if (mediaType === "application/json") {
    if (media.encoding !== undefined) {
      throw new QuerystringSerializationError(
        "QUERYSTRING_ENCODING_UNSUPPORTED",
        "application/json querystring content cannot declare form encoding.",
      );
    }
    validateJsonValue(value);
    const encoded = JSON.stringify(value);
    if (encoded === undefined) {
      throw new QuerystringSerializationError(
        "QUERYSTRING_VALUE_INVALID",
        "Querystring JSON value cannot be undefined.",
      );
    }
    return encodingValue(encoded, false);
  }
  if (mediaType === "application/x-www-form-urlencoded") {
    return serializeForm(value, media.encoding);
  }
  throw new QuerystringSerializationError(
    "QUERYSTRING_MEDIA_TYPE_UNSUPPORTED",
    `Unsupported querystring media type \"${declaredMediaType}\".`,
  );
}
