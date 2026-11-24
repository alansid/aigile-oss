#!/usr/bin/env node
import { main } from '../src/launcher-core.js';

main(process.argv.slice(2)).then(
  code => { if (typeof code === 'number' && code !== 0) process.exitCode = code; },
  err => {
    console.error('✗', err?.message || err);
    process.exitCode = 1;
  },
);
