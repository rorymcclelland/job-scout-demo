// A small parser for the emails we read: headers, multipart bodies and the two
// transfer encodings mail actually uses (base64 and quoted-printable).
//
// Why not a library? The task app keeps zero runtime dependencies so every line
// can be read and questioned, and job-alert emails only need this much.
// Anything we cannot decode is kept as raw text rather than thrown away.

export interface ParsedEmail {
  messageId: string;
  from: string;
  subject: string;
  date: string; // ISO 8601, or "" if the header was missing or unreadable
  text: string; // the text/plain part, decoded ("" if none)
  html: string; // the text/html part, decoded ("" if none)
  /** Sprint 6a (I1): the address only, lower case, from the From header ("" if none). */
  fromAddress?: string;
  /** Threading headers, for matching a reply to an earlier one (I3). */
  inReplyTo?: string;
  references?: string[];
  /** Every Authentication-Results header the receiving server added (I1: DKIM). */
  authResults?: string[];
  /** A text/calendar part or .ics attachment, decoded ("" if none); read by code, never by the model (I2). */
  calendar?: string;
}

interface Part {
  headers: Map<string, string>;
  /** Headers that may appear more than once, every value kept. */
  all: Map<string, string[]>;
  body: string; // still transfer-encoded
}

/** Parse a whole RFC 822 message (as a string of the raw bytes, latin1). */
export function parseEmail(raw: string): ParsedEmail {
  const top = splitPart(raw);
  const found = { text: "", html: "", calendar: "" };
  collectBodies(top, found);

  const dateHeader = top.headers.get("date") ?? "";
  const parsedDate = dateHeader ? new Date(dateHeader) : null;

  return {
    messageId: (top.headers.get("message-id") ?? "").trim(),
    from: decodeWords(top.headers.get("from") ?? ""),
    subject: decodeWords(top.headers.get("subject") ?? ""),
    date: parsedDate && !isNaN(parsedDate.getTime()) ? parsedDate.toISOString() : "",
    text: found.text,
    html: found.html,
    fromAddress: addressOf(decodeWords(top.headers.get("from") ?? "")),
    inReplyTo: (top.headers.get("in-reply-to") ?? "").trim(),
    references: (top.headers.get("references") ?? "").split(/\s+/).filter(Boolean),
    authResults: top.all.get("authentication-results") ?? [],
    calendar: found.calendar,
  };
}

/** The address in a From header, lower case: "Name <a@b.com>" or "a@b.com". A display name is never used. */
export function addressOf(from: string): string {
  const angle = /<([^<>\s]+@[^<>\s]+)>\s*$/.exec(from);
  if (angle) return angle[1].toLowerCase();
  const bare = /^\s*([^\s<>"]+@[^\s<>"]+)\s*$/.exec(from);
  return bare ? bare[1].toLowerCase() : "";
}

/** Split a part into its headers and its body at the first blank line. */
function splitPart(raw: string): Part {
  const normalised = raw.replace(/\r\n/g, "\n");
  const cut = normalised.indexOf("\n\n");
  const headerBlock = cut === -1 ? normalised : normalised.slice(0, cut);
  const body = cut === -1 ? "" : normalised.slice(cut + 2);

  const headers = new Map<string, string>();
  const all = new Map<string, string[]>();
  // Folded headers continue on lines that start with whitespace.
  const unfolded = headerBlock.replace(/\n[ \t]+/g, " ");
  for (const line of unfolded.split("\n")) {
    const colon = line.indexOf(":");
    if (colon <= 0) continue;
    const name = line.slice(0, colon).trim().toLowerCase();
    if (!headers.has(name)) headers.set(name, line.slice(colon + 1).trim());
    all.set(name, [...(all.get(name) ?? []), line.slice(colon + 1).trim()]);
  }
  return { headers, all, body };
}

