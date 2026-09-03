use anyhow::{Context, Result};
use jsonschema::canonicalize;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::io::{self, Read};

const PROTOCOL: &str = "model-abi-compiler-v1";
const MAX_INPUT_BYTES: usize = 2 * 1024 * 1024;

#[derive(Debug, Deserialize)]
struct Request {
    protocol: String,
    #[serde(default = "default_mode")]
    mode: String,
    schema: Value,
    #[serde(default)]
    constraint: Option<Value>,
    #[serde(default = "default_min_savings_bytes")]
    min_savings_bytes: usize,
}

#[derive(Debug, Serialize)]
struct Response {
    ok: bool,
    protocol: &'static str,
    action: &'static str,
    reason: String,
    schema: Value,
    base_bytes: usize,
    candidate_bytes: usize,
    selected_bytes: usize,
    saved_bytes: usize,
    constraint_present: bool,
    satisfiable: Option<bool>,
    subset_of_base: Option<bool>,
    subset_of_constraint: Option<bool>,
    equivalent_to_base: Option<bool>,
    exact: bool,
    annotations_present: bool,
    mutation_authority: bool,
    model_authority_expansion: bool,
}

fn default_mode() -> String {
    "compile".to_string()
}

fn default_min_savings_bytes() -> usize {
    64
}

fn serialized_len(value: &Value) -> usize {
    serde_json::to_vec(value)
        .map(|bytes| bytes.len())
        .unwrap_or(usize::MAX)
}

fn contains_model_annotation(value: &Value) -> bool {
    match value {
        Value::Array(items) => items.iter().any(contains_model_annotation),
        Value::Object(map) => map.iter().any(|(key, value)| {
            matches!(
                key.as_str(),
                "description"
                    | "title"
                    | "examples"
                    | "default"
                    | "deprecated"
                    | "readOnly"
                    | "writeOnly"
                    | "$comment"
            ) || contains_model_annotation(value)
        }),
        _ => false,
    }
}

fn retained(
    base: Value,
    base_bytes: usize,
    reason: impl Into<String>,
    constraint_present: bool,
    annotations_present: bool,
) -> Response {
    Response {
        ok: true,
        protocol: PROTOCOL,
        action: "base_retained",
        reason: reason.into(),
        schema: base,
        base_bytes,
        candidate_bytes: base_bytes,
        selected_bytes: base_bytes,
        saved_bytes: 0,
        constraint_present,
        satisfiable: None,
        subset_of_base: None,
        subset_of_constraint: None,
        equivalent_to_base: None,
        exact: false,
        annotations_present,
        mutation_authority: false,
        model_authority_expansion: false,
    }
}

fn subset_proof(
    left: &jsonschema::canonical::CanonicalSchema,
    right: &jsonschema::canonical::CanonicalSchema,
) -> Option<bool> {
    left.is_subset_of(right).ok().flatten()
}

