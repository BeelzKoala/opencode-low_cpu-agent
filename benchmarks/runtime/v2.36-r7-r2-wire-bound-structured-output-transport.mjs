import assert from "node:assert/strict"
import {
  createHash,
} from "node:crypto"
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs"
import {
  tmpdir,
} from "node:os"
import path from "node:path"

import {
  compileLlGuidanceOpenAICompatibleWireOptions,
  compileArgumentSynthesisDispatch,
  selectArgumentSynthesisTransport,
} from "../../opencode/plugins/cpu-search-core/deterministic-argument-synthesis-v1.mjs"

import {
  LLGUIDANCE_RUNTIME_ATTESTATION_PROTOCOL,
  resolveStructuredOutputRuntimePolicy,
} from "../../opencode/plugins/cpu-search-core/structured-output-runtime-policy-v1.mjs"


function sha256(text) {
  return createHash("sha256")
    .update(text, "utf8")
    .digest("hex")
}

function currentStartTicks() {
  const text = readFileSync(
    `/proc/${process.pid}/stat`,
    "utf8",
  )
  const close = text.lastIndexOf(")")
  return text
    .slice(close + 1)
    .trim()
    .split(/\s+/u)[19]
}

const TOOL = {
  type: "function",
  name: "execute_additive_plan",
  description: "fixture",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["fixed", "contents"],
    properties: {
      fixed: {
        type: "string",
        const: "deterministic",
      },
      contents: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["content"],
          properties: {
            content: {
              type: "string",
              minLength: 1,
            },
          },
        },
      },
    },
  },
}

const MODEL_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["contents"],
  properties: {
    contents:
      TOOL.inputSchema.properties.contents,
  },
}

const PLAN = {
  active: true,
  zero_inference: false,
  model_schema: MODEL_SCHEMA,
  model_tool: null,
}

const CONTRACT = {
  active: true,
  selected_tool: "execute_additive_plan",
  selected_tool_definition: TOOL,
  argument_synthesis_plan: PLAN,
}

const rawTransport = {
  backend: "llguidance",
  wire_mode:
    "openai_compatible_raw_json_schema",
  provider_options_key: "llama",
}

const raw = compileLlGuidanceOpenAICompatibleWireOptions({
  options: {
    providerOptions: {
      llama: {
        temperature_hint: "keep",
      },
      other: {
        untouched: true,
      },
    },
  },
  contract: CONTRACT,
  plan: PLAN,
  transport: rawTransport,
})

assert.deepEqual(
  raw.responseFormat,
  { type: "json" },
)
assert.equal(
  raw.providerOptions.llama.temperature_hint,
  "keep",
)
assert.equal(
  raw.providerOptions.other.untouched,
  true,
)
assert.equal(
  raw.providerOptions.llama.response_format.type,
  "json_schema",
)
assert.equal(
  raw.providerOptions.llama.response_format
    .json_schema.strict,
  true,
)
assert.deepEqual(
  raw.providerOptions.llama.response_format
    .json_schema.schema,
  MODEL_SCHEMA,
)
assert.equal(
  raw.providerOptions.llama.response_format
    .json_schema.name,
  "args_execute_additive_plan",
)

assert.throws(
  () =>
    compileLlGuidanceOpenAICompatibleWireOptions({
      options: {
        providerOptions: {
          llama: {
            response_format: {
              type: "json_object",
            },
          },
        },
      },
      contract: CONTRACT,
      plan: PLAN,
      transport: rawTransport,
    }),
  /raw_response_format_conflict/u,
)

const nativeDispatch =
  compileArgumentSynthesisDispatch({
    options: {
      tools: [TOOL],
      toolChoice: {
        type: "required",
      },
    },
    language: {
      provider: "fixture.chat",
      supportsStructuredOutputs: true,
    },
    contract: CONTRACT,
  })

assert.equal(
  nativeDispatch.mode,
  "json_schema",
)
assert.equal(
  nativeDispatch.transport.wire_mode,
  "provider_native",
)
assert.deepEqual(
  nativeDispatch.options.tools,
  [],
)
assert.equal(
  nativeDispatch.options.toolChoice,
  undefined,
)
assert.deepEqual(
  nativeDispatch.options.responseFormat.schema,
  MODEL_SCHEMA,
)

const root = mkdtempSync(
  path.join(
    tmpdir(),
    "koalik-r7-r2-",
  ),
)

try {
  const attestation =
    path.join(root, "attestation.json")

  const exeStat = statSync(
    `/proc/${process.pid}/exe`,
    { bigint: true },
  )

  const payload = {
    protocol:
      LLGUIDANCE_RUNTIME_ATTESTATION_PROTOCOL,
    epoch: 1_800_000_000,
    base_url: "http://127.0.0.1:8080",
    model: "fixture",
    server_pid: process.pid,
    server_start_ticks:
      currentStartTicks(),
    server_exe_dev: String(exeStat.dev),
    server_exe_ino: String(exeStat.ino),
    server_exe_sha256: "a".repeat(64),
    cmake_cache_sha256: "b".repeat(64),
    schema_sha256: "c".repeat(64),
    response_sha256: "d".repeat(64),
    trials: 3,
    trial_response_sha256: [
      "d".repeat(64),
      "d".repeat(64),
      "d".repeat(64),
    ],
    result: "constrained_schema_exact",
    mutation_authority: false,
  }

  const payloadJson =
    JSON.stringify(payload)

  writeFileSync(
    attestation,
    JSON.stringify({
      protocol:
        LLGUIDANCE_RUNTIME_ATTESTATION_PROTOCOL,
      payload_json: payloadJson,
      proof_sha256:
        sha256(payloadJson),
    }),
    "utf8",
  )

  const rejected =
    resolveStructuredOutputRuntimePolicy(
      {},
      {
        nowEpochSeconds:
          1_800_000_000,
        env: {
          OPENCODE_CPU_LLGUIDANCE_MODE:
            "auto",
          OPENCODE_CPU_LLGUIDANCE_ATTESTATION_PATH:
            attestation,
        },
      },
    )

  // The fixture process is node, not llama-server.
  // The live-process boundary must reject it.
  assert.equal(rejected.active, false)
  assert.equal(
    rejected.reason,
    "llguidance_attested_process_not_llama_server",
  )
} finally {
  rmSync(root, {
    recursive: true,
    force: true,
  })
}

console.log(
  "PASS R7-R2 wire-bound LLGuidance transport " +
  "jsonschema_authority=retained " +
  "provider_native_preserved=true " +
  "raw_openai_compatible_json_schema=true " +
  "sdk_response_format_schema_not_relied_upon=true " +
  "raw_response_format_conflict=fail_closed " +
  "tool_surface_removed=true " +
  "mutation_authority_expansion=false",
)
