import { loadConfig } from '../src/core/config/index.js';
import { connectMongo, disconnectMongo } from '../src/core/db/index.js';
import mongoose from 'mongoose';

const config = loadConfig();
await connectMongo(config.MONGODB_URI, config.MONGODB_DB_NAME);
const phones = [
  '+8801700000001',
  '+8801700000002',
  '+8801700000003',
  '+8801700000004',
  '+8801700000005',
  '+8801700000006',
];
const r = await mongoose.connection.collection('users').deleteMany({ phone: { $in: phones } });
await mongoose.connection.collection('login_attempts').deleteMany({});
console.log(`deleted ${r.deletedCount} seed users and cleared login attempts`);
await disconnectMongo();
