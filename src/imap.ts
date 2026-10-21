// A minimal, read-only IMAP client for Proton Mail Bridge (backlog item B2).
//
// Proton Mail has no public API. Bridge runs on your computer and offers your
// mailbox as an ordinary IMAP server on 127.0.0.1, so this file speaks just
// enough IMAP to: log in, open a folder READ-ONLY, search by sender and date,
// and fetch whole messages without marking them as read.
//
// Read-only is enforced twice: the folder is opened with EXAMINE (the IMAP
// read-only open), and messages are fetched with BODY.PEEK, which never sets
// the \Seen flag. Nothing in this file can send, move, delete or flag mail.

import net from "node:net";
import tls from "node:tls";

export interface ImapSettings {
  host: string;
  port: number;
  security: "starttls" | "ssl" | "none";
  user: string;
  password: string;
  folder: string;
}

export interface FetchedMessage {
  uid: number;
  raw: string; // the message bytes as latin1, decoded later by mime.ts
}

type Socket = net.Socket | tls.TLSSocket;

/**
 * Fetch every message in the folder from any of `senders` since `since`.
 * `senders` are matched by IMAP's FROM search, which is a substring match.
 */
export async function fetchMessages(
  s: ImapSettings,
  senders: string[],
  since: Date,
): Promise<FetchedMessage[]> {
  const conn = await Connection.open(s);
  try {
    await conn.command(`LOGIN ${quote(s.user)} ${quote(s.password)}`);
    await conn.command(`EXAMINE ${quote(s.folder)}`);

    const uids = new Set<number>();
    for (const sender of senders) {
      const reply = await conn.command(`UID SEARCH SINCE ${imapDate(since)} FROM ${quote(sender)}`);
      for (const n of parseSearch(reply.text)) uids.add(n);
    }

    const messages: FetchedMessage[] = [];
    for (const uid of [...uids].sort((a, b) => a - b)) {
      const reply = await conn.command(`UID FETCH ${uid} BODY.PEEK[]`);
      if (reply.literals.length > 0) messages.push({ uid, raw: reply.literals[0] });
    }
    await conn.command("LOGOUT").catch(() => undefined);
    return messages;
  } finally {
    conn.close();
  }
}

/**
 * For setting up: log in, list the folders, and count matching emails per
 * sender over the last `days` days. Fetches no message content.
 */
export async function checkConnection(
  s: ImapSettings,
  senders: string[],
  days: number,
  otherFolders: string[] = [],
): Promise<{ folders: string[]; counts: Array<{ sender: string; count: number; folder: string }> }> {
  const conn = await Connection.open(s);
  try {
    await conn.command(`LOGIN ${quote(s.user)} ${quote(s.password)}`);
    const list = await conn.command(`LIST "" "*"`);
    const folders = list.text
      .split("\n")
      .filter((l) => l.startsWith("* LIST"))
      .map((l) => /"([^"]*)"\s*$/.exec(l)?.[1] ?? l.split(" ").at(-1) ?? "")
      .filter(Boolean);
    const since = new Date(Date.now() - days * 86_400_000);
    const counts = [];
    const toSearch = [s.folder, ...otherFolders.filter((f) => f !== s.folder && folders.includes(f))];
    for (const folder of toSearch) {
      await conn.command(`EXAMINE ${quote(folder)}`);
      for (const sender of senders) {
        const reply = await conn.command(`UID SEARCH SINCE ${imapDate(since)} FROM ${quote(sender)}`);
        counts.push({ sender, count: parseSearch(reply.text).length, folder });
      }
    }
    await conn.command("LOGOUT").catch(() => undefined);
    return { folders, counts };
  } finally {
    conn.close();
  }
}

interface Reply {
  text: string; // all untagged lines, literals replaced by a placeholder
  literals: string[]; // the {n}-sized blocks, in order
}

class Connection {
  private socket: Socket;
  private buffer = Buffer.alloc(0);
  private waiting: (() => void) | null = null;
  private failure: Error | null = null;
  private tag = 0;

  private constructor(socket: Socket) {
    this.socket = socket;
    this.attach(socket);
  }

