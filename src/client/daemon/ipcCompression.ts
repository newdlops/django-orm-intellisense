// 옵션 C — IPC envelope (gzip+base64) unwrap 헬퍼.
// vscode 모듈 의존성 없이 standalone 으로 테스트 가능하도록 분리.

import * as zlib from 'zlib';

export interface CompressedEnvelope {
  _enc: 'gzip+b64';
  data: string;
}

/**
 * Decompress a gzip+base64 envelope into a parsed JSON object.
 *
 * Captain log.txt initialize 22MB payload 가 ~2MB envelope 으로 압축되어
 * stdout pipe write + JSON.parse 비용을 모두 절감. gunzipSync 는 sync 라
 * receive 시점에 즉시 처리.
 *
 * Returns `undefined` for corrupt / invalid input — caller should fall back
 * to logging the failure so the daemon channel stays robust.
 */
export function decompressIpcEnvelope<T = unknown>(
  base64Data: string,
  logInfo: (msg: string) => void = () => {},
): T | undefined {
  if (!base64Data) {
    return undefined;
  }
  try {
    const buf = Buffer.from(base64Data, 'base64');
    const decompressed = zlib.gunzipSync(buf);
    return JSON.parse(decompressed.toString('utf8')) as T;
  } catch (error) {
    logInfo(
      `[ipc:decompress] failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    return undefined;
  }
}

/** Type guard: 메시지가 압축 envelope 인지 식별. */
export function isCompressedEnvelope(message: unknown): message is CompressedEnvelope {
  if (typeof message !== 'object' || message === null) {
    return false;
  }
  const obj = message as Record<string, unknown>;
  return obj._enc === 'gzip+b64' && typeof obj.data === 'string';
}
