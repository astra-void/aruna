#!/usr/bin/env node
// The `aruna` command. A checked-in file rather than dist/cli.js because a
// package manager links a workspace package's bin only when the file exists at
// install time, and dist/ does not exist until the first build: on a fresh
// checkout the harnesses' `aruna build` was "command not found". It runs the
// built CLI.
import { runCli } from "../dist/cli.js";

runCli();