fn compile(request: Request) -> Response {
    let base = request.schema;
    let base_bytes = serialized_len(&base);
    let constraint_present = request.constraint.is_some();
    let annotations_present = contains_model_annotation(&base);

    if request.protocol != PROTOCOL {
        return retained(
            base,
            base_bytes,
            "protocol_mismatch",
            constraint_present,
            annotations_present,
        );
    }

    if request.mode != "compile" {
        return retained(
            base,
            base_bytes,
            "mode_unsupported",
            constraint_present,
            annotations_present,
        );
    }

    // JSON Schema annotations can carry model-facing guidance even though they
    // do not change validation semantics. The generic compiler is forbidden
    // from silently deleting or rewriting them. Existing deterministic phase
    // projection may remove annotations first when that is independently safe.
    if annotations_present {
        return retained(
            base,
            base_bytes,
            "model_annotations_present",
            constraint_present,
            true,
        );
    }

    // Compile first instead of calling jsonschema::validate, which may panic on
    // an invalid schema. Remote resolution features are disabled in Cargo.
    if jsonschema::validator_for(&base).is_err() {
        return retained(
            base,
            base_bytes,
            "base_schema_invalid",
            constraint_present,
            false,
        );
    }

    let canonical_base = match canonicalize(&base) {
        Ok(value) => value,
        Err(_) => {
            return retained(
                base,
                base_bytes,
                "base_canonicalization_unavailable",
                constraint_present,
                false,
            );
        }
    };

    let (target, satisfiable, subset_of_base, subset_of_constraint) =
        if let Some(constraint) = request.constraint {
            if jsonschema::validator_for(&constraint).is_err() {
                return retained(
                    base,
                    base_bytes,
                    "constraint_schema_invalid",
                    true,
                    false,
                );
            }

            let canonical_constraint = match canonicalize(&constraint) {
                Ok(value) => value,
                Err(_) => {
                    return retained(
                        base,
                        base_bytes,
                        "constraint_canonicalization_unavailable",
                        true,
                        false,
                    );
                }
            };

            let projected = match canonical_base.intersect(&canonical_constraint) {
                Ok(value) => value,
                Err(_) => {
                    return retained(
                        base,
                        base_bytes,
                        "intersection_unavailable",
                        true,
                        false,
                    );
                }
            };

            if !projected.is_satisfiable() {
                return retained(
                    base,
                    base_bytes,
                    "projection_unsatisfiable",
                    true,
                    false,
                );
            }

            let subset_base = subset_proof(&projected, &canonical_base);
            let subset_constraint = subset_proof(&projected, &canonical_constraint);

            if subset_base != Some(true) || subset_constraint != Some(true) {
                return retained(
                    base,
                    base_bytes,
                    "projection_subset_unproven",
                    true,
                    false,
                );
            }

            (
                projected,
                Some(true),
                subset_base,
                subset_constraint,
            )
        } else {
            (
                canonical_base.clone(),
                Some(canonical_base.is_satisfiable()),
                Some(true),
                None,
            )
        };

    let candidate = target.to_json_schema();

    if jsonschema::validator_for(&candidate).is_err() {
        return retained(
            base,
            base_bytes,
            "candidate_schema_invalid",
            constraint_present,
            false,
        );
    }

    let canonical_roundtrip = match canonicalize(&candidate) {
        Ok(value) => value,
        Err(_) => {
            return retained(
                base,
                base_bytes,
                "candidate_roundtrip_unavailable",
                constraint_present,
                false,
            );
        }
    };

    // Emission itself must preserve the exact target set before the candidate is
    // allowed to become model-facing.
    if subset_proof(&canonical_roundtrip, &target) != Some(true)
        || subset_proof(&target, &canonical_roundtrip) != Some(true)
    {
        return retained(
            base,
            base_bytes,
            "candidate_roundtrip_equivalence_unproven",
            constraint_present,
            false,
        );
    }

    let equivalent_to_base = if constraint_present {
        None
    } else {
        let equivalent =
            subset_proof(&canonical_roundtrip, &canonical_base) == Some(true)
                && subset_proof(&canonical_base, &canonical_roundtrip) == Some(true);

        if !equivalent {
            return retained(
                base,
                base_bytes,
                "base_equivalence_unproven",
                false,
                false,
            );
        }

        Some(true)
    };

    let candidate_bytes = serialized_len(&candidate);
    let required_savings = request.min_savings_bytes.min(base_bytes);

    if candidate_bytes.saturating_add(required_savings) > base_bytes {
        return Response {
            ok: true,
            protocol: PROTOCOL,
            action: "base_retained",
            reason: "projection_not_profitable".to_string(),
            schema: base,
            base_bytes,
            candidate_bytes,
            selected_bytes: base_bytes,
            saved_bytes: 0,
            constraint_present,
            satisfiable,
            subset_of_base,
            subset_of_constraint,
            equivalent_to_base,
            exact: true,
            annotations_present: false,
            mutation_authority: false,
            model_authority_expansion: false,
        };
    }

    Response {
        ok: true,
        protocol: PROTOCOL,
        action: "projected",
        reason: if constraint_present {
            "constraint_projection_proven".to_string()
        } else {
            "canonical_projection_proven".to_string()
        },
        schema: candidate,
        base_bytes,
        candidate_bytes,
        selected_bytes: candidate_bytes,
        saved_bytes: base_bytes.saturating_sub(candidate_bytes),
        constraint_present,
        satisfiable,
        subset_of_base,
        subset_of_constraint,
        equivalent_to_base,
        exact: true,
        annotations_present: false,
        mutation_authority: false,
        model_authority_expansion: false,
    }
}

