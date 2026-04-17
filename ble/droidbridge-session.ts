import type { IncomingMessage } from "node:http";
import WebSocket from "ws";

import { decodeAsyncEvent } from "./events";
import type { DecodedEvent } from "./events";
import { FLAG_REQUEST, framePb, parseFrame } from "./envelope";
import type { ParsedFrame } from "./envelope";
import { PRELUDE_F5872, PRELUDE_F5872_SEQ, PRELUDE_F5872_SID } from "./messages";
import type { G2SessionLike, G2SessionOptions } from "./session";

const NAME_RE = /(?:even\s+)?G\d+_(\d+)_([LR])_/i;
const WRITE_CHAR_UUID = "00002760-08c2-11e1-9073-0e8ac72e5401";
const NOTIFY_CHAR_UUID = "00002760-08c2-11e1-9073-0e8ac72e5402";
const RENDER_NOTIFY_UUID = "00002760-08c2-11e1-9073-0e8ac72e6402";

type ArmSide = "L" | "R";
type Json = Record<string, unknown>;

interface DroidBridgeSessionOptions extends G2SessionOptions {
  baseUrl: string;
  bearerToken?: string;
  leftAddress?: string;
  rightAddress?: string;
  preferBonded?: boolean;
  scanTimeoutMs?: number;
  connectTimeoutMs?: number;
  servicesTimeoutMs?: number;
}

interface ScanEvent {
  address: string;
  name?: string;
  rssi?: number;
}

interface ConnectionEvent {
  address: string;
  connected: boolean;
}

interface ServiceInfo {
  uuid: string;
  characteristics: Array<{
    uuid: string;
    properties: number;
    descriptors: string[];
  }>;
}

interface BondedDevice {
  address: string;
  name: string;
  type: string;
}

interface ArmTransport {
  side: ArmSide;
  address: string;
  contentService: string;
  renderService: string | null;
  waiters: Map<string, (frame: ParsedFrame) => void>;
}

function ts(): string {
  const t = new Date();
  return `${t.toISOString().slice(11, 19)}.${String(t.getMilliseconds()).padStart(3, "0")}`;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeUuid(uuid: string): string {
  const compact = uuid.toLowerCase().replace(/-/g, "");
  if (compact.length !== 32) return compact;
  return `${compact.slice(0, 8)}-${compact.slice(8, 12)}-${compact.slice(12, 16)}-${compact.slice(16, 20)}-${compact.slice(20)}`;
}

function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) throw new Error(`invalid hex length ${hex.length}`);
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  }
  return bytes;
}

function bytesToHex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("hex");
}

function toWsUrl(baseUrl: string): string {
  if (baseUrl.startsWith("https://")) return `wss://${baseUrl.slice("https://".length)}`;
  if (baseUrl.startsWith("http://")) return `ws://${baseUrl.slice("http://".length)}`;
  throw new Error(`baseUrl must start with http:// or https://, got ${baseUrl}`);
}

export class DroidBridgeSession implements G2SessionLike {
  readonly left: ArmTransport;
  readonly right: ArmTransport;

  private readonly baseUrl: string;
  private readonly wsUrl: string;
  private readonly authHeader: string | null;
  private readonly quiet: boolean;

  private ws: WebSocket;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private transportSeq = 0x40;
  private closed = false;

  private readonly rawListeners = new Set<(frame: ParsedFrame, raw: Uint8Array, arm: ArmSide) => void>();
  private readonly renderListeners = new Set<(data: Uint8Array, arm: ArmSide) => void>();
  private readonly scanListeners = new Set<(event: ScanEvent) => void>();
  private readonly connectionListeners = new Set<(event: ConnectionEvent) => void>();

