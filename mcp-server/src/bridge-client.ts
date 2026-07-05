/**
 * BridgeClient — connects the MCP server to the EEZ Studio bridge over a
 * localhost WebSocket, discovering the port/token from a handshake file.
 *
 * Responsibilities:
 *  - Discover the bridge via the handshake file (or env overrides).
 *  - Lazy-connect on first request; auto-reconnect if the socket is gone or the
 *    handshake file changed (bridge restarted with a new port/token).
 *  - Correlate request/response by id (crypto.randomUUID).
 *  - Surface typed errors on ok:false, timeout, and socket close.
 *
 * NEVER writes to stdout — that channel is reserved for MCP stdio. All diagnostics
 * go to stderr.
 */

import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import WebSocket from "ws";

import {
  DEFAULT_BRIDGE_PORT,
  HANDSHAKE_FILENAME,
  type BridgeMethod,
  type BridgeRequest,
  type BridgeResponse,
  type HandshakeFile,
} from "./protocol.js";

/** Default per-request timeout in milliseconds. */
const DEFAULT_TIMEOUT_MS = 15000;

/** Error thrown when the bridge cannot be discovered or reached. */
export class BridgeUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BridgeUnavailableError";
  }
}

/** Error carrying a bridge ok:false response (code + message). */
export class BridgeRequestError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "BridgeRequestError";
    this.code = code;
  }
}

interface PendingRequest {
  resolve: (result: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
  method: BridgeMethod;
}

/** Resolved connection target (port + token). */
interface Target {
  port: number;
  token: string;
}

function stderr(message: string): void {
  process.stderr.write(`[eez-studio-mcp] ${message}\n`);
}

export class BridgeClient {
  private ws: WebSocket | null = null;
  private connectPromise: Promise<void> | null = null;
  private readonly pending = new Map<string, PendingRequest>();

  /** Last target we connected with, used to detect handshake changes. */
  private currentTarget: Target | null = null;

  /** Absolute path to the handshake file. */
  private readonly handshakePath = path.join(os.tmpdir(), HANDSHAKE_FILENAME);

  /**
   * Read the handshake file (or env overrides) and resolve the connection target.
   * Env EEZ_MCP_BRIDGE_PORT / EEZ_MCP_BRIDGE_TOKEN override the file values.
   * Throws BridgeUnavailableError with actionable guidance if it cannot resolve.
   */
  private resolveTarget(): Target {
    const envPort = process.env.EEZ_MCP_BRIDGE_PORT;
    const envToken = process.env.EEZ_MCP_BRIDGE_TOKEN;

    let filePort: number | undefined;
    let fileToken: string | undefined;

    try {
      const raw = readFileSync(this.handshakePath, "utf8");
      const parsed = JSON.parse(raw) as Partial<HandshakeFile>;
      if (typeof parsed.port === "number") filePort = parsed.port;
      if (typeof parsed.token === "string") fileToken = parsed.token;
    } catch (err) {
      // File missing/unreadable is only fatal if env doesn't fully supply both.
      if (!(envPort && envToken)) {
        const code = (err as NodeJS.ErrnoException)?.code;
        if (code === "ENOENT") {
          throw new BridgeUnavailableError(
            "EEZ Studio with the MCP bridge is not running — launch it first. " +
              `(No handshake file at ${this.handshakePath}. If the bridge uses ` +
              "custom settings, set EEZ_MCP_BRIDGE_PORT and EEZ_MCP_BRIDGE_TOKEN.)"
          );
        }
        throw new BridgeUnavailableError(
          `Could not read the bridge handshake file at ${this.handshakePath}: ${String(err)}`
        );
      }
    }

    const port = envPort ? Number(envPort) : filePort ?? DEFAULT_BRIDGE_PORT;
    const token = envToken ?? fileToken;

    if (!Number.isFinite(port) || port <= 0) {
      throw new BridgeUnavailableError(
        `Invalid bridge port resolved (${String(port)}). Check EEZ_MCP_BRIDGE_PORT or the handshake file.`
      );
    }
    if (!token) {
      throw new BridgeUnavailableError(
        "No bridge auth token available. The bridge writes one to the handshake file; " +
          "or set EEZ_MCP_BRIDGE_TOKEN to match the running bridge."
      );
    }

    return { port, token };
  }

  /** True if we have a live, open socket to the current target. */
  private isConnected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  /**
   * Ensure a live connection to the current bridge target. Reconnects if the
   * socket is closed or the handshake target changed (bridge restarted).
   */
  private async ensureConnected(): Promise<void> {
    const target = this.resolveTarget();

    // If connected but the target changed, drop and reconnect.
    if (
      this.isConnected() &&
      this.currentTarget &&
      (this.currentTarget.port !== target.port || this.currentTarget.token !== target.token)
    ) {
      stderr("bridge handshake changed — reconnecting to the new port/token");
      this.teardown(new BridgeUnavailableError("Bridge restarted with new credentials"));
    }

    if (this.isConnected()) return;

    // Coalesce concurrent connect attempts.
    if (this.connectPromise) return this.connectPromise;

    this.connectPromise = this.connect(target).finally(() => {
      this.connectPromise = null;
    });
    return this.connectPromise;
  }

