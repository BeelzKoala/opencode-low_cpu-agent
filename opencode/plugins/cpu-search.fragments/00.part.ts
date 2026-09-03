import {
  PHYSICAL_INFERENCE_LEASE_PROTOCOL,
  createPhysicalInferenceLeaseController,
} from "./cpu-search-core/physical-inference-lease-v1.mjs"
import { deriveGovernorPhysicalLease } from "./cpu-search-core/governor-physical-lease-v1.mjs"
import {
  mirrorProjectTraceTelemetry,
  observePublicEventTelemetry,
  stopAllTelemetrySamplers,
} from "./cpu-search-core/telemetry-plane-v1.mjs"
import { spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { appendFile, mkdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

import {
  DETERMINISTIC_SCOUT_ENTRY_PROTOCOL,
  mergeDeterministicScoutContext,
  canMergeDeterministicScoutContext,
  compileDeterministicScoutRequest,
} from "./cpu-search-core/deterministic-scout-entry-v1.mjs"
import {
  MODEL_CONTEXT_COMPILER_PROTOCOL,
  buildRepairExecutionProjection,
  compileAdditiveExecutionCapsule,
  resolveModelContextBudgetBytes,
  resolveModelContextCompilerMode,
  resolveModelContextCompilerPolicy,
  resolveRepairContextBudgetBytes,
  snapshotCompiledExecutionCapsule,
} from "./cpu-search-core/model-context-compiler-v1.mjs"

import {
  TASK_ACTION_PROTOCOL,
  compileTaskAction,
  unresolvedTaskAction,
} from "./cpu-search-core/task-action-v1.mjs"
import {
  TASK_REQUIREMENTS_PROTOCOL,
  compileTaskRequirements,
  unresolvedTaskRequirements,
} from "./cpu-search-core/task-requirements-v1.mjs"
import {
  TASK_PROOF_COMPILER_PROTOCOL,
  compileTaskProofObligations,
} from "./cpu-search-core/task-proof-obligations-v1.mjs"
import {
  classifyEvidenceAuthority,
} from "./cpu-search-core/evidence-authority-v1.mjs"
import {
  LOCALIZATION_STATUS,
  decideLocalization,
} from "./cpu-search-core/localization-decision-v1.mjs"
import {
  REPO_CAPABILITY_PROTOCOL,
  SOURCE_FAMILY_PLAN_PROTOCOL,
  compileRepoCapabilityProfile,
  planTaskSourceFamilies,
} from "./cpu-search-core/repo-capability-v1.mjs"
import {
  FRAMEWORK_RESOURCE_BRIDGE_PROTOCOL,
  inspectFrameworkResourceFile,
} from "./cpu-search-core/framework-resource-bridge-v1.mjs"
import {
  RESOURCE_ADAPTER_BRIDGE_PROTOCOL,
  inspectResourceAdapterFile,
} from "./cpu-search-core/resource-adapter-bridge-v1.mjs"
import {
  TASK_ANCHOR_PROTOCOL,
  compileTaskAnchors,
} from "./cpu-search-core/task-anchor-v1.mjs"
import {
  TASK_CAUSAL_SHADOW_PROTOCOL,
  runTaskCausalShadow,
} from "./cpu-search-core/task-causal-shadow-v1.mjs"
import {
  TASK_SHAPE_PROTOCOL,
  compileTaskShape,
} from "./cpu-search-core/task-shape-v1.mjs"
import {
  ADDITIVE_LOCALIZATION_PLAN_PROTOCOL,
  planAdditiveLocalization,
} from "./cpu-search-core/additive-localization-plan-v1.mjs"
import {
  HOST_INTEGRATION_SHADOW_PROTOCOL,
  runHostIntegrationShadow,
} from "./cpu-search-core/host-integration-shadow-v1.mjs"
import {
  resolveAnchorFrontier,
  routeAnchorValues,
} from "./cpu-search-core/anchor-resolution-frontier-v1.mjs"
import {
  hostResourceClosureSummary,
  mergeHostAliases,
  resolveHostAliasesForNodes,
  resolveHostClosureContext,
} from "./cpu-search-core/host-resource-closure-v2.mjs"
import {
  projectAnchoredHostObligationProofs,
} from "./cpu-search-core/host-obligation-projector-v1.mjs"
import {
  DATA_OBLIGATION_PROJECTOR_PROTOCOL,
  projectDataAccessObligation,
} from "./cpu-search-core/data-obligation-projector-v1.mjs"
import {
  SCOUT_EVIDENCE_CLOSURE_PROTOCOL,
  planTaskBoundHostRefinement,
  solveScoutEvidenceClosure,
} from "./cpu-search-core/scout-evidence-closure-v1.mjs"
import {
  inspectEvidence,
} from "./cpu-search-core/evidence-inspect-v1.mjs"
import {
  EXECUTION_MUTATION_SHAPE,
  EXECUTION_READINESS_PROTOCOL,
  EXECUTION_READINESS_STATUS,
  initialExecutionReadiness,
  resolveExecutionReadiness,
} from "./cpu-search-core/execution-readiness-v1.mjs"
import {
  ADDITIVE_HOST_BINDING_PROTOCOL,
  ADDITIVE_MODEL_CONTEXT_MAX_BYTES,
  ADDITIVE_MAX_OPERATIONS,
  ADDITIVE_MAX_CREATE_FILES,
  ADDITIVE_MAX_REPLACE_BYTES,
  ADDITIVE_MAX_CREATE_BYTES,
  ADDITIVE_MAX_REL_PATH_BYTES,
  ADDITIVE_MUTATION_ABI_PROTOCOL,
  ADDITIVE_MUTATION_AUTHORITY_PROTOCOL,
  ADDITIVE_MUTATION_CAPABILITY_PROTOCOL,
  ADDITIVE_MUTATION_PLAN_PROTOCOL,
  ADDITIVE_REPAIR_HINT_PROTOCOL,
  EXECUTE_ADDITIVE_PLAN_TOOL,
  additiveRepairAuthorityMatches,
  bindAdditiveToolSchemaToCapability,
  authorizeAdditiveMutationCapability,
  buildAdditiveMutationHandoff,
  buildAdditiveRepairHint,
  deriveAdditiveMutationCapability,
  materializeAdditiveMutationContext,
  materializeAdditiveMutationPlan,
  renderAdditiveMutationCapability,
  validateAdditiveMutationRequest,
  verifyAdditiveMutationAuthority,
} from "./cpu-search-core/additive-mutation-v3.mjs"
import {
  OBLIGATION_BOUND_SYNTHESIS_PROTOCOL,
  deriveObligationBoundSynthesisContract,
  projectObligationBoundMutationContext,
  renderObligationBoundSynthesisContract,
} from "./cpu-search-core/obligation-bound-synthesis-v1.mjs"
import {
  SEMANTIC_CONTENT_IR_PROTOCOL,
  bindSemanticContentToolSchemaToCapability,
  materializeSemanticAdditiveRequest,
} from "./cpu-search-core/semantic-content-ir-v1.mjs"
import {
  buildFileFamilyRepairHint,
  fileFamilyRepairAuthorityMatches,
} from "./cpu-search-core/file-family-contract-v1.mjs"
import {
  buildPythonSemanticRepairHint,
  pythonSemanticFailureIsRepairable,
  pythonSemanticRepairAuthorityMatches,
} from "./cpu-search-core/python-semantic-repair-v1.mjs"
import {
  SEMANTIC_OBLIGATION_BRIDGE_PROTOCOL,
  bindSemanticObligationContract,
  validateSemanticObligationRequest,
} from "./cpu-search-core/semantic-obligation-bridge-v1.mjs"
import {
  SOURCE_SLOT_COMPILER_PROTOCOL,
  SOURCE_SLOT_REPAIR_PROTOCOL,
  bindSourceSlotToolSchema,
  buildSourceSlotRepairCache,
  rehydrateSourceSlotRequest,
  sourceSlotRepairAuthorityMatches,
  sourceSlotTypedStructuralRepairAuthorityMatches,
} from "./cpu-search-core/source-slot-compiler-v1.mjs"
import {
  MODEL_VIEW_COMPILER_PROTOCOL,
  compileSourceSlotModelView,
  modelViewFailureIsNonRepairable,
  modelViewOwnsFinalModelAbi,
  normalizeSourceSlotModelViewRequest,
  projectModelViewControlContext,
} from "./cpu-search-core/model-view-compiler-v1.mjs"

import {
  ATOMIC_MODEL_VIEW_PROTOCOL,
  RESIDUAL_MODEL_VIEW_PROTOCOL,
  accumulateAtomicModelViewRequest,
  atomicModelViewRuntimeEnabled,
  compileAtomicModelViewProjection,
  residualModelViewRuntimeEnabled,
} from "./cpu-search-core/atomic-model-view-v1.mjs"
import {
  PYTHON_DEPENDENCY_EVIDENCE_PROTOCOL,
  REPAIR_WITNESS_CLOSURE_PROTOCOL,
  compileRepairWitnessClosure,
  inspectPythonDependencyEvidence,
} from "./cpu-search-core/repair-witness-closure-v1.mjs"
import {
  deriveSourceSlotCounterexample,
  deriveSemanticSourceCounterexample,
  deriveExistingRouteSourceCounterexample,
  deriveExistingSymbolSourceCounterexample,
  decideSourceCounterexampleRepairAdmission,
  prepareCounterexampleToolResult,
} from "./cpu-search-core/typed-counterexample-v1.mjs"
import {
  CANDIDATE_OBLIGATION_LEDGER_PROTOCOL,
  deriveCandidateObligationLedger,
} from "./cpu-search-core/candidate-obligation-ledger-v1.mjs"
import {
  GOVERNOR_LATENCY_PROTOCOL,
  TIME_SEMANTICS_PROTOCOL,
  GOVERNOR_TASK_WINDOW_SEMANTICS,
  GOVERNOR_TASK_SLA_ENFORCED,
  GOVERNOR_PRODUCT_WATCHDOG_MODE,
  GOVERNOR_PRODUCTION_HARD_LEASE_PROMOTED,
  GOVERNOR_MAX_ACTIVE_PHASES,
  effectivePhaseBudgetMs,
  initialLatencyProfile,
  latencyReserveMs,
  observeLatency,
  phaseForExecutionState,
  resolveGovernorAdmission,
} from "./cpu-search-core/governor-latency-v1.mjs"
import {
  GOVERNOR_WORK_PROTOCOL,
  adaptiveGovernorWindows,
  deriveGovernorInferenceLease,
  estimateGovernorDispatchWork,
  initialGovernorWorkProfile,
  observeGovernorWork,
} from "./cpu-search-core/governor-work-v2.mjs"
import {
  GOAL_DIRECTED_GOVERNOR_PROTOCOL,
  decideGoalDirectedCompute,
} from "./cpu-search-core/goal-directed-governor-v1.mjs"
import {
  wrapBoundedMutationLanguage,
} from "./cpu-search-core/bounded-mutation-inference-v1.mjs"
import {
  QUALIFIED_COMPUTE_PROTOCOL,
  deriveQualifiedComputePlan,
} from "./cpu-search-core/qualified-compute-v1.mjs"

import {
  EXECUTION_CONTROL_PROTOCOL,
  assertDeterministicFrontier,
  wrapExecutionControlledLanguage,
} from "./cpu-search-core/execution-control-kernel-v1.mjs"

import {
  rewriteNativeOpenAICompatibleMutationRequest,
} from "./cpu-search-core/native-openai-compatible-mutation-wire-v1.mjs"

import {
  EXECUTION_PERMIT_PROTOCOL,
  claimMutationExecutionPermit,
  validateClaimedMutationExecutionPermit,
} from "./cpu-search-core/execution-permit-v1.mjs"

import {
  mergeTaskRoleEvidence,
  projectTaskBoundObligationProofs,
} from "./cpu-search-core/task-bound-obligation-evidence-v1.mjs"

import {
  solveObligationCoverage,
} from "./cpu-search-core/obligation-coverage-v1.mjs"



import {
  TASK_SEARCH_PLAN_PROTOCOL,
  compileTaskSearchPlanForState,
} from "./cpu-search-core/task-search-plan-v1.mjs"
import {
  ACTION_COMMIT_DISPATCH_ORIGIN,
  ACTION_COMMIT_PROTOCOL,
  claimActionCommit,
  deriveActionCommit,
} from "./cpu-search-core/action-commit-v1.mjs"
import {
  TERMINAL_COMMIT_PROTOCOL,
  claimTerminalCommit,
  deriveTerminalCommit,
  terminalCommitMatchesTask,
} from "./cpu-search-core/terminal-commit-v1.mjs"

import {
  MUTATION_PHASE_COMPILER_PROTOCOL,
  STRUCTURED_MUTATION_CONTROL_PROTOCOL,
  compileMutationPhaseContext as compileMutationPhaseContextBase,
  projectMutationToolSchemas,
} from "./cpu-search-core/mutation-phase-compiler-v1.mjs"

import {
  MODEL_ABI_COMPILER_PROTOCOL,
  compileModelFacingToolSchemas,
} from "./cpu-search-core/model-abi-compiler-v1.mjs"

import {
  CONTROL_CONTEXT_LAYER_PROTOCOL,
  compileControlContextLayer,
} from "./cpu-search-core/control-context-layer-v1.mjs"

import {
  deriveCausalDispatchContract,
} from "./cpu-search-core/causal-dispatch-contract-v1.mjs"


function structuredMutationControlRequiredForState(
  state,
  selectedAction,
) {
  if (
    selectedAction !==
      EXECUTE_ADDITIVE_PLAN_TOOL
  ) {
    return false
  }

  return (
    state?.executionContextSelectedSource ===
      "compiled_execution_capsule" ||
    state?.executionContextSelectedSource ===
      "persisted_execution_capsule_repair_projection"
  )
}

function buildStructuredMutationControlEnvelope(
  state,
  selectedAction,
) {
  if (
    !structuredMutationControlRequiredForState(
      state,
      selectedAction,
    )
  ) {
    return null
  }

  if (
    state?.executionState !==
      EXEC_STATE_MUTATE &&
    state?.executionState !==
      EXEC_STATE_REPAIR
  ) {
    return null
  }

  const active =
    state?.activeSemanticMutationContract
  const contract =
    active?.contract
  const attestation =
    active?.attestation

  if (
    active?.protocol !==
      SEMANTIC_OBLIGATION_BRIDGE_PROTOCOL ||
    contract?.ok !== true ||
    typeof contract.contract_sha256 !==
      "string" ||
    !/^[0-9a-f]{64}$/u.test(
      contract.contract_sha256,
    ) ||
    attestation?.protocol !==
      SEMANTIC_OBLIGATION_BRIDGE_PROTOCOL ||
    attestation.contract_sha256 !==
      contract.contract_sha256 ||
    typeof attestation
      .attestation_sha256 !== "string" ||
    !/^[0-9a-f]{64}$/u.test(
      attestation.attestation_sha256,
    ) ||
    typeof attestation
      .capability_fingerprint_sha256 !==
      "string" ||
    !/^[0-9a-f]{64}$/u.test(
      attestation
        .capability_fingerprint_sha256,
    )
  ) {
    return null
  }

  if (
    typeof state
      .executionContextCapsuleSha256 !==
      "string" ||
    !/^[0-9a-f]{64}$/u.test(
      state.executionContextCapsuleSha256,
    ) ||
    typeof state
      .executionContextContractSha256 !==
      "string" ||
    !/^[0-9a-f]{64}$/u.test(
      state.executionContextContractSha256,
    )
  ) {
    return null
  }

  const dispatchContract =
    deriveCausalDispatchContract({
      semanticContract: contract,
      semanticAttestation: attestation,
      sourceSlotBinding:
        state?.activeSourceSlotContract
          ?.binding ?? null,
      executionState:
        state.executionState,
      selectedAction,
      selectedSource:
        state.executionContextSelectedSource,
      executionContextCapsuleSha256:
        state.executionContextCapsuleSha256,
      executionContractSha256:
        state.executionContextContractSha256,
    })

  if (dispatchContract.ok !== true) {
    return null
  }

  const requiredOperations =
    dispatchContract.required_operations

  return Object.freeze({
    protocol:
      STRUCTURED_MUTATION_CONTROL_PROTOCOL,
    authority:
      "deterministic_runtime_state",
    execution_state:
      state.executionState,
    selected_action:
      selectedAction,
    selected_source:
      state.executionContextSelectedSource,
    execution_context_capsule_sha256:
      state.executionContextCapsuleSha256,
    execution_contract_sha256:
      state.executionContextContractSha256,
    semantic_contract_sha256:
      contract.contract_sha256,
    semantic_attestation_sha256:
      attestation.attestation_sha256,
    capability_fingerprint_sha256:
      attestation
        .capability_fingerprint_sha256,
    required_operations:
      Object.freeze(requiredOperations),
  })
}

function compileMutationPhaseContext(
  request,
) {
  const base =
    compileMutationPhaseContextBase(
      request,
    )

  const controlled =
    compileControlContextLayer(
      base,
    )

  return projectModelViewControlContext(
    controlled,
    request?.modelView ?? null,
  )
}



const physicalInferenceLeaseController =
  createPhysicalInferenceLeaseController()

const MAX_QUERIES = 4
const LINE_HIT_CAP_PER_QUERY = 1000
const FILE_DISCOVERY_CAP_PER_QUERY = 5000
const PROBE_MAX_FILES = 8
const EMIT_MAX_FILES = 4
const PROBE_MATCH_SIGNAL_CAP = 3
const ROUTE_BODY_BUDGET_BYTES = 700
const CONTEXT_RADIUS = 2

const QUERY_CACHE_MAX_ENTRIES_PER_TURN = 16
const QUERY_CACHE_MAX_MATCHES_PER_TURN = 4000

const INDEX_BODY_BUDGET_BYTES = 1400
const INDEX_MAX_FILES_PER_QUERY = 5
const INDEX_MAX_STRUCTURAL_GROUPS = 6
const INDEX_FACET_TEXT_MAX = 80

const MAX_OUTPUT_BYTES = 6500
const BODY_BUDGET_BYTES = 5000
const MAX_CONTEXT_FILE_BYTES = 2 * 1024 * 1024
const FRAMEWORK_ROUTING_MAX_FILES = 8
const FRAMEWORK_ROUTING_MAX_FILE_BYTES = 512 * 1024
const FRAMEWORK_ROUTING_MAX_EDGES_PER_FILE = 32
const FRAMEWORK_ROUTING_MAX_EDGES_PER_TURN = 96
const RESOURCE_ROUTING_MAX_FILES = 8
const RESOURCE_ROUTING_MAX_FILE_BYTES = 512 * 1024
const RESOURCE_ROUTING_MAX_EDGES_PER_FILE = 32
const RESOURCE_ROUTING_MAX_EDGES_PER_TURN = 96
const TASK_CAUSAL_SHADOW_MAX_HOPS = 3
const TASK_CAUSAL_SHADOW_MAX_NODES = 48
const TASK_CAUSAL_SHADOW_MAX_EDGES = 96
const QUERY_TIMEOUT_MS = 1500

// Structural BM25F/RRF is routing-only. Failure must preserve the existing
// lexical relevance order and can never authorize mutation.
const RETRIEVAL_RANKER_PROTOCOL = "retrieval-ranker-v1"
const RETRIEVAL_RANKER_AUTHORITY = "routing_only"
const RETRIEVAL_RANKER_TIMEOUT_MS = 1500
const RETRIEVAL_RANKER_MAX_STDOUT_BYTES = 256 * 1024
const RETRIEVAL_RANKER_MAX_FILES = 32

// Semantic source validation is shadow-only in v2.24. It observes existing
// source-validated Impact edges but cannot change routing, emit, or mutation
// authority.
const SEMANTIC_RESOLVER_PROTOCOL = "semantic-resolver-v1.1"
const SEMANTIC_RESOLVER_AUTHORITY = "shadow_semantic"
const SEMANTIC_RESOLVER_TIMEOUT_MS = 1500
const SEMANTIC_RESOLVER_MAX_STDOUT_BYTES = 256 * 1024
const SEMANTIC_IMPACT_MAX_QUERIES = 8
const SEMANTIC_IMPACT_MAX_RESULTS = 8
const SEMANTIC_IMPACT_WITNESS_WINDOW_LINES = 12

const QUERY_COMPILER_MIN_TOKENS = 2
const QUERY_COMPILER_MAX_TOKENS = 6

const QUERY_FORMULATION_PROTOCOL = "query-formulation-v2"
const QUERY_FORMULATION_MAX_BRANCHES = 4
const QUERY_FORMULATION_MAX_ATOMS = 8
const QUERY_FORMULATION_MAX_ATOMS_PER_BRANCH = 5
const QUERY_FORMULATION_MIN_FILE_ATOMS = 2
const QUERY_FORMULATION_MIN_COVERAGE_RATIO = 0.5
const QUERY_FORMULATION_MAX_FILES = PROBE_MAX_FILES * 3

const QUERY_COMPILER_STOPWORDS = new Set([
  "the",
  "and",
  "for",
  "with",
  "from",
  "into",
  "when",
  "then",
  "this",
  "that",
])

const DISTILLER_TIMEOUT_MS = 500
const DISTILLER_MAX_STDOUT_BYTES = 512 * 1024
const DISTILLER_RAW_BODY_PRESSURE_BYTES = 2500
const DISTILLER_MAX_HITS_PER_FILE = 12
const DISTILLER_IR_BUDGET_BYTES = 32 * 1024

const IMPACT_INDEX_REFRESH_TIMEOUT_MS = 800
const IMPACT_INDEX_QUERY_TIMEOUT_MS = 150
const IMPACT_INDEX_MAX_STDOUT_BYTES = 128 * 1024
const IMPACT_INDEX_MAX_SEEDS = PROBE_MAX_FILES
const IMPACT_INDEX_MAX_NEIGHBORS = 24
const IMPACT_INDEX_REFRESH_TTL_MS = 120_000
const IMPACT_GRAPH_PROBE_MAX_FILES = 2
const IMPACT_GRAPH_EMIT_MAX_FILES = 1
const IMPACT_BINDINGS_PER_CANDIDATE = 4
const IMPACT_EDGE_SYMBOL_CAP = 16
const IMPACT_VALIDATION_SYMBOL_CAP = IMPACT_EDGE_SYMBOL_CAP
const DATA_PROVIDER_IDENTITY_MAX_TASK_IDENTITIES = 8
const DATA_PROVIDER_IDENTITY_MAX_FILES_PER_IDENTITY = 8
const DATA_PROVIDER_IDENTITY_REQUEST_TIMEOUT_MS = 1800
const DATA_PROVIDER_SYMBOL_BINDING_TIMEOUT_MS = 800
const IMPACT_SCOPE_IDENTIFIER_CAP = 160
const IMPACT_FILTER_SYMBOL_CAP = IMPACT_SCOPE_IDENTIFIER_CAP
const IMPACT_VALIDATION_TIMEOUT_MS = 350
const IMPACT_VALIDATION_HIT_CAP = 8
const IMPACT_SCOPE_WINDOW_RADIUS = 12
const IMPACT_SCOPE_MAX_LINES = 180
const HYBRID_MIN_SAVINGS_RATIO = 0.75
const HYBRID_CONTEXT_RADIUS = 1
const HYBRID_CONTEXT_SAMPLES_PER_GROUP = 3

const FOCUSED_PROBE_MAX_LINE_HITS = 24
const FOCUSED_PROBE_MAX_EXACT_MATCHES = 32
const FOCUSED_PROBE_MAX_HITS_PER_FILE = 8
const FOCUSED_MAX_SCOPES = 3
const FOCUSED_SUPPLEMENT_MAX_BYTES = 2600
const FOCUSED_FULL_SCOPE_MAX_LINES = 96
const FOCUSED_SCOPE_HEADER_LINES = 3
const FOCUSED_WINDOW_RADII = [20, 12, 6, 2]
const FOCUSED_MIN_SUPPLEMENT_BYTES = 128
const FOCUSED_MAX_OVERHEAD_BYTES = 256
const FOCUSED_MAX_OVERHEAD_RATIO = 1.12

const REGION_MAX_SCOPES = 3
const REGION_BODY_BUDGET_BYTES = 2200
const REGION_SAMPLE_HITS_PER_SCOPE = 3
const REGION_SAMPLE_RADIUS = 1

const EVIDENCE_LEDGER_MAX_FACTS_PER_TURN = 12000
const ROUTE_LEDGER_MAX_FACTS_PER_TURN = 4000
const CONTEXTUALIZED_HITS_MAX_PER_TURN = 4000
const MAX_CONSECUTIVE_NO_PROGRESS = 2

// Final Scout boundary. Search semantics stay bounded; the new work is a
// deterministic, machine-readable handoff for the next execution stage.
const SCOUT_HANDOFF_PROTOCOL = "scout-handoff-v1"
const SCOUT_LOCAL_CAPABILITY_PROTOCOL = "scout-local-capability-v1"
const SCOUT_RENAME_TARGET_PROTOCOL = "scout-rename-target-v2"
const SCOUT_OWNER_ATTESTATION_PROTOCOL = "owner-attestation-v1"
const SCOUT_LOCAL_CAPABILITY_ALLOWED_MUTATIONS = Object.freeze(["replace_node"])
const SCOUT_LOCAL_CAPABILITY_MAX_COMPETITOR_FILES = 4
const SCOUT_LOCAL_CAPABILITY_ALLOWED_PARTIAL_REASONS = new Set([
  "retained_unread_files",
  "retained_unemitted_files",
  "evidence_incomplete",
  "impact_index_partial",
])
const SCOUT_HANDOFF_HASH_MAX_BYTES = 8 * 1024 * 1024
const SCOUT_HANDOFF_MAX_LINES_PER_FILE = 32

// Mutation/action plane. Search semantics stay independent: the model submits
// semantic intent, while compiler/executor/verifier deterministically bind it
// to capability-authorized source and bounded physical mutation.
const PATCH_COMPILER_PROTOCOL = "patch-compiler-v2"
const PATCH_MUTATION_PROTOCOL = "mutation-plan-v1"
const PATCH_TOOL_PROTOCOL = "semantic-mutation-tool-v1"
const MUTATION_TOOL_ABI_PROTOCOL = "capability-mutation-tools-v2"
const EXECUTE_REPLACE_NODE_TOOL = "execute_replace_node"
const EXECUTE_RENAME_SYMBOL_TOOL = "execute_rename_symbol"
const MUTATION_TOOL_NAMES = Object.freeze([
  EXECUTE_REPLACE_NODE_TOOL,
  EXECUTE_RENAME_SYMBOL_TOOL,
  EXECUTE_ADDITIVE_PLAN_TOOL,
])
const PATCH_PERMISSION_ACTION = "execute_patch"
const PATCH_EXECUTOR_PROTOCOL = "patch-executor-v3"
const PATCH_EDIT_PROTOCOL = "edit-script-v3-certified-slice"
const MUTATION_CONFINEMENT_PROTOCOL = "mutation-slice-v1"
const CANDIDATE_VALIDITY_PROTOCOL = "candidate-validity-v1"
const EXECUTION_LOOP_PROTOCOL = "execution-loop-v1"
const PATCH_RECEIPT_PROTOCOL = "patch-receipt-v1"
const INVARIANT_VERIFIER_PROTOCOL = "invariant-verifier-v2"
const VERIFICATION_RECEIPT_PROTOCOL = "verification-receipt-v1"
const COMPLETION_AUTHORIZER_REQUEST_PROTOCOL = "completion-authorizer-request-v1"
const COMPLETION_AUTHORIZER_PROTOCOL = "completion-authorizer-v1"
const COMPLETION_AUTHORIZER_POLICY = "exact-rename-v1"
const COMPLETION_SAFE_FAIL_PROTOCOL = "completion-safe-fail-v1"
const COMPLETION_SAFE_FAIL_OUTCOME = "SAFE_FAIL"
// Wall-clock limits in the deterministic mutation plane are hard liveness
// watchdogs, not capability or correctness budgets. Actual mutation scope is
// bounded independently by files, edits, lines, bytes, checks, evidence and
// attempt budgets. Keep one conservative ceiling so transient CPU/I/O pressure
// cannot turn the same valid bounded plan into a different correctness result.
const PATCH_STAGE_HARD_WATCHDOG_MS = 30_000

const PATCH_COMPILER_TIMEOUT_MS = PATCH_STAGE_HARD_WATCHDOG_MS
const PATCH_COMPILER_MAX_STDOUT_BYTES = 256 * 1024
const PATCH_EXECUTOR_TIMEOUT_MS = PATCH_STAGE_HARD_WATCHDOG_MS
const PATCH_EXECUTOR_MAX_STDOUT_BYTES = 256 * 1024
const INVARIANT_VERIFIER_TIMEOUT_MS = PATCH_STAGE_HARD_WATCHDOG_MS
const INVARIANT_VERIFIER_MAX_STDOUT_BYTES = 256 * 1024
// Native completion authorization benchmarks at ~1 ms median / ~1.4 ms p95.
// This is only a liveness watchdog. Timeout/ABSTAIN withholds terminal
// optimization; the verified PATCH_READY candidate remains valid and the
// ordinary agent loop may continue.
const COMPLETION_AUTHORIZER_TIMEOUT_MS = 500
const COMPLETION_AUTHORIZER_MAX_STDOUT_BYTES = 64 * 1024
const TASK_PROOF_EVALUATOR_PROTOCOL = "task-proof-evaluator-v1"
const TASK_PROOF_TERMINAL_POLICY = "additive-task-proof-v1"
const TASK_PROOF_EVALUATOR_TIMEOUT_MS = 5_000
const TASK_PROOF_EVALUATOR_MAX_STDOUT_BYTES = 256 * 1024
const MAX_PATCH_ATTEMPTS_PER_TURN = 2

// v2.16-B: deterministic runtime identity.
// The installer is authoritative for cryptographic hashes. The plugin reads
// the small manifest and performs cheap path/size checks; it never hashes
// ~40 MB binaries on the patch hot path.
const RUNTIME_STACK_PROTOCOL = "runtime-stack-v1"
const RUNTIME_STACK_MANIFEST = ".runtime-stack-v1.json"
const RUNTIME_STACK_COMPONENTS = {
  compiler: "opencode-patch-compiler",
  executor: "opencode-patch-executor",
  verifier: "opencode-invariant-verifier",
  impact_index: "opencode-impact-index",
  context_planner: "opencode-context-planner",
}

let runtimeStackManifestCache = null

// v2.15-B: explicit causal controller. The model never chooses between tools
// when deterministic preconditions already identify the only valid next action.
const EXECUTION_FSM_PROTOCOL = "causal-execution-fsm-v1"
const TOOL_FRONTIER_PROTOCOL = "causal-tool-frontier-v2.5-deterministic-action"
const TASK_CONTEXT_PROTOCOL = "task-context-v1"
const TASK_CONTEXT_ADAPTER_PROTOCOL = "task-context-adapter-v1.2-json-string-controls"
const MUTATION_INTENT_PROTOCOL = "mutation-intent-grammar-v1"
const TASK_CONTEXT_MAX_TEXT_BYTES = 16 * 1024
const TASK_CONTEXT_MAX_PARTS = 64
const TASK_CONTEXT_MAX_REPORTED_PART_TYPES = 16
const TASK_CONTEXT_MAX_REPORTED_SOURCES = 8
const EDIT_CAPSULE_PROTOCOL = "edit-capsule-v1"
const EDIT_CAPSULE_RENDER_CONTRACT = "transactional-scope-v1"
const PROOF_OBLIGATION_PROTOCOL = "proof-obligation-v1"
const EXEC_STATE_LOCATE = "locate"
const EXEC_STATE_MUTATE = "mutate"
const EXEC_STATE_REPAIR = "repair"
const EXEC_STATE_DONE = "done"
const EXEC_STATE_SAFE_FAIL = "safe_fail"
const EDIT_CAPSULE_MAX_BYTES = 4600
const EDIT_CAPSULE_MAX_SCOPES = 4
const EDIT_CAPSULE_FULL_SCOPE_MAX_LINES = 80
const EDIT_CAPSULE_WINDOW_RADIUS = 6
const MUTATION_CANDIDATE_SET_PROTOCOL = "bounded-mutation-candidates-v1"
const MUTATION_CANDIDATE_MAX = EDIT_CAPSULE_MAX_SCOPES

const SEARCH_PROTOCOL = "search-v2.24.0-semantic-impact-shadow"
const AGENT_PROTOCOL = "cpu-agent-v2.8.0-mutation-confinement-2"
const RUNTIME_COST_OBSERVATION_PROTOCOL = "runtime-cost-observation-v1"

const MAX_SEARCH_ATTEMPTS_PER_TURN = 6
const MAX_EXECUTED_SEARCHES_PER_TURN = 4
const MAX_TURN_EVIDENCE_BYTES = 8192

const MAX_MODEL_CALLS_PER_TURN = 4
const MAX_TURN_WALL_MS = 120_000

// v2.27-C: proof-carrying terminalization. The verifier remains authority;
// this layer only prevents a redundant provider turn after immutable proof.
const TERMINAL_ARTIFACT_MAX_BYTES = 512 * 1024
const TERMINAL_SHORT_CIRCUIT_ENABLED =
  process.env.OPENCODE_CPU_AGENT_TERMINAL_SHORT_CIRCUIT !== "0"

const SESSION_TTL_MS = 2 * 60 * 60 * 1000
const MAX_TRACKED_SESSIONS = 256

const EXCLUDES = [
  "!.git/**",
  "!.opencode/**",
  "!.agentbench/**",
  "!node_modules/**",
  "!**/node_modules/**",
  "!.venv/**",
  "!**/.venv/**",
  "!venv/**",
  "!**/venv/**",
  "!__pycache__/**",
  "!**/__pycache__/**",
  "!dist/**",
  "!**/dist/**",
  "!build/**",
  "!**/build/**",
]

const SOURCE_GLOB_INVENTORY_PROTOCOL = "source-glob-inventory-v1"
const SOURCE_GLOB_INVENTORY_TIMEOUT_MS = 500
const SOURCE_GLOB_INVENTORY_MAX_FILES = 20_000
const SOURCE_GLOB_INVENTORY_MAX_STDOUT_BYTES = 2 * 1024 * 1024
const SOURCE_GLOB_FALLBACK_MAX_EXTENSIONS = 12
const SOURCE_LANGUAGE_EXTENSIONS = Object.freeze([
  "py",
  "pyi",
  "js",
  "jsx",
  "mjs",
  "cjs",
  "ts",
  "tsx",
  "mts",
  "cts",
  "html",
  "htm",
  "css",
  "scss",
  "sass",
  "less",
  "xml",
  "sql",
])
const SOURCE_LANGUAGE_EXTENSION_SET = new Set(SOURCE_LANGUAGE_EXTENSIONS)

function appendSearchGlobs(args, glob) {
  // ripgrep glob precedence is order-sensitive.
  // User glob constrains search first; reserved exclusions are applied last
  // and are therefore authoritative.
  if (glob) args.push("-g", glob)

  for (const pattern of EXCLUDES) {
    args.push("-g", pattern)
  }
}

function sourceExtensionFromFile(file) {
  const normalized = evidenceFileKey(file).toLowerCase()
  const ext = path.posix.extname(normalized)
  return ext.startsWith(".") ? ext.slice(1) : ""
}

function parseSimpleLanguageGlob(glob) {
  if (
    typeof glob !== "string" ||
    glob.length < 1 ||
    glob.startsWith("!") ||
    glob.includes("\\")
  ) {
    return null
  }

  let match = /^(.*\*)\.([a-z0-9]+)$/.exec(glob)
  let extensions = null

  if (match) {
    extensions = [match[2]]
  } else {
    match = /^(.*\*)\.\{([a-z0-9]+(?:,[a-z0-9]+)+)\}$/.exec(glob)
    if (match) extensions = match[2].split(",")
  }

  if (!match || !extensions) return null

  const unique = [...new Set(extensions)]
  if (
    unique.length < 1 ||
    unique.some((ext) => !SOURCE_LANGUAGE_EXTENSION_SET.has(ext))
  ) {
    return null
  }

  return {
    prefix: match[1],
    extensions: unique,
  }
}

function buildLanguageGlob(prefix, extensions) {
  const unique = [...new Set(extensions ?? [])]
    .filter((ext) => SOURCE_LANGUAGE_EXTENSION_SET.has(ext))
    .sort()

  if (unique.length < 1) return null
  if (unique.length === 1) return `${prefix}.${unique[0]}`
  return `${prefix}.{${unique.join(",")}}`
}

function sourceInventoryCacheKey(target, prefix) {
  return JSON.stringify({
    protocol: SOURCE_GLOB_INVENTORY_PROTOCOL,
    target,
    prefix,
  })
}

function runSourceGlobInventory(root, target, prefix) {
  return new Promise((resolve) => {
    const patterns = SOURCE_LANGUAGE_EXTENSIONS.map(
      (ext) => `${prefix}.${ext}`,
    )

    const args = ["--files", "-0"]
    for (const pattern of patterns) args.push("-g", pattern)
    for (const pattern of EXCLUDES) args.push("-g", pattern)
    args.push("--", target)

    const child = spawn("rg", args, {
      cwd: root,
      stdio: ["ignore", "pipe", "pipe"],
    })

    const counts = new Map()
    let files = 0
    let stdoutBytes = 0
    let stderr = ""
    let pending = ""
    let timedOut = false
    let scanCapped = false
    let settled = false
    let spawnError = null

    const timer = setTimeout(() => {
      timedOut = true
      child.kill("SIGKILL")
    }, SOURCE_GLOB_INVENTORY_TIMEOUT_MS)

    function consumeFile(raw) {
      if (!raw || scanCapped) return

      files += 1
      if (files > SOURCE_GLOB_INVENTORY_MAX_FILES) {
        scanCapped = true
        child.kill("SIGKILL")
        return
      }

      const ext = sourceExtensionFromFile(raw)
      if (!SOURCE_LANGUAGE_EXTENSION_SET.has(ext)) return
      counts.set(ext, (counts.get(ext) ?? 0) + 1)
    }

    child.stdout.on("data", (chunk) => {
      stdoutBytes += chunk.length
      if (stdoutBytes > SOURCE_GLOB_INVENTORY_MAX_STDOUT_BYTES) {
        scanCapped = true
        child.kill("SIGKILL")
        return
      }

      pending += chunk.toString("utf8")
      let index
      while ((index = pending.indexOf("\0")) >= 0) {
        consumeFile(pending.slice(0, index))
        pending = pending.slice(index + 1)
        if (scanCapped) break
      }
    })

    child.stderr.on("data", (chunk) => {
      if (stderr.length < 4096) stderr += chunk.toString("utf8")
    })

    child.on("error", (error) => {
      spawnError = String(error?.message ?? error)
    })

    child.on("close", (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)

      if (pending.length > 0 && !scanCapped) consumeFile(pending)

      const exitOk = code === 0 || code === 1
      const error = spawnError ?? (!exitOk && !timedOut && !scanCapped
        ? (stderr.trim() || `rg_exit_${code}`)
        : null)
      const complete =
        !timedOut &&
        !scanCapped &&
        !error

      resolve({
        protocol: SOURCE_GLOB_INVENTORY_PROTOCOL,
        complete,
        timedOut,
        scanCapped,
        error,
        files,
        extensions: Object.fromEntries(
          [...counts.entries()].sort(([a], [b]) => a.localeCompare(b)),
        ),
      })
    })
  })
}

async function sourceGlobInventory(root, target, prefix, state) {
  const key = sourceInventoryCacheKey(target, prefix)
  const cached = state?.sourceInventoryCache?.get(key)
  if (cached) return { ...cached, cacheHit: true }

  const result = await runSourceGlobInventory(root, target, prefix)

  if (state?.sourceInventoryCache instanceof Map) {
    state.sourceInventoryCache.set(key, result)
  }

  return { ...result, cacheHit: false }
}

async function resolveSearchLanguageGlob(root, target, requestedGlob, state) {
  const base = {
    protocol: SOURCE_GLOB_INVENTORY_PROTOCOL,
    requestedGlob: requestedGlob ?? null,
    effectiveGlob: requestedGlob,
    corrected: false,
    reason: null,
    inventoryComplete: null,
    inventoryFiles: 0,
    inventoryExtensions: {},
    inventoryCacheHit: false,
  }

  const parsed = parseSimpleLanguageGlob(requestedGlob)
  if (!parsed) return base

  let info
  try {
    info = await stat(path.resolve(root, target))
  } catch {
    return {
      ...base,
      reason: "target_stat_unavailable",
    }
  }

  if (info.isFile()) {
    const ext = sourceExtensionFromFile(target)
    if (
      !SOURCE_LANGUAGE_EXTENSION_SET.has(ext) ||
      parsed.extensions.includes(ext)
    ) {
      return {
        ...base,
        reason: "explicit_file_glob_compatible",
      }
    }

    return {
      ...base,
      effectiveGlob: undefined,
      corrected: true,
      reason: "explicit_file_path_overrides_absent_language_glob",
      inventoryComplete: true,
      inventoryFiles: 1,
      inventoryExtensions: { [ext]: 1 },
    }
  }

  if (!info.isDirectory()) {
    return {
      ...base,
      reason: "target_not_file_or_directory",
    }
  }

  const inventory = await sourceGlobInventory(
    root,
    target,
    parsed.prefix,
    state,
  )

  const resultBase = {
    ...base,
    inventoryComplete: inventory.complete === true,
    inventoryFiles: inventory.files ?? 0,
    inventoryExtensions: inventory.extensions ?? {},
    inventoryCacheHit: inventory.cacheHit === true,
  }

  if (inventory.complete !== true) {
    return {
      ...resultBase,
      reason: "source_inventory_incomplete",
    }
  }

  if (
    parsed.extensions.some(
      (ext) => (inventory.extensions?.[ext] ?? 0) > 0,
    )
  ) {
    return {
      ...resultBase,
      reason: "requested_language_present",
    }
  }

  const fallbackExtensions = Object.keys(inventory.extensions ?? {})
    .filter((ext) => (inventory.extensions?.[ext] ?? 0) > 0)
    .sort()

  if (fallbackExtensions.length < 1) {
    return {
      ...resultBase,
      reason: "no_supported_source_files",
    }
  }

  if (fallbackExtensions.length > SOURCE_GLOB_FALLBACK_MAX_EXTENSIONS) {
    return {
      ...resultBase,
      reason: "fallback_extension_set_too_wide",
    }
  }

  const effectiveGlob = buildLanguageGlob(
    parsed.prefix,
    fallbackExtensions,
  )

  if (!effectiveGlob) {
    return {
      ...resultBase,
      reason: "fallback_glob_unavailable",
    }
  }

  return {
    ...resultBase,
    effectiveGlob,
    corrected: true,
    reason: "requested_language_absent",
  }
}


async function resolveTaskSourceFamilyGlob(
  root,
  target,
  requestedGlob,
  state,
) {
  const legacy =
    await resolveSearchLanguageGlob(
      root,
      target,
      requestedGlob,
      state,
    )

  const profile =
    compileRepoCapabilityProfile({
      inventoryProtocol: legacy.protocol,
      complete: legacy.inventoryComplete === true,
      files: legacy.inventoryFiles ?? 0,
      extensions: legacy.inventoryExtensions ?? {},
    })

  const parsed =
    parseSimpleLanguageGlob(legacy.effectiveGlob)

  const sourceFamilyPlan =
    planTaskSourceFamilies({
      taskRequirements: state?.taskRequirements,
      profile,
      requestedExtensions:
        parsed?.extensions ?? [],
      maxExtensions:
        SOURCE_GLOB_FALLBACK_MAX_EXTENSIONS,
    })

  const base = {
    ...legacy,

    repoCapability: profile,
    sourceFamilyPlan,

    roleBroadened: false,
  }

  if (
    !parsed ||
    sourceFamilyPlan?.applied !== true
  ) {
    return base
  }

  const effectiveGlob =
    buildLanguageGlob(
      parsed.prefix,
      sourceFamilyPlan.effective_extensions,
    )

  if (
    !effectiveGlob ||
    effectiveGlob === legacy.effectiveGlob
  ) {
    return base
  }

  return {
    ...base,

    /*
     * This is routing expansion, not correction of the model request.
     * Keep legacy `corrected/reason` semantics intact and expose a separate
     * role-broadening fact.
     */
    effectiveGlob,
    roleBroadened: true,
  }
}

function isReservedAgentEvidencePath(raw) {
  const normalized = String(raw ?? "")
    .replaceAll("\\", "/")
    .replace(/^\.\/+/, "")

  return (
    normalized === ".opencode" ||
    normalized.startsWith(".opencode/")
  )
}

function bytes(text) {
  return Buffer.byteLength(String(text ?? ""), "utf8")
}

function nowMs() {
  return Date.now()
}

function clipLine(text, max = 500) {
  const line = String(text ?? "").replace(/\r?\n/g, "").trimEnd()
  return line.length <= max ? line : line.slice(0, max) + " …[line clipped]"
}

async function normalizeDirectory(raw) {
  if (typeof raw !== "string" || raw.length === 0) return null

  try {
    const resolved = await realpath(raw)
    const info = await stat(resolved)
    return info.isDirectory() ? resolved : null
  } catch {
    return null
  }
}

async function writeProjectTrace(root, fileName, record) {
  if (!root) return

  try {
    const dir = path.join(root, ".opencode")
    await mkdir(dir, { recursive: true })
    await appendFile(path.join(dir, fileName), JSON.stringify(record) + "\n", "utf8")
    await mirrorProjectTraceTelemetry(
      root,
      fileName,
      record,
    )
  } catch {
    // Telemetry is best-effort and must never break the agent.
  }
}

function scoutOpaqueKey(value) {
  return createHash("sha256").update(String(value ?? "")).digest("hex").slice(0, 20)
}

function clearTerminalCommitState(state) {
  if (!state) return
  state.terminalCommit = null
  state.terminalCommitSha256 = null
  state.terminalCommitClaims = 0
  state.terminalShortCircuitAttemptedSha256 = null
  state.terminalShortCircuitRequests = 0
  state.terminalShortCircuits = 0
  state.terminalShortCircuitFailures = 0
}

function clearCompletionSafeFailState(state) {
  if (!state) return
  state.completionSafeFail = null
  state.completionSafeFailSha256 = null
  state.completionSafeFailClaims = 0
  state.completionSafeFailShortCircuitAttemptedSha256 = null
  state.completionSafeFailShortCircuitRequests = 0
  state.completionSafeFailShortCircuits = 0
  state.completionSafeFailShortCircuitFailures = 0
}

function completionSafeFailMatchesTask(commit, snapshot) {
  if (!commit || commit.protocol !== COMPLETION_SAFE_FAIL_PROTOCOL) {
    return { ok: false, reason: "completion_safe_fail_invalid" }
  }
  if (!snapshot?.ok || typeof snapshot.turnID !== "string") {
    return { ok: false, reason: "completion_safe_fail_task_unresolved" }
  }
  if (commit.user_turn_id !== snapshot.turnID) {
    return { ok: false, reason: "completion_safe_fail_task_turn_changed" }
  }
  if (commit.task_sha256 !== snapshot.textSha256) {
    return { ok: false, reason: "completion_safe_fail_task_text_drift" }
  }
  return { ok: true, reason: "completion_safe_fail_task_match" }
}

function deriveCompletionSafeFail({
  state,
  persisted,
  completionAuthorization,
}) {
  if (!state || !persisted || !completionAuthorization) {
    return { ok: false, reason: "completion_safe_fail_missing_input" }
  }
  if (completionAuthorization.applicable !== true) {
    return { ok: false, reason: "completion_safe_fail_not_applicable" }
  }
  if (completionAuthorizationPermitsTerminal(completionAuthorization)) {
    return { ok: false, reason: "completion_safe_fail_already_certified" }
  }
  const patchSha = persisted?.receipt?.patch_sha256
  const actionCommitSha = persisted?.receipt?.action_commit_sha256
  if (
    typeof state.taskTurnID !== "string" ||
    typeof state.taskTextSha256 !== "string" ||
    !/^[0-9a-f]{64}$/.test(state.taskTextSha256) ||
    typeof persisted.path !== "string" ||
    typeof persisted.verificationPath !== "string" ||
    typeof persisted.receiptSha256 !== "string" ||
    !/^[0-9a-f]{64}$/.test(persisted.receiptSha256) ||
    typeof persisted.verificationSha256 !== "string" ||
    !/^[0-9a-f]{64}$/.test(persisted.verificationSha256) ||
    typeof patchSha !== "string" ||
    !/^[0-9a-f]{64}$/.test(patchSha) ||
    typeof actionCommitSha !== "string" ||
    !/^[0-9a-f]{64}$/.test(actionCommitSha)
  ) {
    return { ok: false, reason: "completion_safe_fail_identity_invalid" }
  }

  const canonical = {
    protocol: COMPLETION_SAFE_FAIL_PROTOCOL,
    outcome: COMPLETION_SAFE_FAIL_OUTCOME,
    reason: completionAuthorization.reason ?? "completion_authorizer_unavailable",
    completion_authorizer_transport_ok:
      completionAuthorization.transport_ok === true,
    completion_authorizer_decision:
      completionAuthorization.decision ?? null,
    user_turn_id: state.taskTurnID,
    task_sha256: state.taskTextSha256,
    action_commit_sha256: actionCommitSha,
    patch_receipt_path: persisted.path,
    patch_receipt_sha256: persisted.receiptSha256,
    verification_receipt_path: persisted.verificationPath,
    verification_receipt_sha256: persisted.verificationSha256,
    patch_sha256: patchSha,
  }
  const commitSha256 = createHash("sha256")
    .update(JSON.stringify(canonical))
    .digest("hex")
  return {
    ok: true,
    reason: "completion_safe_fail_ready",
    commit: { ...canonical, commit_sha256: commitSha256 },
  }
}

function claimCompletionSafeFail(state, commit) {
  if (
    !state ||
    commit?.protocol !== COMPLETION_SAFE_FAIL_PROTOCOL ||
    !/^[0-9a-f]{64}$/.test(commit?.commit_sha256 ?? "")
  ) {
    return { ok: false, reason: "completion_safe_fail_invalid" }
  }
  if (state.completionSafeFailSha256) {
    return {
      ok: state.completionSafeFailSha256 === commit.commit_sha256,
      reason:
        state.completionSafeFailSha256 === commit.commit_sha256
          ? "completion_safe_fail_duplicate"
          : "completion_safe_fail_conflict",
    }
  }
  state.completionSafeFail = commit
  state.completionSafeFailSha256 = commit.commit_sha256
  state.completionSafeFailClaims = 1
  return { ok: true, reason: "completion_safe_fail_claimed" }
}

async function terminalArtifactSha256(root, rawPath) {
  if (
    !root ||
    typeof rawPath !== "string" ||
    rawPath.length < 1 ||
    rawPath.startsWith("/") ||
    rawPath.includes("\0")
  ) {
    return null
  }

  const resolved = path.resolve(root, rawPath)
  if (
    resolved === root ||
    !resolved.startsWith(root + path.sep)
  ) {
    return null
  }

  try {
    const info = await stat(resolved)
    if (
      !info.isFile() ||
      info.size < 1 ||
      info.size > TERMINAL_ARTIFACT_MAX_BYTES
    ) {
      return null
    }
    const body = await readFile(resolved)
    return createHash("sha256").update(body).digest("hex")
  } catch {
    return null
  }
}

async function validateTerminalCommitArtifacts(root, commit) {
  const checks = await Promise.all([
    terminalArtifactSha256(root, commit?.patch_receipt_path),
    terminalArtifactSha256(root, commit?.verification_receipt_path),
    terminalArtifactSha256(root, commit?.patch_path),
  ])

  if (checks[0] !== commit?.patch_receipt_sha256) {
    return { ok: false, reason: "terminal_patch_receipt_stale" }
  }
  if (checks[1] !== commit?.verification_receipt_sha256) {
    return { ok: false, reason: "terminal_verification_receipt_stale" }
  }
  if (checks[2] !== commit?.patch_sha256) {
    return { ok: false, reason: "terminal_patch_stale" }
  }

  return { ok: true, reason: "terminal_artifacts_match" }
}

function scoutFingerprintKey(fingerprint) {
  if (!fingerprint) return null
  if (fingerprint.kind === "sha256" && typeof fingerprint.sha256 === "string") {
    return `sha256:${fingerprint.sha256}`
  }
  if (Number.isFinite(fingerprint.size) && Number.isFinite(fingerprint.mtime_ms)) {
    return `stat:${fingerprint.size}:${fingerprint.mtime_ms}`
  }
  return null
}

function scoutNormalizeWitnessText(text) {
  return String(text ?? "").replace(/\r?\n$/, "")
}

async function scoutFileFingerprint(root, rawFile, witnesses = []) {
  const file = evidenceFileKey(rawFile)
  if (!file) return null
  const resolved = path.resolve(root, file)
  if (resolved === root || !resolved.startsWith(root + path.sep)) return null

  try {
    const info = await stat(resolved)
    if (!info.isFile()) return null
    const base = { size: info.size, mtime_ms: Math.trunc(info.mtimeMs) }
    if (info.size > SCOUT_HANDOFF_HASH_MAX_BYTES) {
      return { kind: "size_mtime", strong: false, ...base }
    }
    const body = await readFile(resolved)
    const lines = body.toString("utf8").split(/\r?\n/)
    const bodySha256 = createHash("sha256").update(body).digest("hex")
    let evidenceFresh = true
    let witnessesChecked = 0
    for (const witness of witnesses) {
      if (!Number.isInteger(witness?.line) || witness.line < 1) continue

      const expectedSha =
        typeof witness?.sha256 === "string" &&
        /^[0-9a-f]{64}$/iu.test(witness.sha256)
          ? witness.sha256.toLowerCase()
          : null

      const expectedText =
        typeof witness?.text === "string"
          ? witness.text
          : null

      if (!expectedSha && expectedText === null) continue

      witnessesChecked += 1

      if (witness.line > lines.length) {
        evidenceFresh = false
        break
      }

      if (expectedSha && expectedSha !== bodySha256) {
        evidenceFresh = false
        break
      }

      if (
        expectedText !== null &&
        scoutNormalizeWitnessText(lines[witness.line - 1] ?? "") !==
          scoutNormalizeWitnessText(expectedText)
      ) {
        evidenceFresh = false
        break
      }
    }
    return {
      kind: "sha256",
      strong: true,
      sha256: bodySha256,
      evidence_fresh: evidenceFresh,
      witnesses_checked: witnessesChecked,
      ...base,
    }
  } catch {
    return null
  }
}

async function writeLocalMutationHandoff(
  root,
  sessionID,
  turnID,
  bundle,
  discriminator = "primary",
) {
  if (!root || !sessionID || !bundle) return null

  const dir = path.join(
    root,
    ".opencode",
    "scout-handoffs",
    "capabilities",
  )
  const key = scoutOpaqueKey(
    `${sessionID}:${turnID ?? ""}:local-mutation:${discriminator}`,
  )
  const finalPath = path.join(dir, `${key}.json`)
  const tempPath = `${finalPath}.${process.pid}.${nowMs()}.tmp`

  try {
    await mkdir(dir, { recursive: true })
    await writeFile(
      tempPath,
      JSON.stringify(bundle, null, 2) + "\n",
      "utf8",
    )
    await rename(tempPath, finalPath)
    return path.relative(root, finalPath)
  } catch {
    await rm(tempPath, { force: true }).catch(() => {})
    return null
  }
}

async function writeScoutHandoff(root, sessionID, bundle) {
  if (!root || !sessionID) return null
  const dir = path.join(root, ".opencode", "scout-handoffs")
  const finalPath = path.join(dir, `${scoutOpaqueKey(sessionID)}.json`)
  const tempPath = `${finalPath}.${process.pid}.${nowMs()}.tmp`
  try {
    await mkdir(dir, { recursive: true })
    await writeFile(tempPath, JSON.stringify(bundle, null, 2) + "\n", "utf8")
    await rename(tempPath, finalPath)
    return path.relative(root, finalPath)
  } catch {
    await rm(tempPath, { force: true }).catch(() => {})
    return null
  }
}


function frameworkResourceEdgeFact(edge) {
  return evidenceFact("framework_edge", [
    edge?.kind ?? null,
    edge?.from ?? null,
    edge?.to ?? null,
    evidenceFileKey(edge?.witness?.file),
    edge?.witness?.line ?? null,
    edge?.witness?.sha256 ?? null,
  ])
}

function frameworkResourceEdgeKey(edge) {
  return JSON.stringify([
    edge?.kind ?? null,
    edge?.from ?? null,
    edge?.to ?? null,
    evidenceFileKey(edge?.witness?.file),
    edge?.witness?.line ?? null,
    edge?.witness?.sha256 ?? null,
  ])
}

const ANCHOR_FRONTIER_MAX_CANDIDATE_FILES = 8
const ANCHOR_FRONTIER_TIMEOUT_MS = 500
const ANCHOR_FRONTIER_MAX_STDOUT_BYTES = 128 * 1024

const NAVIGATION_REVERSE_MAX_CANDIDATE_FILES = 8
const NAVIGATION_REVERSE_TIMEOUT_MS = 500
const NAVIGATION_REVERSE_MAX_STDOUT_BYTES = 128 * 1024

const HOST_RESOURCE_INVENTORY_MAX_FILES = 20_000
const HOST_RESOURCE_INVENTORY_TIMEOUT_MS = 500
const HOST_RESOURCE_INVENTORY_MAX_STDOUT_BYTES = 2 * 1024 * 1024


function boundedInternalRgNullList(
  root,
  args,
  {
    maxFiles,
    timeoutMs,
    maxStdoutBytes,
  },
) {
  return new Promise((resolve) => {
    const started =
      performance.now()

    let stdoutBytes = 0
    const chunks = []

    let timedOut = false
    let byteCapped = false
    let spawnError = null
    let settled = false

    let child

    try {
      child = spawn(
        "rg",
        args,
        {
          cwd: root,
          stdio: [
            "ignore",
            "pipe",
            "ignore",
          ],
        },
      )
    } catch (error) {
      resolve({
        files: [],
        complete: false,
        timedOut: false,
        scanCapped: false,
        error:
          String(
            error?.message ??
            error,
          ),
        elapsedMs:
          Math.round(
            (
              performance.now() -
              started
            ) * 100,
          ) / 100,
      })

      return
    }

    const timer =
      setTimeout(
        () => {
          timedOut = true

          try {
            child.kill(
              "SIGKILL",
            )
          } catch {
            // Best effort watchdog.
          }
        },
        timeoutMs,
      )

    child.on(
      "error",
      (error) => {
        spawnError =
          String(
            error?.message ??
            error,
          )
      },
    )

    child.stdout.on(
      "data",
      (chunk) => {
        if (byteCapped) {
          return
        }

        const buffer =
          Buffer.isBuffer(chunk)
            ? chunk
            : Buffer.from(chunk)

        if (
          stdoutBytes +
            buffer.length >
          maxStdoutBytes
        ) {
          byteCapped = true

          try {
            child.kill(
              "SIGKILL",
            )
          } catch {
            // Best effort cap.
          }

          return
        }

        stdoutBytes +=
          buffer.length

        chunks.push(buffer)
      },
    )

    child.on(
      "close",
      (code) => {
        if (settled) {
          return
        }

        settled = true
        clearTimeout(timer)

        const raw =
          Buffer.concat(
            chunks,
          ).toString(
            "utf8",
          )

        const observed =
          [
            ...new Set(
              raw
                .split("\0")
                .map(
                  (value) =>
                    evidenceFileKey(
                      value,
                    ),
                )
                .filter(
                  (value) =>
                    value &&
                    value !== "." &&
                    !value.startsWith("../") &&
                    !path.isAbsolute(value),
                ),
            ),
          ].sort()

        const fileCapped =
          observed.length >
          maxFiles

        const files =
          observed.slice(
            0,
            maxFiles,
          )

        /*
         * rg:
         *   0 = matches/files
         *   1 = complete zero-result search
         *
         * Both are deterministic complete outcomes.
         */
        const cleanExit =
          code === 0 ||
          code === 1

        const scanCapped =
          byteCapped ||
          fileCapped

        const complete =
          cleanExit &&
          !timedOut &&
          !scanCapped &&
          !spawnError

        resolve({
          files,
          complete,
          timedOut,
          scanCapped,
          error:
            spawnError,

          elapsedMs:
            Math.round(
              (
                performance.now() -
                started
              ) * 100,
            ) / 100,
        })
      },
    )
  })
}


async function discoverTaskAnchorFrontierFiles(
  root,
  taskAnchors,
) {
  const routeAnchors =
    routeAnchorValues(
      taskAnchors,
    )

  if (routeAnchors.length < 1) {
    return {
      protocol:
        "anchor-frontier-discovery-v1",

      route_anchors: [],
      candidate_files: [],

      route_results: [],

      search_complete: true,
      search_truncated: false,

      elapsed_ms: 0,
    }
  }

  const started =
    performance.now()

  const routeResults = []

  for (const route of routeAnchors) {
    const args = [
      "--files-with-matches",
      "--null",
      "--fixed-strings",
      "--no-messages",

      /*
       * Current first-class route-bearing source families.
       * Unsupported languages simply fail closed at parser
       * validation rather than becoming heuristic evidence.
       */
      "-g",
      "*.{py,pyi,js,jsx,ts,tsx,mjs,cjs}",
    ]

    for (const pattern of EXCLUDES) {
      args.push(
        "-g",
        pattern,
      )
    }

    args.push(
      "--",
      route,
      ".",
    )

    const result =
      await boundedInternalRgNullList(
        root,
        args,
        {
          maxFiles:
            ANCHOR_FRONTIER_MAX_CANDIDATE_FILES +
            1,

          timeoutMs:
            ANCHOR_FRONTIER_TIMEOUT_MS,

          maxStdoutBytes:
            ANCHOR_FRONTIER_MAX_STDOUT_BYTES,
        },
      )

    routeResults.push({
      route,
      ...result,
    })
  }

  const allFiles =
    [
      ...new Set(
        routeResults
          .flatMap(
            (result) =>
              result.files,
          ),
      ),
    ].sort()

  const totalCapped =
    allFiles.length >
    ANCHOR_FRONTIER_MAX_CANDIDATE_FILES

  const candidateFiles =
    allFiles.slice(
      0,
      ANCHOR_FRONTIER_MAX_CANDIDATE_FILES,
    )

  const searchTruncated =
    totalCapped ||
    routeResults.some(
      (result) =>
        result.scanCapped ===
        true,
    )

  const searchComplete =
    !searchTruncated &&
    routeResults.every(
      (result) =>
        result.complete ===
        true,
    )

  return {
    protocol:
      "anchor-frontier-discovery-v1",

    route_anchors:
      routeAnchors,

    candidate_files:
      candidateFiles,

    route_results:
      routeResults,

    search_complete:
      searchComplete,

    search_truncated:
      searchTruncated,

    elapsed_ms:
      Math.round(
        (
          performance.now() -
          started
        ) * 100,
      ) / 100,
  }
}


function navigationIncludeTargetLiterals(
  resourceNodes,
) {
  const nodes =
    Array.isArray(resourceNodes)
      ? resourceNodes
      : []

  return [
    ...new Set(
      nodes
        .map(
          (node) => {
            if (
              typeof node !== "string" ||
              !node.startsWith(
                "template:",
              )
            ) {
              return null
            }

            const value =
              node.slice(
                "template:".length,
              )

            if (
              value.length < 1 ||
              value.startsWith("/") ||
              value.includes("..")
            ) {
              return null
            }

            return value
          },
        )
        .filter(Boolean),
    ),
  ].sort()
}


async function discoverNavigationReverseIncluderFiles(
  root,
  resourceNodes,
) {
  const targetLiterals =
    navigationIncludeTargetLiterals(
      resourceNodes,
    )

  if (targetLiterals.length < 1) {
    return {
      protocol:
        "navigation-reverse-frontier-v1",

      target_literals: [],
      candidate_files: [],

      search_complete: true,
      search_truncated: false,

      elapsed_ms: 0,
    }
  }

  const started =
    performance.now()

  const results = []

  for (const target of targetLiterals) {
    const args = [
      "--files-with-matches",
      "--null",
      "--fixed-strings",
      "--no-messages",

      /*
       * Current first-class template/resource-bearing source
       * family. Parser validation remains authoritative for
       * relation evidence.
       */
      "-g",
      "*.{html,htm,jinja,jinja2,j2}",
    ]

    for (const pattern of EXCLUDES) {
      args.push(
        "-g",
        pattern,
      )
    }

    args.push(
      "--",
      target,
      ".",
    )

    const result =
      await boundedInternalRgNullList(
        root,
        args,
        {
          /*
           * +1 detects that the observed candidate set is not
           * exhaustive. Positive sharedness proof does not
           * require exhaustive discovery.
           */
          maxFiles:
            NAVIGATION_REVERSE_MAX_CANDIDATE_FILES +
            1,

          timeoutMs:
            NAVIGATION_REVERSE_TIMEOUT_MS,

          maxStdoutBytes:
            NAVIGATION_REVERSE_MAX_STDOUT_BYTES,
        },
      )

    results.push({
      target,
      ...result,
    })
  }

  const allFiles =
    [
      ...new Set(
        results.flatMap(
          (result) =>
            result.files,
        ),
      ),
    ].sort()

  const totalCapped =
    allFiles.length >
    NAVIGATION_REVERSE_MAX_CANDIDATE_FILES

  const candidateFiles =
    allFiles.slice(
      0,
      NAVIGATION_REVERSE_MAX_CANDIDATE_FILES,
    )

  const searchTruncated =
    totalCapped ||
    results.some(
      (result) =>
        result.scanCapped === true,
    )

  const searchComplete =
    !searchTruncated &&
    results.every(
      (result) =>
        result.complete === true,
    )

  return {
    protocol:
      "navigation-reverse-frontier-v1",

    target_literals:
      targetLiterals,

    candidate_files:
      candidateFiles,

    search_complete:
      searchComplete,

    search_truncated:
      searchTruncated,

    elapsed_ms:
      Math.round(
        (
          performance.now() -
          started
        ) * 100,
      ) / 100,
  }
}


async function observedHostResourceInventory(
  root,
  state,
) {
  const cacheKey =
    `host-resource-inventory-v2:${root}`

  const cached =
    state
      ?.sourceInventoryCache
      ?.get(
        cacheKey,
      )

  if (
    cached &&
    cached.protocol ===
      "host-resource-inventory-v2"
  ) {
    return {
      ...cached,
      cache_hit: true,
    }
  }

  const args = [
    "--files",
    "--null",
    "--no-messages",
  ]

  for (const pattern of EXCLUDES) {
    args.push(
      "-g",
      pattern,
    )
  }

  const result =
    await boundedInternalRgNullList(
      root,
      args,
      {
        maxFiles:
          HOST_RESOURCE_INVENTORY_MAX_FILES,

        timeoutMs:
          HOST_RESOURCE_INVENTORY_TIMEOUT_MS,

        maxStdoutBytes:
          HOST_RESOURCE_INVENTORY_MAX_STDOUT_BYTES,
      },
    )

  const inventory = {
    protocol:
      "host-resource-inventory-v2",

    authority:
      "routing_inventory_only",

    files:
      result.files,

    complete:
      result.complete ===
      true,

    timed_out:
      result.timedOut ===
      true,

    truncated:
      result.scanCapped ===
      true,

    error:
      result.error ??
      null,

    elapsed_ms:
      result.elapsedMs,

    cache_hit:
      false,

    mutation_authority:
      false,
  }

  if (
    state?.sourceInventoryCache
      instanceof Map
  ) {
    state.sourceInventoryCache.set(
      cacheKey,
      inventory,
    )
  }

  return inventory
}


async function inspectFrameworkRoutingForSelected(
  root,
  selectedFiles,
  state,
  options = null,
) {
  const routeFacts = new Set()
  const frameworks = new Set()
  const edgeKinds = new Set()

  let filesScanned = 0
  let witnesses = 0
  let edgeCandidates = 0
  let validatedEdges = 0
  let rejectedEdges = 0
  let skippedFiles = 0
  let truncated = false

  const selected = (
    Array.isArray(selectedFiles)
      ? selectedFiles
      : []
  ).slice(0, FRAMEWORK_ROUTING_MAX_FILES)

  if (
    Array.isArray(selectedFiles) &&
    selectedFiles.length > selected.length
  ) {
    truncated = true
  }

  for (const entry of selected) {
    const rawFile =
      typeof entry === "string"
        ? entry
        : entry?.file

    const file = evidenceFileKey(rawFile)

    if (
      !file ||
      file === "." ||
      file.startsWith("../") ||
      path.isAbsolute(file)
    ) {
      skippedFiles += 1
      continue
    }

    let safeFile

    try {
      safeFile = await safeTarget(root, file)
    } catch {
      skippedFiles += 1
      continue
    }

    if (safeFile === ".") {
      skippedFiles += 1
      continue
    }

    const absolute = path.join(root, safeFile)

    let info

    try {
      info = await stat(absolute)
    } catch {
      skippedFiles += 1
      continue
    }

    if (
      !info.isFile() ||
      info.size > FRAMEWORK_ROUTING_MAX_FILE_BYTES
    ) {
      skippedFiles += 1
      continue
    }

    let text

    try {
      text = await readFile(absolute, "utf8")
    } catch {
      skippedFiles += 1
      continue
    }

    let inspected

    try {
      inspected = inspectFrameworkResourceFile({
        sourcePath: file,
        text,
        maxWitnesses:
          FRAMEWORK_ROUTING_MAX_EDGES_PER_FILE * 2,
        maxEdges:
          FRAMEWORK_ROUTING_MAX_EDGES_PER_FILE,

        routeTargets:
          options?.routeTargets ??
          null,

        includeTargets:
          options?.includeTargets ??
          null,
      })
    } catch {
      skippedFiles += 1
      continue
    }

    filesScanned += 1
    witnesses += inspected.witnesses.length
    edgeCandidates += inspected.edge_candidates.length
    rejectedEdges +=
      inspected.rejected_edge_candidates.length

    truncated ||= inspected.truncated === true

    for (const framework of inspected.frameworks) {
      frameworks.add(framework)
    }

    for (const edge of inspected.resource_edges) {
      if (
        validatedEdges >=
        FRAMEWORK_ROUTING_MAX_EDGES_PER_TURN
      ) {
        truncated = true
        break
      }

      validatedEdges += 1
      edgeKinds.add(edge.kind)

      routeFacts.add(
        frameworkResourceEdgeFact(edge),
      )

      if (
        state?.frameworkResourceEdges instanceof Map &&
        state.frameworkResourceEdges.size <
          FRAMEWORK_ROUTING_MAX_EDGES_PER_TURN
      ) {
        state.frameworkResourceEdges.set(
          frameworkResourceEdgeKey(edge),
          edge,
        )
      }
    }
  }

  return {
    protocol:
      FRAMEWORK_RESOURCE_BRIDGE_PROTOCOL,

    authority: "routing_only",
    mutationAuthority: false,

    filesScanned,
    skippedFiles,

    frameworks:
      [...frameworks].sort(),

    witnesses,
    edgeCandidates,
    validatedEdges,
    rejectedEdges,

    edgeKinds:
      [...edgeKinds].sort(),

    routeFacts,
    truncated,
  }
}


function resourceAdapterEdgeKey(edge) {
  return JSON.stringify([
    edge?.kind ?? null,
    edge?.from ?? null,
    edge?.to ?? null,
    evidenceFileKey(edge?.witness?.file),
    edge?.witness?.line ?? null,
    edge?.witness?.sha256 ?? null,
  ])
}

async function inspectResourceRoutingForSelected(
  root,
  selectedFiles,
  state,
) {
  const families = new Set()
  const edgeKinds = new Set()

  let filesScanned = 0
  let witnesses = 0
  let edgeCandidates = 0
  let validatedEdges = 0
  let rejectedEdges = 0
  let skippedFiles = 0
  let truncated = false

  const selected = (
    Array.isArray(selectedFiles)
      ? selectedFiles
      : []
  ).slice(
    0,
    RESOURCE_ROUTING_MAX_FILES,
  )

  if (
    Array.isArray(selectedFiles) &&
    selectedFiles.length >
      selected.length
  ) {
    truncated = true
  }

  for (const entry of selected) {
    const rawFile =
      typeof entry === "string"
        ? entry
        : entry?.file

    const file =
      evidenceFileKey(rawFile)

    if (
      !file ||
      file === "." ||
      file.startsWith("../") ||
      path.isAbsolute(file)
    ) {
      skippedFiles += 1
      continue
    }

    let safeFile

    try {
      safeFile =
        await safeTarget(
          root,
          file,
        )
    } catch {
      skippedFiles += 1
      continue
    }

    if (safeFile === ".") {
      skippedFiles += 1
      continue
    }

    const absolute =
      path.join(
        root,
        safeFile,
      )

    let info

    try {
      info =
        await stat(
          absolute,
        )
    } catch {
      skippedFiles += 1
      continue
    }

    if (
      !info.isFile() ||
      info.size >
        RESOURCE_ROUTING_MAX_FILE_BYTES
    ) {
      skippedFiles += 1
      continue
    }

    let text

    try {
      text =
        await readFile(
          absolute,
          "utf8",
        )
    } catch {
      skippedFiles += 1
      continue
    }

    let inspected

    try {
      inspected =
        inspectResourceAdapterFile({
          sourcePath:
            file,

          text,

          maxWitnesses:
            RESOURCE_ROUTING_MAX_EDGES_PER_FILE
            * 2,

          maxEdges:
            RESOURCE_ROUTING_MAX_EDGES_PER_FILE,
        })
    } catch {
      skippedFiles += 1
      continue
    }

    filesScanned += 1

    witnesses +=
      inspected.witnesses.length

    edgeCandidates +=
      inspected.edge_candidates.length

    rejectedEdges +=
      inspected
        .rejected_edge_candidates
        .length

    truncated ||=
      inspected.truncated === true

    for (
      const family of
      inspected.families
    ) {
      families.add(family)
    }

    for (
      const edge of
      inspected.resource_edges
    ) {
      if (
        validatedEdges >=
        RESOURCE_ROUTING_MAX_EDGES_PER_TURN
      ) {
        truncated = true
        break
      }

      validatedEdges += 1

      edgeKinds.add(
        edge.kind,
      )

      /*
       * Shadow state only.
       *
       * Do NOT add these edges to:
       * - evidenceLedger
       * - routeLedger
       * - taskRoleEvidence
       *
       * E0 observes topology; it does not change Scout decisions.
       */
      if (
        state?.resourceAdapterEdges
          instanceof Map &&
        state.resourceAdapterEdges.size <
          RESOURCE_ROUTING_MAX_EDGES_PER_TURN
      ) {
        state.resourceAdapterEdges.set(
          resourceAdapterEdgeKey(
            edge,
          ),
          edge,
        )
      }
    }
  }

  return {
    protocol:
      RESOURCE_ADAPTER_BRIDGE_PROTOCOL,

    authority:
      "routing_only",

    mutationAuthority:
      false,

    filesScanned,
    skippedFiles,

    families:
      [...families].sort(),

    witnesses,
    edgeCandidates,
    validatedEdges,
    rejectedEdges,

    edgeKinds:
      [...edgeKinds].sort(),

    truncated,
  }
}

function taskCausalShadowForState(
  state,
) {
  const edges = []

  if (
    state?.frameworkResourceEdges
      instanceof Map
  ) {
    edges.push(
      ...state
        .frameworkResourceEdges
        .values(),
    )
  }

  if (
    state?.resourceAdapterEdges
      instanceof Map
  ) {
    edges.push(
      ...state
        .resourceAdapterEdges
        .values(),
    )
  }

  return runTaskCausalShadow({
    taskAnchors:
      state?.taskAnchors,

    edges,

    maxHops:
      TASK_CAUSAL_SHADOW_MAX_HOPS,

    maxNodes:
      TASK_CAUSAL_SHADOW_MAX_NODES,

    maxEdges:
      TASK_CAUSAL_SHADOW_MAX_EDGES,
  })
}

function scoutEvidenceWitnesses(hits, selectedFiles) {
  const selected = new Set((selectedFiles ?? []).map((entry) => evidenceFileKey(entry?.file)))
  const witnesses = new Map()
  const push = (file, line, text) => {
    if (!file || !selected.has(file) || !Number.isInteger(line) || typeof text !== "string") return
    if (!witnesses.has(file)) witnesses.set(file, [])
    const values = witnesses.get(file)
    if (values.length < SCOUT_HANDOFF_MAX_LINES_PER_FILE) values.push({ line, text })
  }
  for (const hit of hits?.values?.() ?? []) push(evidenceFileKey(hit?.file), hit?.line, hit?.text)
  for (const entry of selectedFiles ?? []) {
    push(evidenceFileKey(entry?.file), entry?.impact?.sample?.line, entry?.impact?.sample?.text)
  }
  return witnesses
}

function scoutEvidenceLines(hits, selectedFiles) {
  const selected = new Set((selectedFiles ?? []).map((entry) => evidenceFileKey(entry?.file)))
  const lines = new Map()
  for (const hit of hits?.values?.() ?? []) {
    const file = evidenceFileKey(hit?.file)
    if (!file || !selected.has(file) || !Number.isInteger(hit?.line)) continue
    if (!lines.has(file)) lines.set(file, new Set())
    lines.get(file).add(hit.line)
  }
  for (const entry of selectedFiles ?? []) {
    const file = evidenceFileKey(entry?.file)
    const line = entry?.impact?.sample?.line
    if (!file || !Number.isInteger(line)) continue
    if (!lines.has(file)) lines.set(file, new Set())
    lines.get(file).add(line)
  }
  return lines
}

function serializeScoutFile(entry) {
  return {
    file: entry.file,
    origins: [...entry.origins].sort(),
    queries: [...entry.queries].sort((a, b) => a - b),
    evidence_lines: [...entry.evidenceLines].sort((a, b) => a - b).slice(0, SCOUT_HANDOFF_MAX_LINES_PER_FILE),
    evidence_lines_truncated: entry.evidenceLines.size > SCOUT_HANDOFF_MAX_LINES_PER_FILE,
    fingerprint: entry.fingerprint,
    changed_during_scout: entry.changedDuringScout === true,
    impact: [...entry.impact.values()].sort((a, b) =>
      String(a.seed).localeCompare(String(b.seed)) ||
      String(a.direction).localeCompare(String(b.direction)) ||
      String(a.validation_kind).localeCompare(String(b.validation_kind)),
    ),
  }
}

async function buildScoutEvidenceContext(root, evidenceClosure) {
  const rows = []

  for (const item of evidenceClosure?.files ?? []) {
    const file = evidenceFileKey(item?.file)
    if (!file) continue

    const witnesses = (item?.witnesses ?? [])
      .filter((witness) =>
        Number.isInteger(witness?.line) &&
        witness.line >= 1 &&
        typeof witness?.sha256 === "string" &&
        /^[0-9a-f]{64}$/iu.test(witness.sha256),
      )
      .map((witness) => ({
        line: witness.line,
        sha256: witness.sha256.toLowerCase(),
        extractor: witness?.extractor ?? null,
      }))

    const fingerprint = await scoutFileFingerprint(
      root,
      file,
      witnesses,
    )

    rows.push({
      file,
      roles: [...new Set(item?.roles ?? [])]
        .filter((role) => typeof role === "string" && role.length > 0)
        .sort(),
      evidence_lines: [...new Set(witnesses.map((witness) => witness.line))]
        .sort((a, b) => a - b),
      fingerprint,
      authority: "localization_context_only",
      mutation_authority: false,
    })
  }

  return rows.sort((a, b) => a.file.localeCompare(b.file))
}

function scoutEvidenceContextPriority(row) {
  const roles = new Set(row?.roles ?? [])
  if (roles.has("task_anchor_owner")) return 0
  if (roles.has("ui_host")) return 1
  if (roles.has("navigation_host")) return 2
  if (roles.has("data_access_capability")) return 3
  return 9
}

async function renderScoutEvidenceClosureContext(
  root,
  evidenceClosure,
  maxBytes,
) {
  const limit = Number.isSafeInteger(maxBytes) && maxBytes > 0
    ? maxBytes
    : 0

  if (
    !evidenceClosure ||
    evidenceClosure.status === "not_applicable" ||
    limit < 1
  ) {
    return {
      content: "",
      bytes: 0,
      filesShown: 0,
      truncated: false,
      abstainedFiles: 0,
    }
  }

  const required = (evidenceClosure.required_roles ?? []).join(",") || "none"
  const covered = (evidenceClosure.covered_roles ?? []).join(",") || "none"
  const missing = (evidenceClosure.missing_roles ?? []).join(",") || "none"
  const ambiguous = (evidenceClosure.ambiguous_roles ?? []).join(",") || "none"
  const header =
    `SCOUT_EVIDENCE_CLOSURE status=${evidenceClosure.status} ` +
    `required=${required} covered=${covered} missing=${missing} ambiguous=${ambiguous} ` +
    `authority=localization_context_only mutation_authority=false`

  if (bytes(header) > limit) {
    return {
      content: "",
      bytes: 0,
      filesShown: 0,
      truncated: true,
      abstainedFiles: 0,
    }
  }

  const lines = [header]
  let used = bytes(header)
  let filesShown = 0
  let truncated = evidenceClosure.truncated === true
  let abstainedFiles = 0

  const rows = [...(evidenceClosure.files ?? [])].sort((a, b) =>
    scoutEvidenceContextPriority(a) - scoutEvidenceContextPriority(b) ||
    String(evidenceFileKey(a?.file) ?? "").localeCompare(
      String(evidenceFileKey(b?.file) ?? ""),
    ),
  )

  for (const row of rows) {
    const file = evidenceFileKey(row?.file)
    const witnesses = (row?.witnesses ?? [])
      .filter((witness) =>
        Number.isInteger(witness?.line) &&
        witness.line >= 1 &&
        typeof witness?.sha256 === "string" &&
        /^[0-9a-f]{64}$/iu.test(witness.sha256),
      )
      .sort((a, b) => a.line - b.line)

    if (!file || witnesses.length < 1) {
      abstainedFiles += 1
      truncated = true
      continue
    }

    const digests = [...new Set(witnesses.map((witness) => witness.sha256.toLowerCase()))]
    if (digests.length !== 1) {
      abstainedFiles += 1
      truncated = true
      continue
    }

    let safeFile
    try {
      safeFile = await safeTarget(root, file)
    } catch {
      abstainedFiles += 1
      truncated = true
      continue
    }

    let source
    try {
      const info = await stat(path.join(root, safeFile))
      if (!info.isFile() || info.size > SCOUT_HANDOFF_HASH_MAX_BYTES) {
        abstainedFiles += 1
        truncated = true
        continue
      }
      source = await readFile(path.join(root, safeFile))
    } catch {
      abstainedFiles += 1
      truncated = true
      continue
    }

    const inspection = inspectEvidence({
      request: {
        file,
        line: witnesses[0].line,
        radius: 3,
      },
      allowed_files: [{
        file,
        sha256: digests[0],
        evidence_lines: witnesses.map((witness) => witness.line),
      }],
      source,
    })

    if (inspection?.status !== "OK") {
      abstainedFiles += 1
      truncated = true
      continue
    }

    const roles = [...new Set(row?.roles ?? [])]
      .filter((role) => typeof role === "string" && role.length > 0)
      .sort()
      .join(",") || "context"

    const block = [
      `EVIDENCE_CONTEXT file=${file} roles=${roles} anchor=${inspection.binding.line} ` +
        `sha256=${inspection.binding.sha256} mutation_authority=false`,
      ...inspection.excerpt.map((item) =>
        `  ${String(item.line).padStart(5)} | ${clipLine(item.text)}`,
      ),
    ]

    const blockCost = bytes("\n" + block.join("\n"))
    if (used + blockCost > limit) {
      truncated = true
      continue
    }

    lines.push(...block)
    used += blockCost
    filesShown += 1
  }

  const content = lines.join("\n")
  return {
    content,
    bytes: bytes(content),
    filesShown,
    truncated,
    abstainedFiles,
  }
}

async function updateScoutHandoff(root, sessionID, state, snapshot) {
  if (!state || !sessionID) return null
  const started = performance.now()
  const lineMap = scoutEvidenceLines(snapshot.hits, snapshot.selectedFiles)
  const witnessMap = scoutEvidenceWitnesses(snapshot.hits, snapshot.selectedFiles)
  const contextFiles = await buildScoutEvidenceContext(
    root,
    snapshot.evidenceClosure,
  )
  const fingerprints = await Promise.all((snapshot.selectedFiles ?? []).map(async (selected) => {
    const file = evidenceFileKey(selected?.file)
    return {
      selected,
      file,
      fingerprint: await scoutFileFingerprint(root, selected?.file, witnessMap.get(file) ?? []),
    }
  }))

  for (const item of fingerprints) {
    if (!item.file) continue
    let entry = state.scoutFiles.get(item.file)
    if (!entry) {
      entry = {
        file: item.file, origins: new Set(), queries: new Set(), evidenceLines: new Set(),
        fingerprint: item.fingerprint, changedDuringScout: false, impact: new Map(),
      }
      state.scoutFiles.set(item.file, entry)
    } else {
      const before = scoutFingerprintKey(entry.fingerprint)
      const after = scoutFingerprintKey(item.fingerprint)
      if (before && after && before !== after) entry.changedDuringScout = true
      if (item.fingerprint) entry.fingerprint = item.fingerprint
    }

    entry.origins.add(item.selected?.origin === "impact" ? "impact" : "lexical")
    for (const query of item.selected?.queries ?? []) {
      if (Number.isInteger(query)) entry.queries.add(query)
    }
    for (const line of lineMap.get(item.file) ?? []) entry.evidenceLines.add(line)

    if (item.selected?.origin === "impact") {
      const relation = {
        seed: evidenceFileKey(item.selected?.impact?.seed),
        direction: item.selected?.impact?.direction ?? null,
        bindings: [...new Set(item.selected?.impact?.bindings ?? [])].slice(0, IMPACT_BINDINGS_PER_CANDIDATE),
        validation_kind: item.selected?.impact?.validationKind ?? null,
        sample_line: Number.isInteger(item.selected?.impact?.sample?.line) ? item.selected.impact.sample.line : null,
      }
      const key = JSON.stringify(relation)
      entry.impact.set(key, relation)
    }
  }

  state.scoutSearches.push({
    attempt_index: snapshot.attemptIndex,
    queries: snapshot.queries,
    path: snapshot.target,
    glob: snapshot.glob ?? null,
    representation: snapshot.representation,
    source_representation: snapshot.sourceRepresentation,
    lexical_discovery_complete: snapshot.discoveryComplete,
    scan_complete: snapshot.scanComplete,
    selected_scan_complete: snapshot.selectedScanComplete,
    evidence_complete: snapshot.evidenceComplete,
    selected_evidence_complete: snapshot.selectedEvidenceComplete,
    refinement_required: snapshot.refinementRequired,
    retained_unread_files: snapshot.retainedUnreadFiles,
    retained_unemitted_files: snapshot.retainedUnemittedFiles,
    selected_files: (snapshot.selectedFiles ?? []).map((entry) => evidenceFileKey(entry?.file)).filter(Boolean),
    evidence_closure_protocol: snapshot.evidenceClosure?.protocol ?? null,
    evidence_closure_status: snapshot.evidenceClosure?.status ?? "not_applicable",
    evidence_closure_covered_roles: snapshot.evidenceClosure?.covered_roles ?? [],
    evidence_closure_missing_roles: snapshot.evidenceClosure?.missing_roles ?? [],
    evidence_closure_ambiguous_roles: snapshot.evidenceClosure?.ambiguous_roles ?? [],
    evidence_closure_files: (snapshot.evidenceClosure?.files ?? []).map((entry) => evidenceFileKey(entry?.file)).filter(Boolean),
    evidence_closure_truncated: snapshot.evidenceClosure?.truncated === true,
    impact_index_coverage_complete: snapshot.impactIndexCoverageComplete,
    no_progress: snapshot.noProgress === true,
    no_progress_blocked: snapshot.noProgressBlocked === true,
  })

  if (state.scoutSearches.length > MAX_EXECUTED_SEARCHES_PER_TURN) state.scoutSearches.shift()

  const files = [...state.scoutFiles.values()].map(serializeScoutFile).sort((a, b) => a.file.localeCompare(b.file))
  const latest = state.scoutSearches[state.scoutSearches.length - 1] ?? null
  const blockingReasons = []
  const partialReasons = []

  if (files.length < 1) blockingReasons.push("no_localized_files")
  if (latest?.refinement_required === true) blockingReasons.push("refinement_required")
  if (files.some((entry) => !entry.fingerprint)) blockingReasons.push("fingerprint_unavailable")
  if (files.some((entry) => entry.fingerprint?.strong !== true)) blockingReasons.push("weak_fingerprint")
  if (files.some((entry) => entry.fingerprint?.evidence_fresh === false)) blockingReasons.push("evidence_changed_before_handoff")
  if (files.some((entry) => entry.changed_during_scout === true)) blockingReasons.push("file_changed_during_scout")
  if (contextFiles.some((entry) => !entry.fingerprint)) blockingReasons.push("context_fingerprint_unavailable")
  if (contextFiles.some((entry) => entry.fingerprint?.strong !== true)) blockingReasons.push("weak_context_fingerprint")
  if (contextFiles.some((entry) => entry.fingerprint?.evidence_fresh === false)) {
    blockingReasons.push("context_evidence_changed_before_handoff")
  }
  if (latest?.evidence_closure_status === "insufficient") blockingReasons.push("evidence_sufficiency_missing")
  if (latest?.evidence_closure_status === "ambiguous") blockingReasons.push("evidence_sufficiency_ambiguous")
  if (latest?.evidence_closure_status === "truncated" || latest?.evidence_closure_truncated === true) {
    blockingReasons.push("evidence_closure_truncated")
  }

  if (latest?.lexical_discovery_complete === false) partialReasons.push("lexical_discovery_incomplete")
  if ((latest?.retained_unread_files ?? 0) > 0) partialReasons.push("retained_unread_files")
  if ((latest?.retained_unemitted_files ?? 0) > 0) partialReasons.push("retained_unemitted_files")
  if (latest?.evidence_complete === false) partialReasons.push("evidence_incomplete")
  if (latest?.impact_index_coverage_complete === false) partialReasons.push("impact_index_partial")

  const status = blockingReasons.length > 0 ? "blocked" : partialReasons.length > 0 ? "partial" : "ready"
  const bundle = {
    protocol: SCOUT_HANDOFF_PROTOCOL,
    search_protocol: SEARCH_PROTOCOL,
    session_key: scoutOpaqueKey(sessionID),
    turn_key: scoutOpaqueKey(state.turnID ?? ""),
    generated_at_ms: nowMs(),
    status,
    blocking_reasons: [...new Set(blockingReasons)],
    partial_reasons: [...new Set(partialReasons)],
    budgets: {
      model_calls: state.modelCalls,
      search_attempts: state.searchAttempts,
      executed_searches: state.executedSearches,
      evidence_bytes: state.evidenceBytes,
    },
    evidence_sufficiency: snapshot.evidenceClosure
      ? {
          protocol: snapshot.evidenceClosure.protocol,
          status: snapshot.evidenceClosure.status,
          reason: snapshot.evidenceClosure.reason,
          coverage_status: snapshot.evidenceClosure.coverage_status,
          required_roles: snapshot.evidenceClosure.required_roles,
          covered_roles: snapshot.evidenceClosure.covered_roles,
          missing_roles: snapshot.evidenceClosure.missing_roles,
          ambiguous_roles: snapshot.evidenceClosure.ambiguous_roles,
          files: (snapshot.evidenceClosure.files ?? []).map((entry) => entry.file),
          mutation_authority: false,
        }
      : null,
    context_files: contextFiles,
    searches: state.scoutSearches,
    files,
  }
  const handoffPath = await writeScoutHandoff(root, sessionID, bundle)
  state.scoutHandoffPath = handoffPath
  state.localMutationHandoffPath = null
  state.localMutationCapability = null
  state.localMutationCandidates = []
  state.renameMutationCapability = null
  state.activeMutationHandoffPath = null
  state.boundMutationTarget = null
  return {
    protocol: SCOUT_HANDOFF_PROTOCOL,
    path: handoffPath,
    status,
    files: files.length,
    contextFiles,
    blockingReasons: bundle.blocking_reasons,
    partialReasons: bundle.partial_reasons,
    elapsedMs: Math.round((performance.now() - started) * 100) / 100,
  }
}

function scoutMutationLocalizationEligibility(state, scoutHandoff) {
  const latest =
    state?.scoutSearches?.[state.scoutSearches.length - 1] ?? null

  if (!scoutHandoff?.path) {
    return { eligible: false, reason: "handoff_unavailable" }
  }

  if (
    Array.isArray(scoutHandoff.blockingReasons) &&
    scoutHandoff.blockingReasons.length > 0
  ) {
    return { eligible: false, reason: "handoff_has_blockers" }
  }

  if (scoutHandoff.status === "blocked") {
    return { eligible: false, reason: "handoff_blocked" }
  }

  if ((scoutHandoff.files ?? 0) < 1) {
    return { eligible: false, reason: "no_localized_files" }
  }

  if (!latest) {
    return { eligible: false, reason: "search_snapshot_unavailable" }
  }

  if (latest.lexical_discovery_complete !== true) {
    return { eligible: false, reason: "lexical_discovery_incomplete" }
  }

  // v2.18: global scan_complete is a DISCOVERY completeness fact, not a
  // prerequisite for proving one already-selected structural owner.
  if (latest.selected_scan_complete !== true) {
    return { eligible: false, reason: "selected_scan_incomplete" }
  }

  if (latest.refinement_required === true) {
    return { eligible: false, reason: "refinement_required" }
  }

  if (latest.no_progress_blocked === true) {
    return { eligible: false, reason: "no_progress_blocked" }
  }

  return {
    eligible: true,
    reason:
      scoutHandoff.status === "ready"
        ? "ready_handoff_selected_source_scan"
        : "partial_handoff_selected_source_scan",
  }
}

function localCapabilityPartialReasonsAllowed(reasons) {
  const values = Array.isArray(reasons) ? reasons : []
  return (
    values.length > 0 &&
    values.every((reason) =>
      SCOUT_LOCAL_CAPABILITY_ALLOWED_PARTIAL_REASONS.has(reason),
    )
  )
}

function sameAuthorizedScopeIdentity(a, b) {
  if (!a || !b) return false
  return (
    normalizeMutationFile(a.file) === normalizeMutationFile(b.file) &&
    a.symbol_name === b.symbol_name &&
    a.symbol_kind === b.symbol_kind &&
    a.start_line === b.start_line &&
    a.end_line === b.end_line
  )
}

function ownerEvidenceDistance(line, target) {
  if (!Number.isInteger(line) || !target) return Number.MAX_SAFE_INTEGER
  if (line < target.start_line) return target.start_line - line
  if (line > target.end_line) return line - target.end_line
  return 0
}

function buildOwnerAttestation(editCapsule, target, targetFile) {
  const reject = (reason) => ({
    ok: false,
    protocol: SCOUT_OWNER_ATTESTATION_PROTOCOL,
    reason,
    evidence_lines: [],
    structural_source: null,
    max_distance_lines: null,
  })

  if (!target || !targetFile) return reject("owner_attestation_inputs_missing")

  const evidenceLines = [...new Set(
    (targetFile.evidence_lines ?? [])
      .filter((line) => Number.isInteger(line) && line > 0),
  )].sort((a, b) => a - b)

  if (evidenceLines.length < 1) {
    return reject("owner_attestation_evidence_missing")
  }

  const boundedEvidenceLines = evidenceLines.filter(
    (line) => ownerEvidenceDistance(line, target) <= EDIT_CAPSULE_WINDOW_RADIUS,
  )

  if (boundedEvidenceLines.length < 1) {
    return reject("owner_attestation_evidence_too_far")
  }

  const directEvidenceLines = boundedEvidenceLines.filter(
    (line) => ownerEvidenceDistance(line, target) === 0,
  )

  if (directEvidenceLines.length > 0) {
    return {
      ok: true,
      protocol: SCOUT_OWNER_ATTESTATION_PROTOCOL,
      reason: "direct_owner_evidence",
      evidence_lines: directEvidenceLines,
      structural_source: editCapsule?.structuralSource ?? null,
      max_distance_lines: 0,
    }
  }

  // Evidence immediately adjacent to an owner (for example a Python/TS
  // decorator or annotation) is accepted only when the deterministic
  // structural pipeline independently selected and transactionally
  // authorized exactly this owner. Capability code consumes this generic
  // certificate and does not special-case a recovery algorithm or language.
  if (
    editCapsule?.mutationReady === true &&
    typeof editCapsule?.structuralSource === "string" &&
    editCapsule.structuralSource !== "none" &&
    sameAuthorizedScopeIdentity(
      target,
      editCapsule?.primaryMutationCandidate,
    ) &&
    sameAuthorizedScopeIdentity(
      target,
      editCapsule?.authorizedMutationScope,
    )
  ) {
    return {
      ok: true,
      protocol: SCOUT_OWNER_ATTESTATION_PROTOCOL,
      reason: "structural_owner_certificate",
      evidence_lines: boundedEvidenceLines,
      structural_source: editCapsule.structuralSource,
      max_distance_lines: Math.max(
        ...boundedEvidenceLines.map((line) => ownerEvidenceDistance(line, target)),
      ),
    }
  }

  return reject("owner_attestation_structural_identity_unproven")
}
