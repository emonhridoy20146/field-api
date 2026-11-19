import mongoose from 'mongoose';
import { ctx } from '../../core/context/index.js';
import { defineRoutes } from '../../core/http/router.js';
import { getMany } from '../settings/index.js';
import { erpClient } from '../erp-gateway/index.js';
import pkg from '../../../package.json' with { type: 'json' };
import { storageDriver } from '../../core/storage/index.js';
import { CONTRACT_VERSION } from '../../core/http/contract.js';

export const systemRoutes = defineRoutes((r) => {
  // Liveness/readiness for the load balancer. Never does ERP-heavy work.
  r.get('/system/health', { access: 'public' }, async () => {
    const mongoOk = mongoose.connection.readyState === 1;
    let erp: string;
    try {
      erp = (await Promise.race([erpClient().health(), new Promise<{ ok: boolean }>((res) => setTimeout(() => res({ ok: false }), 1500))])).ok ? 'ok' : 'down';
    } catch {
      erp = 'down';
    }
    // `contract` tells which build is deployed (1.20.1): the owner deploys by hand, so check it here after a deploy.
    // storage: where photos go (s3, db = MongoDB, memory = this instance only: uploads from phones fail), ADR-039
    return { status: mongoOk ? 'ok' : 'degraded', version: pkg.version, contract: CONTRACT_VERSION, mongo: mongoOk ? 'ok' : 'down', erp, storage: storageDriver(ctx().config) };
  });
  r.get('/meta/app-config', { access: 'public' }, async () => {
    const s = await getMany(['app.minVersion', 'app.latestVersion', 'app.storeUrl', 'app.killSwitch', 'map.tileProvider', 'privacy.noticeVersion']);
    return {
      minAppVersion: s['app.minVersion'],
      latestAppVersion: s['app.latestVersion'],
      storeUrl: s['app.storeUrl'],
      killSwitch: s['app.killSwitch'],
      tileProvider: s['map.tileProvider'],
      privacyNoticeVersion: s['privacy.noticeVersion'],
      serverTime: ctx().clock.now().toISOString(),
    };
  });
});
