/**
 * TEMP: [voice-dbg-client] — wraps the default @cloudflare/voice WebSocket transport
 * to count non-JSON (binary) inbound frames. Remove this file and its import when
 * done debugging.
 *
 * Grep: [voice-dbg-client] ws_inbound
 */

import { WebSocketVoiceTransport } from "@cloudflare/voice/client";

export const VOICE_CLIENT_DBG = true;

const TAG = "[voice-dbg-client]";

type TransportOptions = {
  agent: string;
  name?: string;
  host?: string;
  query?: Record<string, string | null | undefined>;
};

/**
 * Same wire behavior as the SDK default, plus console logs for each binary
 * (or blob) message from the server — typically TTS audio chunks.
 */
export function createDebugWrappingTransport(
  options: TransportOptions
): Pick<
  WebSocketVoiceTransport,
  "connect" | "disconnect" | "sendJSON" | "sendBinary" | "connected"
> & {
  onopen: (() => void) | null;
  onclose: (() => void) | null;
  onerror: ((error?: unknown) => void) | null;
  onmessage: ((data: string | ArrayBuffer | Blob) => void) | null;
} {
  const inner = new WebSocketVoiceTransport(options);
  let binN = 0;
  let cumBytes = 0;

  let oOpen: (() => void) | null = null;
  let oClose: (() => void) | null = null;
  let oErr: ((e?: unknown) => void) | null = null;
  let oMsg: ((data: string | ArrayBuffer | Blob) => void) | null = null;

  return {
    get connected() {
      return inner.connected;
    },
    sendJSON(data: Record<string, unknown>) {
      inner.sendJSON(data);
    },
    sendBinary(data: ArrayBuffer) {
      inner.sendBinary(data);
    },
    connect() {
      inner.onopen = () => oOpen?.();
      inner.onclose = () => oClose?.();
      inner.onerror = (e) => oErr?.(e);
      inner.onmessage = (data) => {
        if (data instanceof ArrayBuffer) {
          binN += 1;
          cumBytes += data.byteLength;
          console.info(
            `${TAG} ws_inbound kind=buffer n=${binN} bytes=${data.byteLength} cumBytes=${cumBytes}`
          );
          oMsg?.(data);
          return;
        }
        if (data instanceof Blob) {
          void data.arrayBuffer().then((b) => {
            binN += 1;
            cumBytes += b.byteLength;
            console.info(
              `${TAG} ws_inbound kind=blob n=${binN} bytes=${b.byteLength} cumBytes=${cumBytes}`
            );
          });
          oMsg?.(data);
          return;
        }
        oMsg?.(data);
      };
      console.info(
        `${TAG} transport_connect agent=${options.agent} name=${options.name ?? "default"} ` +
          `host=${options.host ?? "(default)"}`
      );
      inner.connect();
    },
    disconnect() {
      console.info(
        `${TAG} transport_disconnect binN=${binN} cumBytes=${cumBytes} connected=${inner.connected}`
      );
      inner.disconnect();
    },
    get onopen() {
      return oOpen;
    },
    set onopen(fn: (() => void) | null) {
      oOpen = fn;
    },
    get onclose() {
      return oClose;
    },
    set onclose(fn: (() => void) | null) {
      oClose = fn;
    },
    get onerror() {
      return oErr;
    },
    set onerror(fn: ((e?: unknown) => void) | null) {
      oErr = fn;
    },
    get onmessage() {
      return oMsg;
    },
    set onmessage(fn: ((data: string | ArrayBuffer | Blob) => void) | null) {
      oMsg = fn;
    },
  };
}
