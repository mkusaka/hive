#!/usr/bin/env bun
// `hive` entrypoint (src/cli.ts) with the real dependencies (src/deps.ts).
import { run } from "./cli.ts";
import { deps } from "./deps.ts";

process.exitCode = await run(process.argv.slice(2), deps);
