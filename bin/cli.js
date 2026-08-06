#!/usr/bin/env node

const argv = process.argv.slice(2);
const featherlessDispatch =
  (argv[0] === 'models' && argv[1] === 'featherless')
  || (argv[0] === 'doctor' && argv[1] === 'featherless');
const entry = featherlessDispatch ? '../dist/featherless-cli.js' : '../dist/node.js';

import(entry)
  .then(async (module) => {
    if (featherlessDispatch) await module.runFeatherlessCli(argv);
  })
  .catch((err) => {
    console.error('[pxpipe] failed to start:', err);
    console.error('[pxpipe] did you forget to `npm run build`?');
    process.exit(1);
  });
