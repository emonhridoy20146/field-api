import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { CloudinaryClient, cloudinaryFromConfig, signParams, type FetchLike } from '../storage/cloudinary.js';
import { cloudinaryConfigured, loadConfig } from '../config/index.js';

const now = () => new Date('2026-11-22T06:00:00Z');

describe('Cloudinary (ADR-050)', () => {
  it('signs like the Cloudinary documentation example', () => {
    // https://cloudinary.com/documentation/signatures (example with secret "abcd")
    const sig = signParams({ eager: 'w_400,h_300,c_pad|w_260,h_200,c_crop', public_id: 'sample_image', timestamp: 1315060510, api_key: '1234', file: 'x' }, 'abcd');
    expect(sig).toBe('bfd09f95f331f558cbd1320e67aa8d488770583e');
  });

  it('is on only when cloud name, key and secret are all set; the folder defaults to fos', () => {
    expect(cloudinaryConfigured(loadConfig({ NODE_ENV: 'test' }))).toBe(false);
    expect(cloudinaryConfigured(loadConfig({ NODE_ENV: 'test', CLOUDINARY_CLOUD_NAME: 'demo', CLOUDINARY_API_KEY: 'k' }))).toBe(false);
    expect(cloudinaryConfigured(loadConfig({ NODE_ENV: 'test', CLOUDINARY_CLOUD_NAME: 'demo', CLOUDINARY_API_KEY: 'k', CLOUDINARY_API_SECRET: '' }))).toBe(false);
    const on = loadConfig({ NODE_ENV: 'test', CLOUDINARY_CLOUD_NAME: 'demo', CLOUDINARY_API_KEY: 'k', CLOUDINARY_API_SECRET: 's' });
    expect(cloudinaryConfigured(on)).toBe(true);
    expect(on.CLOUDINARY_FOLDER).toBe('fos');
    expect(cloudinaryFromConfig(on, now)?.folder).toBe('fos');
    expect(cloudinaryFromConfig(loadConfig({ NODE_ENV: 'test' }), now)).toBeNull();
    expect(() => loadConfig({ NODE_ENV: 'test', CLOUDINARY_FOLDER: '../x' })).toThrow();
  });

  it('builds a private download link that expires after 5 minutes, signed without the key', () => {
    const c = new CloudinaryClient({ cloudName: 'demo', apiKey: 'key1', apiSecret: 'sec', folder: 'fos', now });
    const { url, expiresAt } = c.downloadUrl('fos/selfie/u1/abc', 'jpg');
    const u = new URL(url);
    expect(`${u.origin}${u.pathname}`).toBe('https://api.cloudinary.com/v1_1/demo/image/download');
    const ts = Math.floor(now().getTime() / 1000);
    expect(Object.fromEntries(u.searchParams)).toMatchObject({ public_id: 'fos/selfie/u1/abc', format: 'jpg', type: 'authenticated', timestamp: String(ts), expires_at: String(ts + 300), api_key: 'key1' });
    const want = createHash('sha1').update(`expires_at=${ts + 300}&format=jpg&public_id=fos/selfie/u1/abc&timestamp=${ts}&type=authenticated` + 'sec').digest('hex');
    expect(u.searchParams.get('signature')).toBe(want);
    expect(url).not.toContain('sec');
    expect(expiresAt.getTime() - now().getTime()).toBe(300_000);
    expect(c.publicIdFor('selfie/u1/abc.jpg')).toBe('fos/selfie/u1/abc');
  });

  it('uploads signed and authenticated; deletes in bulk with invalidate; errors carry no secret', async () => {
    const calls: { url: string; method?: string | undefined; headers?: Record<string, string> | undefined; body?: FormData | string | undefined }[] = [];
    let fail = false;
    const fetch: FetchLike = async (url, init) => {
      calls.push({ url, method: init?.method, headers: init?.headers, body: init?.body });
      if (fail) return { ok: false, status: 500, json: async () => ({ error: { message: 'down' } }) };
      return { ok: true, status: 200, json: async () => (url.includes('/upload') ? { public_id: 'fos/a', version: 7, bytes: 3, format: 'jpg' } : { deleted: {} }) };
    };
    const c = new CloudinaryClient({ cloudName: 'demo', apiKey: 'key1', apiSecret: 'topsecret', folder: 'fos', now, fetch });
    expect(await c.upload(new Uint8Array([1, 2, 3]), 'image/jpeg', 'fos/a')).toEqual({ publicId: 'fos/a', version: 7, bytes: 3, format: 'jpg' });
    const form = calls[0]!.body as FormData;
    expect(calls[0]!.url).toBe('https://api.cloudinary.com/v1_1/demo/image/upload');
    expect(form.get('type')).toBe('authenticated');
    expect(form.get('api_key')).toBe('key1');
    expect(form.get('signature')).toBe(signParams({ public_id: 'fos/a', timestamp: Math.floor(now().getTime() / 1000), type: 'authenticated', overwrite: 'true' }, 'topsecret'));
    expect([...form.values()].some((v) => v === 'topsecret')).toBe(false);
    await c.deleteMany(['fos/a', 'fos/b']);
    const del = new URL(calls[1]!.url);
    expect(calls[1]!.method).toBe('DELETE');
    expect(del.pathname).toBe('/v1_1/demo/resources/image/authenticated');
    expect(del.searchParams.getAll('public_ids[]')).toEqual(['fos/a', 'fos/b']);
    expect(del.searchParams.get('invalidate')).toBe('true');
    expect(calls[1]!.headers?.Authorization).toBe(`Basic ${Buffer.from('key1:topsecret').toString('base64')}`);
    await expect(c.deleteMany(Array.from({ length: 101 }, (_, i) => `x${i}`))).rejects.toThrow();
    fail = true;
    const err = await c.upload(new Uint8Array([1]), 'image/jpeg', 'fos/b').catch((e: Error) => e);
    expect(String(err)).toContain('HTTP 500');
    expect(String(err)).not.toContain('topsecret');
  });

  it('an upload with a time limit carries an abort signal; without one it does not (ADR-051)', async () => {
    const seen: (AbortSignal | undefined)[] = [];
    const fetch: FetchLike = async (_url, init) => {
      seen.push(init?.signal);
      return { ok: true, status: 200, json: async () => ({ public_id: 'fos/a', version: 1, bytes: 1, format: 'jpg' }) };
    };
    const c = new CloudinaryClient({ cloudName: 'demo', apiKey: 'k', apiSecret: 's', folder: 'fos', now, fetch });
    await c.upload(new Uint8Array([1]), 'image/jpeg', 'fos/a', 15_000);
    await c.upload(new Uint8Array([1]), 'image/jpeg', 'fos/a');
    expect(seen[0]).toBeInstanceOf(AbortSignal);
    expect(seen[1]).toBeUndefined();
  });
});
