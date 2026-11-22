/** Private object storage behind presigned URLs (CLAUDE.md §3: PUT 5 min, GET 5 min). */
export interface ObjectStorage {
  /** `origin`: the public origin the caller reached the API on; only stores that serve files through the API use it. */
  presignPut(key: string, contentType: string, sizeBytes: number, sha256Base64: string, origin?: string): Promise<{ url: string; headers: Record<string, string> }>;
  presignGet(key: string, origin?: string): Promise<string>;
  exists(key: string): Promise<boolean>;
  /** Server-side write (generated exports). Client uploads always go through presignPut. */
  put(key: string, body: Uint8Array, contentType: string): Promise<void>;
  /** Server-side read (copying a photo to Cloudinary, ADR-050); null when the object does not exist. */
  get(key: string): Promise<{ body: Uint8Array; contentType: string } | null>;
  /** Removes the object; a missing object is not an error, so a delete can be repeated. */
  delete(key: string): Promise<void>;
}
export const URL_TTL_SEC = 300;
