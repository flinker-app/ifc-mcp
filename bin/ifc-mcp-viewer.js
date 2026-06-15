#!/usr/bin/env node
import { viewerCli } from "../src-node/viewer.js";

viewerCli(process.argv.slice(2)).then(
  (exitCode) => {
    process.exitCode = exitCode;
  },
  (error) => {
    console.error(error?.stack || error?.message || String(error));
    process.exitCode = 1;
  },
);
