/**
 * The library behind the CLI: the drill (back up, restore into a throwaway copy, compare), the
 * workflow it writes, and the renderers.
 */
export { drillCommand, probeCommand, shouldRedact } from "./ci.js";
export { startCluster, type Cluster } from "./cluster.js";
export {
  allowance,
  bytes,
  compare,
  hashName,
  type Comparison,
  type Finding,
  type Previous,
  type TableCheck,
} from "./compare.js";
export {
  backupKind,
  drillFile,
  drillLive,
  dumpArgs,
  probeSource,
  sourceUrl,
  URL_VARIABLES,
  type DrillResult,
} from "./drill.js";
export { CliError, type Problem } from "./errors.js";
export { parseFacts, parseProbe, type Facts, type Probe } from "./facts.js";
export { HANDOFF_DETAIL, HANDOFF_LINE, HANDOFF_URL, PAGES_URL, REF } from "./handoff.js";
export { detectProvider, nextSteps, planInit, repoRoot, writeInit } from "./init.js";
export { INSTALL, ON_NPM, PUBLISHED, REPO, RUN } from "./install.js";
export { HELP, RECORDED_RUN, main } from "./main.js";
export { TOOLS, callTool, handleMessage } from "./mcp.js";
export { findPgBin, parseToolVersion } from "./pg.js";
export { factsFile, previousFrom, renderJson, renderMarkdown, renderText } from "./render.js";
export { NEVER_IN_COPY, SUPABASE_EXCLUDED_SCHEMAS, aptPackages, scopeFor } from "./scope.js";
export { factsSql, PROBE_SQL } from "./sql.js";
export { filterToc, parseToc } from "./toc.js";
export { checkConnection, parseDatabaseUrl, providerOf } from "./url.js";
export { VERSION } from "./version.js";
export { DRILL_PATH, WORKFLOW_PATH, renderWorkflow } from "./workflow.js";
