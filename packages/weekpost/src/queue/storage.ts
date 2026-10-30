// Supabase Storage through REST, with the same key rules as the Db adapter.
//   POST /storage/v1/object/<bucket>/<path> with x-upsert: false (the path is the content hash; an existing object counts as uploaded)
//   POST /storage/v1/object/sign/<bucket> {expiresIn, paths}; DELETE /storage/v1/object/<bucket> {prefixes}
//   POST /storage/v1/bucket
import { baseUrl, authHeaders, isBucketPath, request, SupabaseError } from "./supabase.ts";
import type { Fetch, Storage } from "./types.ts";

export const MAX_FILE_BYTES = 50 * 1024 * 1024;

export interface SupabaseStorage extends Storage {
  /** Creates the private bucket when missing. Safe to call every time. */
  ensureBucket(): Promise<void>;
}

function assertPath(p: string): void {
  if (!isBucketPath(p)) throw new Error(`invalid storage path: ${p}`);
}

export function supabaseStorage(url: string, key: string, bucket: string, fetchFn: Fetch = fetch): SupabaseStorage {
  const base = baseUrl(url);
  authHeaders(key); // fail early, before any request
  const req = (path: string, init?: RequestInit) => request(fetchFn, base, key, path, init);
  const objectPath = (p: string) => p.split("/").map(encodeURIComponent).join("/");

  return {
    async put(path, bytes, contentType) {
      assertPath(path);
      // The path carries the sha-256 of the bytes, so an existing object is the same file: success, not an error.
      try {
        await req(`/storage/v1/object/${bucket}/${objectPath(path)}`, {
          method: "POST",
          headers: { "content-type": contentType, "x-upsert": "false" },
          body: bytes as BodyInit,
        });
      } catch (e) {
        if (e instanceof SupabaseError && (e.status === 409 || /already exists|Duplicate/i.test(e.message))) return;
        throw e;
      }
    },
    async sign(paths, ttlSeconds) {
      paths.forEach(assertPath);
      const { body } = await req(`/storage/v1/object/sign/${bucket}`, {
        method: "POST",
        body: JSON.stringify({ expiresIn: ttlSeconds, paths }),
      });
      const out = body as { path: string; error: string | null; signedURL: string | null }[];
      return paths.map((path) => {
        const hit = out.find((o) => o.path === path);
        if (!hit?.signedURL) throw new Error(`media not found in the bucket: ${path}${hit?.error ? ` (${hit.error})` : ""}`);
        return `${base}/storage/v1${hit.signedURL}`;
      });
    },
    async remove(paths) {
      if (!paths.length) return;
      paths.forEach(assertPath);
      await req(`/storage/v1/object/${bucket}`, { method: "DELETE", body: JSON.stringify({ prefixes: paths }) });
    },
    async ensureBucket() {
      try {
        await req("/storage/v1/bucket", {
          method: "POST",
          body: JSON.stringify({
            id: bucket, name: bucket, public: false,
            file_size_limit: MAX_FILE_BYTES, allowed_mime_types: ["image/jpeg", "video/mp4"],
          }),
        });
      } catch (e) {
        // Already there: the API answers 409 (some versions wrap it in a 400 body with statusCode 409).
        if (e instanceof SupabaseError && (e.status === 409 || /already exists|Duplicate/i.test(e.message))) return;
        throw e;
      }
    },
  };
}
