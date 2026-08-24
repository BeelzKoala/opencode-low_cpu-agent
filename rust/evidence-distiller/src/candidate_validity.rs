use serde::Serialize;
use std::{
    io::{ErrorKind, Write},
    path::Path,
    process::{Command, Stdio},
    thread,
    time::{Duration, Instant},
};

pub const PROTOCOL: &str = "candidate-validity-v1";
pub const PYTHON_VALIDATOR_KIND: &str = "python3-compile-v1";
pub const VALIDATOR_TIMEOUT_MS: u64 = 1500;
pub const LANGUAGE_INVALID_EXIT_CODE: i32 = 10;

const POLL_MS: u64 = 5;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ValidatorSpec {
    pub language: &'static str,
    pub kind: &'static str,
    pub program: &'static str,
    pub args: &'static [&'static str],
}

const PYTHON_ARGS: &[&str] = &[
    "-I",
    "-S",
    "-c",
    "import sys\n\
     src=sys.stdin.buffer.read().decode('utf-8')\n\
     try:\n\
     \tcompile(src, '<candidate>', 'exec', dont_inherit=True)\n\
     except (SyntaxError, ValueError, OverflowError):\n\
     \traise SystemExit(10)",
];

const PYTHON: ValidatorSpec = ValidatorSpec {
    language: "python",
    kind: PYTHON_VALIDATOR_KIND,
    program: "python3",
    args: PYTHON_ARGS,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ValidationCoverage {
    NativeEnforced,
    StructuralOnly,
}

impl ValidationCoverage {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::NativeEnforced => "native_enforced",
            Self::StructuralOnly => "structural_only",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CandidateValidation {
    NotRegistered,
    Valid(ValidatorSpec),
    Invalid(ValidatorSpec),
    Unavailable(ValidatorSpec),
    Timeout(ValidatorSpec),
    Failed(ValidatorSpec),
}

pub fn validator_for_path(path: &Path) -> Option<ValidatorSpec> {
    let ext = path.extension()?.to_str()?.to_ascii_lowercase();
    match ext.as_str() {
        "py" => Some(PYTHON),
        _ => None,
    }
}

fn classify_exit_code(spec: ValidatorSpec, code: Option<i32>) -> CandidateValidation {
    match code {
        Some(0) => CandidateValidation::Valid(spec),
        Some(LANGUAGE_INVALID_EXIT_CODE) => CandidateValidation::Invalid(spec),
        Some(_) | None => CandidateValidation::Failed(spec),
    }
}

impl CandidateValidation {
    pub fn coverage(self) -> ValidationCoverage {
        match self {
            Self::NotRegistered => ValidationCoverage::StructuralOnly,
            Self::Valid(_)
            | Self::Invalid(_)
            | Self::Unavailable(_)
            | Self::Timeout(_)
            | Self::Failed(_) => ValidationCoverage::NativeEnforced,
        }
    }

    pub fn policy_pass(self) -> bool {
        matches!(self, Self::NotRegistered | Self::Valid(_))
    }

    pub fn failure_reason(self) -> Option<&'static str> {
        match self {
            Self::Invalid(_) => Some("candidate_language_invalid"),
            Self::Unavailable(_) => Some("candidate_validator_unavailable"),
            Self::Timeout(_) => Some("candidate_validator_timeout"),
            Self::Failed(_) => Some("candidate_validator_failed"),
            Self::NotRegistered | Self::Valid(_) => None,
        }
    }

    pub fn detail(self) -> String {
        let coverage = self.coverage().as_str();
        match self {
            Self::NotRegistered => format!(
                "protocol={PROTOCOL} language=unregistered validator=none status=not_registered coverage={coverage} policy=structural_only"
            ),
            Self::Valid(spec) => format!(
                "protocol={PROTOCOL} language={} validator={} status=valid coverage={coverage} policy=enforced",
                spec.language, spec.kind
            ),
            Self::Invalid(spec) => format!(
                "protocol={PROTOCOL} language={} validator={} status=invalid coverage={coverage} policy=enforced",
                spec.language, spec.kind
            ),
            Self::Unavailable(spec) => format!(
                "protocol={PROTOCOL} language={} validator={} status=unavailable coverage={coverage} policy=enforced",
                spec.language, spec.kind
            ),
            Self::Timeout(spec) => format!(
                "protocol={PROTOCOL} language={} validator={} status=timeout coverage={coverage} policy=enforced",
                spec.language, spec.kind
            ),
            Self::Failed(spec) => format!(
                "protocol={PROTOCOL} language={} validator={} status=failed coverage={coverage} policy=enforced",
                spec.language, spec.kind
            ),
        }
    }
}

pub fn validate_candidate(path: &Path, source: &str) -> CandidateValidation {
    let Some(spec) = validator_for_path(path) else {
        return CandidateValidation::NotRegistered;
    };

    let mut child = match Command::new(spec.program)
        .args(spec.args)
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
    {
        Ok(child) => child,
        Err(err) if err.kind() == ErrorKind::NotFound => {
            return CandidateValidation::Unavailable(spec);
        }
        Err(_) => return CandidateValidation::Failed(spec),
    };

    let Some(mut stdin) = child.stdin.take() else {
        let _ = child.kill();
        let _ = child.wait();
        return CandidateValidation::Failed(spec);
    };

    let payload = source.as_bytes().to_vec();
    let writer = thread::spawn(move || stdin.write_all(&payload));
    let deadline = Instant::now() + Duration::from_millis(VALIDATOR_TIMEOUT_MS);

    let outcome = loop {
        match child.try_wait() {
            Ok(Some(status)) => break classify_exit_code(spec, status.code()),
            Ok(None) => {}
            Err(_) => {
                let _ = child.kill();
                let _ = child.wait();
                break CandidateValidation::Failed(spec);
            }
        }

        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            break CandidateValidation::Timeout(spec);
        }

        thread::sleep(Duration::from_millis(POLL_MS));
    };

    let write_ok = writer.join().map(|result| result.is_ok()).unwrap_or(false);
    if !write_ok && matches!(outcome, CandidateValidation::Valid(_)) {
        return CandidateValidation::Failed(spec);
    }

    outcome
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn registry_is_explicit_and_conservative() {
        assert_eq!(
            validator_for_path(Path::new("x.py")).map(|v| v.kind),
            Some(PYTHON_VALIDATOR_KIND)
        );
        assert!(validator_for_path(Path::new("x.js")).is_none());
        assert!(validator_for_path(Path::new("Dockerfile")).is_none());
    }

    #[test]
    fn unregistered_language_is_explicit_not_a_false_native_proof() {
        let result = validate_candidate(Path::new("x.js"), "const x = ;");
        assert_eq!(result, CandidateValidation::NotRegistered);
        assert_eq!(result.coverage(), ValidationCoverage::StructuralOnly);
        assert!(result.policy_pass());
        assert!(result.detail().contains("status=not_registered"));
        assert!(result.detail().contains("coverage=structural_only"));
    }

    #[test]
    fn typed_exit_contract_separates_language_invalid_from_backend_failure() {
        assert!(matches!(
            classify_exit_code(PYTHON, Some(0)),
            CandidateValidation::Valid(_)
        ));
        assert!(matches!(
            classify_exit_code(PYTHON, Some(LANGUAGE_INVALID_EXIT_CODE)),
            CandidateValidation::Invalid(_)
        ));
        let failed = classify_exit_code(PYTHON, Some(1));
        assert!(matches!(failed, CandidateValidation::Failed(_)));
        assert_eq!(failed.failure_reason(), Some("candidate_validator_failed"));
        assert_ne!(failed.failure_reason(), Some("candidate_language_invalid"));
        assert!(matches!(
            classify_exit_code(PYTHON, None),
            CandidateValidation::Failed(_)
        ));
    }

    #[test]
    fn python_validation_compiles_but_does_not_execute_candidate() {
        let result = validate_candidate(
            Path::new("x.py"),
            "raise RuntimeError('candidate must never execute')\n",
        );
        if matches!(result, CandidateValidation::Unavailable(_)) {
            return;
        }
        assert!(
            matches!(result, CandidateValidation::Valid(_)),
            "{result:?}"
        );
        assert_eq!(result.coverage(), ValidationCoverage::NativeEnforced);
    }

    #[test]
    fn python_native_validator_rejects_bad_indentation_as_language_invalid() {
        let result = validate_candidate(
            Path::new("x.py"),
            "def normalize(value):\n    value = value.strip()\n        value = value.upper()\n    return value\n",
        );
        if matches!(result, CandidateValidation::Unavailable(_)) {
            return;
        }
        assert!(
            matches!(result, CandidateValidation::Invalid(_)),
            "{result:?}"
        );
        assert_eq!(result.failure_reason(), Some("candidate_language_invalid"));
        assert!(result.detail().contains("coverage=native_enforced"));
    }
}
