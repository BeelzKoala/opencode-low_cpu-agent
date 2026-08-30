import { readdir, stat, writeFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

import {
  RUNTIME_COST_REDUCER_PROTOCOL,
  buildRuntimeCostProfiles,
  loadArtifactDirectory,
} from "./runtime-cost-reducer-v2.mjs"

export const RUNTIME_COST_BACKFILL_PROTOCOL = "runtime-cost-backfill-v1"
const DEFAULT_MAX_ARTIFACTS = 512

async function isFile(pathname) {
  try { return (await stat(pathname)).isFile() } catch { return false }
}

async function discoverArtifactDirs(root, maxArtifacts) {
  const queue = [path.resolve(root)]
  const found = []
  let truncated = false

  while (queue.length > 0) {
    const current = queue.shift()
    if (
      await isFile(path.join(current, "cpu-agent-trace.jsonl")) &&
      await isFile(path.join(current, "result.json"))
    ) {
      found.push(current)
      if (found.length >= maxArtifacts) {
        truncated = queue.length > 0
        break
      }
      continue
    }

    let entries = []
    try { entries = await readdir(current, { withFileTypes: true }) } catch { continue }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      if (entry.name === ".git" || entry.name === "node_modules") continue
      queue.push(path.join(current, entry.name))
    }
  }

  return { artifact_dirs: found.sort(), truncated }
}

export function aggregateBackfillReports(reports) {
  const observations = []
  let artifactsWithModel = 0
  let telemetryConflicts = 0

  for (const item of Array.isArray(reports) ? reports : []) {
    const report = item?.report
    if (!report || typeof report !== "object") continue
    const rows = Array.isArray(report.model_observations) ? report.model_observations : []
    if (rows.length > 0) artifactsWithModel += 1
    telemetryConflicts += Array.isArray(report.telemetry_conflicts)
      ? report.telemetry_conflicts.length
      : 0
    observations.push(...rows)
  }

  return Object.freeze({
    protocol: RUNTIME_COST_BACKFILL_PROTOCOL,
    reducer_protocol: RUNTIME_COST_REDUCER_PROTOCOL,
    authority: "shadow_observation",
    scheduling_authority: false,
    artifacts_scanned: Array.isArray(reports) ? reports.length : 0,
    artifacts_with_model: artifactsWithModel,
    model_observations: observations.length,
    telemetry_conflicts: telemetryConflicts,
    compatible_profiles_shadow: buildRuntimeCostProfiles(observations),
  })
}

export async function backfillRuntimeCostTree(root, { maxArtifacts = DEFAULT_MAX_ARTIFACTS } = {}) {
  if (!Number.isInteger(maxArtifacts) || maxArtifacts < 1) {
    throw new Error("maxArtifacts must be a positive integer")
  }

  const discovered = await discoverArtifactDirs(root, maxArtifacts)
  const reports = []

  for (const artifactDir of discovered.artifact_dirs) {
    try {
      reports.push({ artifact_dir: artifactDir, report: await loadArtifactDirectory(artifactDir) })
    } catch (error) {
      reports.push({
        artifact_dir: artifactDir,
        report: {
          model_observations: [],
          telemetry_conflicts: [{
            kind: "backfill_reducer_error",
            detail: String(error?.message ?? error),
          }],
        },
      })
    }
  }

  const aggregate = aggregateBackfillReports(reports)
  const output = {
    ...aggregate,
    root: path.resolve(root),
    discovery_truncated: discovered.truncated,
    max_artifacts: maxArtifacts,
    artifacts: reports.map((item) => ({
      artifact_dir: item.artifact_dir,
      model_observations: Array.isArray(item.report?.model_observations)
        ? item.report.model_observations.length
        : 0,
      telemetry_conflicts: Array.isArray(item.report?.telemetry_conflicts)
        ? item.report.telemetry_conflicts.length
        : 0,
    })),
  }

  // Historical artifact directories are read-only inputs. Only the aggregate
  // root receives a new report.
  await writeFile(
    path.join(path.resolve(root), "runtime-cost-backfill.json"),
    JSON.stringify(output, null, 2) + "\n",
    "utf8",
  )
  return output
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (invokedDirectly) {
  const root = process.argv[2]
  const maxArg = process.argv[3]
  if (!root) {
    console.error("usage: node runtime-cost-backfill-v1.mjs <results-root> [max-artifacts]")
    process.exitCode = 2
  } else {
    const maxArtifacts = maxArg === undefined ? DEFAULT_MAX_ARTIFACTS : Number.parseInt(maxArg, 10)
    try {
      const result = await backfillRuntimeCostTree(root, { maxArtifacts })
      console.log(`PASS ${RUNTIME_COST_BACKFILL_PROTOCOL} artifacts=${result.artifacts_scanned} model=${result.model_observations} profiles=${result.compatible_profiles_shadow.length} conflicts=${result.telemetry_conflicts} truncated=${result.discovery_truncated}`)
    } catch (error) {
      console.error(String(error?.stack ?? error))
      process.exitCode = 1
    }
  }
}
