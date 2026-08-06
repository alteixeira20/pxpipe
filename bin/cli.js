#!/usr/bin/env node

const argv = process.argv.slice(2);
const separator = argv.indexOf('--');
const warpCommand = separator >= 0 ? argv[separator + 1] : undefined;
const isAgyWord = (word) => /(?:^|[/\\])agy(?:\.exe)?$/i.test(word ?? '');
const agyDispatch =
  argv[0] === 'agy'
  || (argv[0] === 'doctor' && argv[1] === 'agy')
  || (argv[0] === 'warp' && isAgyWord(warpCommand));
const batchDispatch = argv[0] === 'agy-batch';

const entry = batchDispatch
  ? '../dist/agy-execution.js'
  : agyDispatch
    ? '../dist/agy.js'
    : '../dist/node.js';

import(entry)
  .then(async (module) => {
    if (batchDispatch) await module.runAgyBatchEntry(argv.slice(1));
    else if (agyDispatch) await module.runAgyEntry(argv);
  })
  .catch((err) => {
    console.error('[pxpipe] failed to start:', err);
    console.error('[pxpipe] did you forget to `npm run build`?');
    process.exit(1);
  });