/** Walk the part tree and keep the first text/plain and text/html bodies. */
function collectBodies(part: Part, found: { text: string; html: string; calendar: string }): void {
  const contentType = part.headers.get("content-type") ?? "text/plain";
  const mediaType = contentType.split(";")[0].trim().toLowerCase();

  if (mediaType.startsWith("multipart/")) {
    const boundary = headerParam(contentType, "boundary");
    if (!boundary) return;
    for (const child of splitMultipart(part.body, boundary)) {
      collectBodies(splitPart(child), found);
    }
    return;
  }

  const disposition = (part.headers.get("content-disposition") ?? "").toLowerCase();
  const fileName = (headerParam(disposition, "filename") ?? headerParam(contentType.toLowerCase(), "name") ?? "");
  if (mediaType === "text/calendar" || mediaType === "application/ics" || fileName.endsWith(".ics")) {
    if (!found.calendar) {
      const enc = (part.headers.get("content-transfer-encoding") ?? "7bit").toLowerCase();
      found.calendar = decodeBody(part.body, enc, headerParam(contentType, "charset") ?? "utf-8");
    }
    return;
  }
  if (mediaType !== "text/plain" && mediaType !== "text/html") return;
  if (disposition.startsWith("attachment")) return;

  const encoding = (part.headers.get("content-transfer-encoding") ?? "7bit").toLowerCase();
  const charset = headerParam(contentType, "charset") ?? "utf-8";
  const decoded = decodeBody(part.body, encoding, charset);

  if (mediaType === "text/plain" && !found.text) found.text = decoded;
  if (mediaType === "text/html" && !found.html) found.html = decoded;
}

function splitMultipart(body: string, boundary: string): string[] {
  const delimiter = "--" + boundary;
  const pieces = body.split(delimiter);
  // pieces[0] is the preamble; the piece starting with "--" is the epilogue.
  return pieces.slice(1).filter((p) => !p.startsWith("--")).map((p) => p.replace(/^\n/, ""));
}

/** Read a parameter such as boundary= or charset= from a header value. */
export function headerParam(value: string, name: string): string | null {
  const match = new RegExp(`(?:^|;)\\s*${name}\\s*=\\s*("([^"]*)"|[^;\\s]+)`, "i").exec(value);
  if (!match) return null;
  return match[2] ?? match[1];
}

function decodeBody(body: string, encoding: string, charset: string): string {
  let bytes: Uint8Array;
  if (encoding === "base64") {
    bytes = Buffer.from(body.replace(/\s+/g, ""), "base64");
  } else if (encoding === "quoted-printable") {
    bytes = decodeQuotedPrintable(body);
  } else {
    bytes = Buffer.from(body, "latin1");
  }
  return bytesToString(bytes, charset);
}

export function decodeQuotedPrintable(input: string): Uint8Array {
  // Soft line breaks ("=" at end of line) join lines; "=XX" is a hex byte.
  const joined = input.replace(/=\r?\n/g, "");
  const out: number[] = [];
  for (let i = 0; i < joined.length; i++) {
    const ch = joined[i];
    if (ch === "=" && /^[0-9A-Fa-f]{2}$/.test(joined.slice(i + 1, i + 3))) {
      out.push(parseInt(joined.slice(i + 1, i + 3), 16));
      i += 2;
    } else {
      out.push(joined.charCodeAt(i) & 0xff);
    }
  }
  return Uint8Array.from(out);
}

function bytesToString(bytes: Uint8Array, charset: string): string {
  try {
    return new TextDecoder(charset.toLowerCase()).decode(bytes);
  } catch {
    return new TextDecoder("utf-8").decode(bytes);
  }
}

/** Decode RFC 2047 encoded words, e.g. =?UTF-8?Q?Senior_PM_=E2=80=93_London?= */
export function decodeWords(value: string): string {
  return value
    .replace(/\?=\s+=\?/g, "?==?") // whitespace between encoded words is dropped
    .replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g, (_all, charset: string, kind: string, text: string) => {
      const bytes =
        kind.toUpperCase() === "B"
          ? Buffer.from(text, "base64")
          : decodeQuotedPrintable(text.replace(/_/g, " "));
      return bytesToString(bytes, charset);
    });
}