  static async open(s: ImapSettings): Promise<Connection> {
    const local = s.host === "127.0.0.1" || s.host === "localhost" || s.host === "::1";
    // Bridge presents a self-signed certificate. We accept that only for a
    // server on this computer, where the traffic never leaves the machine.
    const tlsOptions = { rejectUnauthorized: !local, servername: local ? undefined : s.host };

    const raw: Socket = s.security === "ssl"
      ? tls.connect({ host: s.host, port: s.port, ...tlsOptions })
      : net.connect({ host: s.host, port: s.port });
    await onceConnected(raw, s.security === "ssl");

    let conn = new Connection(raw);
    await conn.readLine(); // the server greeting

    if (s.security === "starttls") {
      await conn.command("STARTTLS");
      conn.detach();
      const secure = tls.connect({ socket: raw as net.Socket, ...tlsOptions });
      await onceConnected(secure, true);
      conn = new Connection(secure);
    }
    return conn;
  }

  /** Send one command and collect everything up to its tagged reply. */
  async command(cmd: string): Promise<Reply> {
    const tag = `A${++this.tag}`;
    this.socket.write(`${tag} ${cmd}\r\n`);
    const reply: Reply = { text: "", literals: [] };

    for (;;) {
      let line = await this.readLine();
      // A line ending in {n} is followed by exactly n bytes of literal data.
      let lit = /\{(\d+)\}$/.exec(line);
      while (lit) {
        const bytes = await this.readBytes(Number(lit[1]));
        reply.literals.push(bytes.toString("latin1"));
        const rest = await this.readLine();
        line = line.replace(/\{\d+\}$/, "<literal>") + rest;
        lit = /\{(\d+)\}$/.exec(rest);
      }
      if (line.startsWith(`${tag} `)) {
        const status = line.slice(tag.length + 1);
        if (!status.startsWith("OK")) {
          // Never echo the LOGIN command: it holds the password.
          const shown = cmd.startsWith("LOGIN") ? "LOGIN" : cmd;
          throw new Error(`IMAP ${shown} failed: ${status}`);
        }
        return reply;
      }
      reply.text += line + "\n";
    }
  }

  close(): void {
    this.socket.destroy();
  }

  private attach(socket: Socket): void {
    socket.on("data", this.onData);
    socket.on("error", this.onError);
    socket.on("close", this.onClose);
  }

  private detach(): void {
    this.socket.off("data", this.onData);
    this.socket.off("error", this.onError);
    this.socket.off("close", this.onClose);
  }

  private onData = (chunk: Buffer) => {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    this.wake();
  };
  private onError = (err: Error) => {
    this.failure = err;
    this.wake();
  };
  private onClose = () => {
    this.failure ??= new Error("The mail server closed the connection.");
    this.wake();
  };
  private wake(): void {
    const w = this.waiting;
    this.waiting = null;
    w?.();
  }

  private async waitForData(): Promise<void> {
    if (this.failure) throw this.failure;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Timed out waiting for the mail server.")), 60_000);
      this.waiting = () => { clearTimeout(timer); resolve(); };
    });
    if (this.failure && this.buffer.length === 0) throw this.failure;
  }

  private async readLine(): Promise<string> {
    for (;;) {
      const end = this.buffer.indexOf("\r\n");
      if (end !== -1) {
        const line = this.buffer.subarray(0, end).toString("latin1");
        this.buffer = this.buffer.subarray(end + 2);
        return line;
      }
      await this.waitForData();
    }
  }

  private async readBytes(n: number): Promise<Buffer> {
    while (this.buffer.length < n) await this.waitForData();
    const out = this.buffer.subarray(0, n);
    this.buffer = this.buffer.subarray(n);
    return out;
  }
}

function onceConnected(socket: Socket, secure: boolean): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.once(secure ? "secureConnect" : "connect", () => resolve());
    socket.once("error", reject);
  });
}

/** IMAP quoted string. */
export function quote(s: string): string {
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** IMAP date, e.g. 12-Oct-2026. */
export function imapDate(d: Date): string {
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${d.getDate()}-${months[d.getMonth()]}-${d.getFullYear()}`;
}

export function parseSearch(text: string): number[] {
  const out: number[] = [];
  for (const line of text.split("\n")) {
    if (!line.startsWith("* SEARCH")) continue;
    for (const n of line.slice(8).trim().split(/\s+/)) if (/^\d+$/.test(n)) out.push(Number(n));
  }
  return out;
}