fn run() -> Result<()> {
    let mut input = Vec::new();
    io::stdin()
        .take((MAX_INPUT_BYTES + 1) as u64)
        .read_to_end(&mut input)
        .context("read stdin")?;

    if input.len() > MAX_INPUT_BYTES {
        anyhow::bail!("input exceeds {MAX_INPUT_BYTES} bytes");
    }

    let request: Request =
        serde_json::from_slice(&input).context("parse model ABI compiler request")?;

    let response = compile(request);
    serde_json::to_writer(io::stdout().lock(), &response).context("write response")?;
    println!();
    Ok(())
}

fn main() -> Result<()> {
    run()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn request(
        schema: Value,
        constraint: Option<Value>,
        min_savings_bytes: usize,
    ) -> Request {
        Request {
            protocol: PROTOCOL.to_string(),
            mode: "compile".to_string(),
            schema,
            constraint,
            min_savings_bytes,
        }
    }

    #[test]
    fn canonical_projection_never_expands_authority() {
        let base = json!({
            "allOf": [
                {"type": "string"},
                {"maxLength": 8}
            ]
        });

        let result = compile(request(base, None, 0));

        assert!(result.ok);
        assert!(!result.model_authority_expansion);
        assert!(!result.mutation_authority);
        if result.action == "projected" {
            assert_eq!(result.equivalent_to_base, Some(true));
            assert!(result.selected_bytes <= result.base_bytes);
        }
    }

    #[test]
    fn discriminator_projection_is_subset_proven_or_falls_back() {
        let base = json!({
            "oneOf": [
                {
                    "type": "object",
                    "properties": {
                        "kind": {"const": "a"},
                        "a": {"type": "string"}
                    },
                    "required": ["kind", "a"],
                    "additionalProperties": false
                },
                {
                    "type": "object",
                    "properties": {
                        "kind": {"const": "b"},
                        "b": {"type": "integer"}
                    },
                    "required": ["kind", "b"],
                    "additionalProperties": false
                }
            ]
        });

        let constraint = json!({
            "type": "object",
            "properties": {
                "kind": {"const": "a"}
            },
            "required": ["kind"]
        });

        let result = compile(request(base, Some(constraint), 0));

        assert!(result.ok);
        assert!(!result.model_authority_expansion);
        if result.action == "projected" {
            assert_eq!(result.subset_of_base, Some(true));
            assert_eq!(result.subset_of_constraint, Some(true));
            assert_eq!(result.satisfiable, Some(true));
        }
    }

    #[test]
    fn annotations_force_safe_base_retention() {
        let base = json!({
            "type": "string",
            "description": "model-facing semantic hint"
        });

        let result = compile(request(base.clone(), None, 0));

        assert_eq!(result.action, "base_retained");
        assert_eq!(result.reason, "model_annotations_present");
        assert_eq!(result.schema, base);
        assert!(result.annotations_present);
        assert!(!result.model_authority_expansion);
    }

    #[test]
    fn profitability_gate_never_increases_model_schema() {
        let base = json!({"type": "string"});
        let result = compile(request(base.clone(), None, 4096));

        assert_eq!(result.action, "base_retained");
        assert_eq!(result.schema, base);
        assert_eq!(result.selected_bytes, result.base_bytes);
        assert_eq!(result.saved_bytes, 0);
    }
}
