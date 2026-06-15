#!/usr/bin/env node
import { main } from "../src-node/server.js";

main().catch((error) => {
  console.error(error?.stack || error?.message || String(error));
  process.exitCode = 1;
});