  /** Open a fresh WebSocket to the given target and wire up handlers. */
  private connect(target: Target): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const url = `ws://127.0.0.1:${target.port}?token=${encodeURIComponent(target.token)}`;
      const ws = new WebSocket(url);
      let settled = false;

      ws.on("open", () => {
        settled = true;
        this.ws = ws;
        this.currentTarget = target;
        stderr(`connected to bridge on 127.0.0.1:${target.port}`);
        resolve();
      });

      ws.on("message", (data: WebSocket.RawData) => {
        this.handleMessage(data);
      });

      ws.on("error", (err: Error) => {
        if (!settled) {
          settled = true;
          reject(this.describeConnectError(err, target));
        } else {
          stderr(`socket error: ${err.message}`);
        }
      });

      ws.on("close", (code: number) => {
        if (!settled) {
          settled = true;
          reject(this.describeConnectError(new Error(`closed with code ${code}`), target));
          return;
        }
        this.teardown(
          new BridgeUnavailableError(
            `Connection to the EEZ Studio bridge closed (code ${code}). It may have been shut down.`
          )
        );
      });
    });
  }

  /** Turn a raw connect failure into an actionable BridgeUnavailableError. */
  private describeConnectError(err: Error, target: Target): BridgeUnavailableError {
    const anyErr = err as NodeJS.ErrnoException;
    if (anyErr.code === "ECONNREFUSED") {
      return new BridgeUnavailableError(
        `Could not reach the EEZ Studio bridge at 127.0.0.1:${target.port} — is EEZ Studio running with the MCP bridge enabled?`
      );
    }
    // A 401 upgrade rejection surfaces as an "unexpected server response: 401".
    if (/401/.test(err.message)) {
      return new BridgeUnavailableError(
        "The EEZ Studio bridge rejected the auth token (HTTP 401). The handshake token may be stale — " +
          "restart EEZ Studio or fix EEZ_MCP_BRIDGE_TOKEN."
      );
    }
    return new BridgeUnavailableError(
      `Failed to connect to the EEZ Studio bridge at 127.0.0.1:${target.port}: ${err.message}`
    );
  }

  /** Handle an inbound WebSocket frame: response (has id) or event (no id). */
  private handleMessage(data: WebSocket.RawData): void {
    let msg: unknown;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      stderr("received non-JSON frame from bridge — ignoring");
      return;
    }

    if (!msg || typeof msg !== "object") return;

    // Unsolicited event (no id) — log and ignore.
    if ("event" in (msg as Record<string, unknown>) && !("id" in (msg as Record<string, unknown>))) {
      const ev = (msg as { event?: unknown }).event;
      stderr(`event: ${String(ev)}`);
      return;
    }

    const response = msg as BridgeResponse;
    if (typeof response.id !== "string") return;

    const pending = this.pending.get(response.id);
    if (!pending) {
      stderr(`response for unknown id ${response.id} — ignoring`);
      return;
    }

    this.pending.delete(response.id);
    clearTimeout(pending.timer);

    if (response.ok) {
      pending.resolve(response.result);
    } else {
      const { code, message } = response.error ?? { code: "INTERNAL", message: "Unknown bridge error" };
      pending.reject(new BridgeRequestError(String(code), String(message)));
    }
  }

  /** Reject all in-flight requests and drop the socket. */
  private teardown(reason: Error): void {
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(reason);
    }
    this.pending.clear();

    if (this.ws) {
      try {
        this.ws.removeAllListeners();
        if (
          this.ws.readyState === WebSocket.OPEN ||
          this.ws.readyState === WebSocket.CONNECTING
        ) {
          this.ws.close();
        }
      } catch {
        // best-effort
      }
      this.ws = null;
    }
    this.currentTarget = null;
  }

  /**
   * Send a request and resolve with its typed result. Rejects with:
   *  - BridgeUnavailableError on discovery/connect failure or socket close
   *  - BridgeRequestError on an ok:false response
   *  - Error on timeout
   */
  async request<T = unknown>(
    method: BridgeMethod,
    params: Record<string, unknown> = {},
    timeoutMs: number = DEFAULT_TIMEOUT_MS
  ): Promise<T> {
    await this.ensureConnected();

    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      throw new BridgeUnavailableError(
        "Lost the connection to the EEZ Studio bridge before sending the request."
      );
    }

    const id = randomUUID();
    const payload: BridgeRequest = { id, method, params };

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new Error(
            `Bridge request "${method}" timed out after ${timeoutMs}ms — the EEZ Studio bridge did not respond.`
          )
        );
      }, timeoutMs);

      this.pending.set(id, {
        resolve: resolve as (result: unknown) => void,
        reject,
        timer,
        method,
      });

      try {
        ws.send(JSON.stringify(payload), (err) => {
          if (err) {
            this.pending.delete(id);
            clearTimeout(timer);
            reject(
              new BridgeUnavailableError(`Failed to send "${method}" to the bridge: ${err.message}`)
            );
          }
        });
      } catch (err) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(
          new BridgeUnavailableError(
            `Failed to send "${method}" to the bridge: ${(err as Error).message}`
          )
        );
      }
    });
  }

  /** Close the connection and reject any in-flight requests. */
  close(): void {
    this.teardown(new BridgeUnavailableError("BridgeClient closed"));
  }
}