  private constructor(
    opts: DroidBridgeSessionOptions,
    ws: WebSocket,
    left: ArmTransport,
    right: ArmTransport,
  ) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.wsUrl = toWsUrl(this.baseUrl);
    this.authHeader = opts.bearerToken?.trim() ? `Bearer ${opts.bearerToken.trim()}` : null;
    this.quiet = opts.quiet ?? false;
    this.ws = ws;
    this.left = left;
    this.right = right;
  }

  static async open(opts: DroidBridgeSessionOptions): Promise<DroidBridgeSession> {
    const baseUrl = opts.baseUrl.replace(/\/+$/, "");
    const wsUrl = toWsUrl(baseUrl);
    const authHeader = opts.bearerToken?.trim() ? `Bearer ${opts.bearerToken.trim()}` : null;
    const quiet = opts.quiet ?? false;

    if (!quiet) console.log(`[${ts()}] droidbridge-session: opening websocket ${wsUrl}`);
    const ws = await openWebSocket(wsUrl, authHeader);

    const scratch = new DroidBridgeSession(
      { ...opts, baseUrl, bearerToken: opts.bearerToken, quiet },
      ws,
      {
        side: "L",
        address: "",
        contentService: "",
        renderService: null,
        waiters: new Map(),
      },
      {
        side: "R",
        address: "",
        contentService: "",
        renderService: null,
        waiters: new Map(),
      },
    );
    scratch.attachSocket();

    const scanTimeoutMs = opts.scanTimeoutMs ?? 20_000;
    const connectTimeoutMs = opts.connectTimeoutMs ?? 10_000;
    const servicesTimeoutMs = opts.servicesTimeoutMs ?? 10_000;

    const found = await scratch.resolveArmTargets(opts, scanTimeoutMs);

    if (!quiet) console.log(`[${ts()}] droidbridge-session: connect right ${found.R.address}`);
    const right = await scratch.connectArm("R", found.R.address, connectTimeoutMs, servicesTimeoutMs);

    if (!quiet) console.log(`[${ts()}] droidbridge-session: connect left ${found.L.address}`);
    const left = await scratch.connectArm("L", found.L.address, connectTimeoutMs, servicesTimeoutMs);

    scratch.right.address = right.address;
    scratch.right.contentService = right.contentService;
    scratch.right.renderService = right.renderService;

    scratch.left.address = left.address;
    scratch.left.contentService = left.contentService;
    scratch.left.renderService = left.renderService;

    if (!quiet) console.log(`[${ts()}] droidbridge-session: connected, settling 800ms`);
    await delay(800);

    if (opts.sendPrelude ?? true) {
      if (!quiet) console.log(`[${ts()}] droidbridge-session: prelude f5872`);
      const ack = scratch.waitForAck("R", PRELUDE_F5872_SID, PRELUDE_F5872_SEQ, opts.preludeTimeoutMs ?? 5000);
      await scratch.writeRaw("R", PRELUDE_F5872);
      if (!(await ack)) {
        await scratch.close();
        throw new Error("droidbridge-session: prelude ack timeout");
      }
    }

    return scratch;
  }

  async sendPb(
    sid: number,
    pb: Uint8Array,
    magic: number,
    opts: { flag?: number; ackTimeoutMs?: number; arm?: ArmSide } = {},
  ): Promise<ParsedFrame | null> {
    const flag = opts.flag ?? FLAG_REQUEST;
    const side = opts.arm ?? "R";
    const seq = this.transportSeq;
    this.transportSeq = (this.transportSeq + 1) & 0xff;

    const frames = framePb(pb, { seq, sid, flag });
    const ack = this.waitForAck(side, sid, magic, opts.ackTimeoutMs ?? 5000);
    await this.writeFrames(side, frames);
    return ack;
  }

  async sendPbPipelined(
    sid: number,
    pb: Uint8Array,
    magic: number,
    opts: { flag?: number; ackTimeoutMs?: number; arm?: ArmSide } = {},
  ): Promise<{ ack: Promise<ParsedFrame | null> }> {
    const flag = opts.flag ?? FLAG_REQUEST;
    const side = opts.arm ?? "R";
    const seq = this.transportSeq;
    this.transportSeq = (this.transportSeq + 1) & 0xff;

    const frames = framePb(pb, { seq, sid, flag });
    const ack = this.waitForAck(side, sid, magic, opts.ackTimeoutMs ?? 5000);
    await this.writeFrames(side, frames);
    return { ack };
  }

  onEvent(fn: (ev: DecodedEvent, frame: ParsedFrame) => void): () => void {
    return this.onRawFrame((frame, _raw, arm) => {
      if (arm !== "R" || !frame.ok) return;
      if (frame.flag !== 0x01 && frame.flag !== 0x06) return;
      fn(decodeAsyncEvent(frame.sid, frame.flag, frame.pb), frame);
    });
  }

  onRawFrame(fn: (frame: ParsedFrame, raw: Uint8Array, arm: ArmSide) => void): () => void {
    this.rawListeners.add(fn);
    return () => {
      this.rawListeners.delete(fn);
    };
  }

  onRender(fn: (data: Uint8Array, arm: ArmSide) => void): () => void {
    this.renderListeners.add(fn);
    return () => {
      this.renderListeners.delete(fn);
    };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;

    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }

    const disconnects: Promise<unknown>[] = [];
    if (this.right.address) disconnects.push(this.safeDisconnect(this.right.address));
    if (this.left.address && this.left.address !== this.right.address) disconnects.push(this.safeDisconnect(this.left.address));
    await Promise.all(disconnects);

    await new Promise<void>((resolve) => {
      this.ws.once("close", () => resolve());
      this.ws.close();
      setTimeout(resolve, 1000);
    });
  }

  private attachSocket(): void {
    this.ws.on("message", (data: WebSocket.RawData) => {
      try {
        const text = typeof data === "string" ? data : data.toString();
        const msg = JSON.parse(text) as { type?: string; data?: Json };
        this.handleWsMessage(msg);
      } catch (error) {
        if (!this.quiet) console.error(`[${ts()}] droidbridge-session: websocket decode error`, error);
      }
    });

    this.ws.on("close", () => {
      if (this.pingTimer) {
        clearInterval(this.pingTimer);
        this.pingTimer = null;
      }
      if (!this.closed && !this.quiet) {
        console.error(`[${ts()}] droidbridge-session: websocket closed`);
      }
    });

    this.ws.on("error", (error: Error) => {
      if (!this.closed && !this.quiet) {
        console.error(`[${ts()}] droidbridge-session: websocket error`, error);
      }
    });

    this.pingTimer = setInterval(() => {
      if (this.ws.readyState === WebSocket.OPEN) {
        this.ws.send("ping");
      }
    }, 1500);
  }

  private handleWsMessage(msg: { type?: string; data?: Json }): void {
    switch (msg.type) {
      case "scan": {
        const address = String(msg.data?.address ?? "");
        const name = msg.data?.name ? String(msg.data.name) : undefined;
        const rssi = typeof msg.data?.rssi === "number" ? msg.data.rssi : undefined;
        const event: ScanEvent = { address, name, rssi };
        for (const listener of this.scanListeners) listener(event);
        return;
      }
      case "connection": {
        const address = String(msg.data?.address ?? "");
        const connected = Boolean(msg.data?.connected);
        const event: ConnectionEvent = { address, connected };
        for (const listener of this.connectionListeners) listener(event);
        return;
      }
      case "notification": {
        const address = String(msg.data?.address ?? "");
        const characteristic = normalizeUuid(String(msg.data?.characteristic ?? ""));
        const dataHex = String(msg.data?.data ?? "");
        if (!address || !characteristic || !dataHex) return;
        this.handleNotification(address, characteristic, hexToBytes(dataHex));
        return;
      }
      default:
        return;
    }
  }

  private handleNotification(address: string, characteristic: string, data: Uint8Array): void {
    const side = this.addressToSide(address);
    if (!side) return;

    if (characteristic === normalizeUuid(NOTIFY_CHAR_UUID)) {
      const frame = parseFrame(data);
      const arm = this.arm(side);
      if (frame.ok && frame.msgSeq !== undefined) {
        const key = `${frame.sid}:${frame.msgSeq}`;
        const waiter = arm.waiters.get(key);
        if (waiter) {
          arm.waiters.delete(key);
          waiter(frame);
        }
      }
      for (const listener of this.rawListeners) {
        try {
          listener(frame, data, side);
        } catch (error) {
          console.error(`[${ts()}] droidbridge-session: raw listener`, error);
        }
      }
      return;
    }

    if (characteristic === normalizeUuid(RENDER_NOTIFY_UUID)) {
      for (const listener of this.renderListeners) {
        try {
          listener(data, side);
        } catch (error) {
          console.error(`[${ts()}] droidbridge-session: render listener`, error);
        }
      }
    }
  }

  private async findBothArms(timeoutMs: number): Promise<Record<ArmSide, ScanEvent>> {
    const seen = new Map<ArmSide, ScanEvent>();

    const found = new Promise<Record<ArmSide, ScanEvent>>((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error("droidbridge-session: scan timeout waiting for both arms"));
      }, timeoutMs);

      const listener = (event: ScanEvent) => {
        if (!event.name) return;
        const match = NAME_RE.exec(event.name);
        if (!match) return;
        const side = match[2]!.toUpperCase() as ArmSide;
        if (!seen.has(side)) {
          seen.set(side, event);
          if (!this.quiet) console.log(`[${ts()}] droidbridge-session: saw ${side} ${event.address}`);
        }
        if (seen.has("L") && seen.has("R")) {
          cleanup();
          resolve({
            L: seen.get("L")!,
            R: seen.get("R")!,
          });
        }
      };

      const cleanup = () => {
        clearTimeout(timer);
        this.scanListeners.delete(listener);
      };

      this.scanListeners.add(listener);
    });

    await this.request("/scan/start", {
      method: "POST",
      body: {},
    });

    try {
      return await found;
    } finally {
      await this.request("/scan/stop", {
        method: "POST",
        body: {},
      }).catch(() => {});
    }
  }

  private async resolveArmTargets(
    opts: DroidBridgeSessionOptions,
    scanTimeoutMs: number,
  ): Promise<Record<ArmSide, ScanEvent>> {
    const targets: Partial<Record<ArmSide, ScanEvent>> = {};

    if (opts.leftAddress?.trim()) {
      targets.L = { address: opts.leftAddress.trim() };
    }
    if (opts.rightAddress?.trim()) {
      targets.R = { address: opts.rightAddress.trim() };
    }

    if (opts.preferBonded ?? true) {
      const bonded = await this.findBondedArms();
      if (!targets.L && bonded.L) targets.L = bonded.L;
      if (!targets.R && bonded.R) targets.R = bonded.R;
    }

    if (targets.L && targets.R) {
      if (!this.quiet) {
        console.log(
          `[${ts()}] droidbridge-session: using known arms L=${targets.L.address} R=${targets.R.address}`,
        );
      }
      return {
        L: targets.L,
        R: targets.R,
      };
    }

    if (!this.quiet) console.log(`[${ts()}] droidbridge-session: scanning for missing arms`);
    const scanned = await this.findBothArms(scanTimeoutMs);
    return {
      L: targets.L ?? scanned.L,
      R: targets.R ?? scanned.R,
    };
  }

  private async findBondedArms(): Promise<Partial<Record<ArmSide, ScanEvent>>> {
    const bonded = await this.request<BondedDevice[]>("/bonded", {
      method: "GET",
      parse: (body) => ((body.devices as BondedDevice[] | undefined) ?? []),
    });

    const bySide = new Map<ArmSide, BondedDevice[]>();
    for (const device of bonded) {
      const match = NAME_RE.exec(device.name ?? "");
      if (!match) continue;
      const side = match[2]!.toUpperCase() as ArmSide;
      const bucket = bySide.get(side) ?? [];
      bucket.push(device);
      bySide.set(side, bucket);
    }

    const result: Partial<Record<ArmSide, ScanEvent>> = {};
    for (const side of ["L", "R"] as const) {
      const matches = bySide.get(side) ?? [];
      if (matches.length === 1) {
        result[side] = {
          address: matches[0]!.address,
          name: matches[0]!.name,
        };
      } else if (matches.length > 1 && !this.quiet) {
        console.warn(
          `[${ts()}] droidbridge-session: multiple bonded ${side} arms found; set explicit addresses to avoid ambiguity`,
        );
      }
    }

    return result;
  }

  private async connectArm(
    side: ArmSide,
    address: string,
    connectTimeoutMs: number,
    servicesTimeoutMs: number,
  ): Promise<Omit<ArmTransport, "waiters">> {
    const connected = this.waitForConnection(address, true, connectTimeoutMs);
    await this.request("/connect", {
      method: "POST",
      body: { address },
    });
    await connected;

    await this.request("/discover", {
      method: "POST",
      body: { address },
    });

    const services = await this.waitForServices(address, servicesTimeoutMs);
    const contentService = this.findServiceForCharacteristic(services, WRITE_CHAR_UUID);
    if (!contentService) {
      throw new Error(`${side}: content service missing for ${address}`);
    }
    const renderService = this.findServiceForCharacteristic(services, RENDER_NOTIFY_UUID);

    await this.request("/notify", {
      method: "POST",
      body: {
        address,
        service: contentService,
        characteristic: NOTIFY_CHAR_UUID,
        enable: true,
      },
    });

    if (renderService) {
      await this.request("/notify", {
        method: "POST",
        body: {
          address,
          service: renderService,
          characteristic: RENDER_NOTIFY_UUID,
          enable: true,
        },
      });
    }

    return {
      side,
      address,
      contentService,
      renderService,
    };
  }

  private waitForAck(side: ArmSide, sid: number, seq: number, timeoutMs: number): Promise<ParsedFrame | null> {
    const arm = this.arm(side);
    return new Promise((resolve) => {
      const key = `${sid}:${seq}`;
      const timer = setTimeout(() => {
        arm.waiters.delete(key);
        resolve(null);
      }, timeoutMs);
      arm.waiters.set(key, (frame) => {
        clearTimeout(timer);
        resolve(frame);
      });
    });
  }

  private async writeFrames(side: ArmSide, frames: Uint8Array[]): Promise<void> {
    for (const frame of frames) {
      await this.writeRaw(side, frame);
    }
  }

  private async writeRaw(side: ArmSide, data: Uint8Array): Promise<void> {
    const arm = this.arm(side);
    if (!arm.address || !arm.contentService) {
      throw new Error(`${side}: arm not connected`);
    }
    await this.request("/write", {
      method: "POST",
      body: {
        address: arm.address,
        service: arm.contentService,
        characteristic: WRITE_CHAR_UUID,
        data: bytesToHex(data),
        writeType: 1,
      },
    });
  }

  private arm(side: ArmSide): ArmTransport {
    return side === "R" ? this.right : this.left;
  }

  private addressToSide(address: string): ArmSide | null {
    if (address === this.right.address) return "R";
    if (address === this.left.address) return "L";
    return null;
  }

  private async waitForConnection(address: string, connected: boolean, timeoutMs: number): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`timeout waiting for ${address} connected=${connected}`));
      }, timeoutMs);

      const listener = (event: ConnectionEvent) => {
        if (event.address === address && event.connected === connected) {
          cleanup();
          resolve();
        }
      };

      const cleanup = () => {
        clearTimeout(timer);
        this.connectionListeners.delete(listener);
      };

      this.connectionListeners.add(listener);
    });
  }

  private async waitForServices(address: string, timeoutMs: number): Promise<ServiceInfo[]> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const services = await this.request<ServiceInfo[] | null>(`/services/${encodeURIComponent(address)}`, {
        method: "GET",
        allowNotFound: true,
        parse: (body) => (body.services as ServiceInfo[]) ?? null,
      });
      if (services && services.length > 0) return services;
      await delay(250);
    }
    throw new Error(`timeout waiting for services for ${address}`);
  }

  private findServiceForCharacteristic(services: ServiceInfo[], characteristicUuid: string): string | null {
    const want = normalizeUuid(characteristicUuid);
    for (const service of services) {
      for (const characteristic of service.characteristics) {
        if (normalizeUuid(characteristic.uuid) === want) {
          return service.uuid;
        }
      }
    }
    return null;
  }

  private async safeDisconnect(address: string): Promise<void> {
    await this.request("/disconnect", {
      method: "POST",
      body: { address },
    }).catch(() => {});
  }

  private async request<T = Json>(
    path: string,
    opts: {
      method: "GET" | "POST";
      body?: Json;
      allowNotFound?: boolean;
      parse?: (body: Json) => T;
    },
  ): Promise<T> {
    const headers: Record<string, string> = {};
    if (this.authHeader) headers.Authorization = this.authHeader;
    if (opts.body !== undefined) headers["Content-Type"] = "application/json";

    const response = await fetch(`${this.baseUrl}${path}`, {
      method: opts.method,
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });

    if (opts.allowNotFound && response.status === 404) {
      return null as T;
    }

    const text = await response.text();
    const payload = text ? (JSON.parse(text) as Json) : {};

    if (!response.ok) {
      const detail = typeof payload.error === "string" ? payload.error : response.statusText;
      throw new Error(`${opts.method} ${path} failed: ${detail}`);
    }

    return opts.parse ? opts.parse(payload) : (payload as T);
  }
}

async function openWebSocket(url: string, authHeader: string | null): Promise<WebSocket> {
  return await new Promise<WebSocket>((resolve, reject) => {
    const ws = new WebSocket(url, {
      headers: authHeader ? { Authorization: authHeader } : undefined,
    });

    const cleanup = () => {
      ws.removeAllListeners("open");
      ws.removeAllListeners("unexpected-response");
      ws.removeAllListeners("error");
    };

    ws.once("open", () => {
      cleanup();
      resolve(ws);
    });

    ws.once("unexpected-response", async (_req: unknown, res: IncomingMessage) => {
      cleanup();
      let body = "";
      res.on("data", (chunk: Buffer) => {
        body += chunk.toString();
      });
      res.on("end", () => {
        reject(new Error(`websocket upgrade failed: ${res.statusCode} ${body}`));
      });
    });

    ws.once("error", (error: Error) => {
      cleanup();
      reject(error);
    });
  });
}
