#!/usr/bin/env node
import { summarizeUsage } from '../src/antigravity/usage-ledger.js';
if (!process.env.AGY_USAGE_DIR) throw Error('AGY_USAGE_DIR required');
console.log(JSON.stringify(await summarizeUsage(process.env.AGY_USAGE_DIR), null, 2));
