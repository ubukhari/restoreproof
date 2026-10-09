#!/usr/bin/env node
/**
 * Write the README's recorded sample: `renderText` of examples/recorded-run.json, the run
 * `restoreproof demo` replays (recorded by scripts/record.mjs on the synthetic database). Build
 * first (`pnpm build`). src/distribution.test.ts fails while the README and the recording differ.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { renderText } from "../dist/index.js";

const readme = new URL("../README.md", import.meta.url);
const recorded = JSON.parse(
  readFileSync(new URL("../examples/recorded-run.json", import.meta.url), "utf8"),
);
const sample = renderText(recorded).trimEnd();
const text = readFileSync(readme, "utf8");
const next = text.replace(
  /(## What it prints[\s\S]*?```text\n)[\s\S]*?(\n```)/,
  (_m, a, b) => `${a}${sample}${b}`,
);
writeFileSync(readme, next);
console.log(next === text ? "README sample unchanged" : "README sample written");
