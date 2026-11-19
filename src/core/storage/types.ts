/** Private object storage behind presigned URLs (CLAUDE.md §3: PUT 5 min, GET 5 min). */
export interface ObjectStorage {
  presignPut(key: string, contentType: string, sizeBytes: number, sha256Base64: string): Promise<{ url: string; headers: Record<string, string> }>;
  presignGet(key: string): Promise<string>;
  exists(key: string): Promise<boolean>;
  /** Server-side write (generated exports). Client uploads always go through presignPut. */
  put(key: string, body: Uint8Array, contentType: string): Promise<void>;
}
export const URL_TTL_SEC = 300;
