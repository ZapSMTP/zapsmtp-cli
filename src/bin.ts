#!/usr/bin/env node
// Entry point of the zapsmtp command.
import { main } from './main.js';

main(process.argv.slice(2), { stdout: process.stdout, stderr: process.stderr, stdin: process.stdin, env: process.env, cwd: process.cwd() })
  .then((code) => { process.exitCode = code; });
