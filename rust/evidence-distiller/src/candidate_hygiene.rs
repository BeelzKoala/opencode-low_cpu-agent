use anyhow::{Context, Result};
use serde::Serialize;
use std::{
    fs,
    path::{Component, Path},
    process::Command,
};

pub const PROTOCOL: &str = "candidate-hygiene-v1";

const MAX_GIT_DIAGNOSTIC_CHARS: usize = 1200;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum EolKind {
    None,
    Lf,
    Crlf,
    Mixed,
    BareCr,
}

impl EolKind {
    fn as_str(self) -> &'static str {
        match self {
            Self::None => "none",
            Self::Lf => "lf",
            Self::Crlf => "crlf",
            Self::Mixed => "mixed",
            Self::BareCr => "bare_cr",
        }
    }

    fn is_supported_baseline(self) -> bool {
        matches!(self, Self::None | Self::Lf | Self::Crlf)
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct FileHygiene {
    pub file: String,
    pub baseline_eol: EolKind,
    pub candidate_eol: EolKind,
    pub eol_preserved: bool,
    pub git_diff_check: bool,
    pub pass: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct CandidateHygieneReport {
    pub protocol: &'static str,
    pub ok: bool,
    pub files: Vec<FileHygiene>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

pub fn classify_eol(bytes: &[u8]) -> EolKind {
    let mut crlf = 0usize;
    let mut bare_lf = 0usize;
    let mut bare_cr = 0usize;
    let mut i = 0usize;

    while i < bytes.len() {
        match bytes[i] {
            b'\r' if i + 1 < bytes.len() && bytes[i + 1] == b'\n' => {
                crlf += 1;
                i += 2;
            }
            b'\r' => {
                bare_cr += 1;
                i += 1;
            }
            b'\n' => {
                bare_lf += 1;
                i += 1;
            }
            _ => i += 1,
        }
    }

    if bare_cr > 0 && crlf == 0 && bare_lf == 0 {
        return EolKind::BareCr;
    }
    if bare_cr > 0 {
        return EolKind::Mixed;
    }

    match (crlf > 0, bare_lf > 0) {
        (false, false) => EolKind::None,
        (false, true) => EolKind::Lf,
        (true, false) => EolKind::Crlf,
        (true, true) => EolKind::Mixed,
    }
}

fn safe_rel(raw: &str) -> bool {
    if raw.is_empty()
        || raw.len() > 4096
        || raw.chars().any(char::is_control)
        || Path::new(raw).is_absolute()
    {
        return false;
    }

    let mut first = None::<String>;
    let mut normal = 0usize;

    for component in Path::new(raw).components() {
        match component {
            Component::Normal(value) => {
                normal += 1;
                if first.is_none() {
                    first = Some(value.to_string_lossy().to_string());
                }
            }
            Component::CurDir => {}
            Component::ParentDir => return false,
            _ => return false,
        }
    }

    normal > 0 && !matches!(first.as_deref(), Some(".git") | Some(".opencode"))
}

fn bounded_git_diagnostic(output: &std::process::Output) -> String {
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);

    let combined = match (stdout.trim().is_empty(), stderr.trim().is_empty()) {
        (false, false) => format!("stdout={} stderr={}", stdout.trim(), stderr.trim()),
        (false, true) => format!("stdout={}", stdout.trim()),
        (true, false) => format!("stderr={}", stderr.trim()),
        (true, true) => "no_output".to_string(),
    };

    combined
        .replace('\r', "\\r")
        .replace('\n', "\\n")
        .replace('\0', "\\0")
        .chars()
        .take(MAX_GIT_DIAGNOSTIC_CHARS)
        .collect()
}

fn whitespace_policy_with_cr_at_eol(root: &Path) -> Result<String> {
    let output = Command::new("git")
        .current_dir(root)
        .args(["config", "--get", "core.whitespace"])
        .output()
        .context("cannot read core.whitespace")?;

    let raw = if output.status.success() {
        std::str::from_utf8(&output.stdout)
            .context("core.whitespace is not UTF-8")?
            .trim()
            .to_string()
    } else if output.status.code() == Some(1) {
        String::new()
    } else {
        anyhow::bail!("git config core.whitespace failed");
    };

    let mut parts = raw
        .split(',')
        .map(str::trim)
        .filter(|part| !part.is_empty())
        .filter(|part| *part != "cr-at-eol" && *part != "-cr-at-eol")
        .map(str::to_string)
        .collect::<Vec<_>>();

    parts.push("cr-at-eol".to_string());
    Ok(parts.join(","))
}

fn git_diff_check_one(root: &Path, file: &str, baseline_eol: EolKind) -> Result<(bool, String)> {
    let mut cmd = Command::new("git");
    cmd.current_dir(root);

    if baseline_eol == EolKind::Crlf {
        let policy = whitespace_policy_with_cr_at_eol(root)?;
        cmd.arg("-c").arg(format!("core.whitespace={policy}"));
    }

    let output = cmd
        .args(["diff", "--check", "--"])
        .arg(file)
        .output()
        .context("cannot run git diff --check")?;

    if output.status.success() {
        return Ok((true, String::new()));
    }

    Ok((
        false,
        format!(
            "file={} baseline_eol={} exit_code={} {}",
            file,
            baseline_eol.as_str(),
            output.status.code().unwrap_or(-1),
            bounded_git_diagnostic(&output),
        ),
    ))
}

fn eol_preserved(baseline: EolKind, candidate: EolKind) -> bool {
    match baseline {
        EolKind::Lf => candidate == EolKind::Lf,
        EolKind::Crlf => candidate == EolKind::Crlf,
        EolKind::None => !matches!(candidate, EolKind::Mixed | EolKind::BareCr),
        EolKind::Mixed | EolKind::BareCr => false,
    }
}

pub fn audit_candidate_hygiene(
    baseline_root: &Path,
    candidate_root: &Path,
    files: &[String],
) -> Result<CandidateHygieneReport> {
    let mut reports = Vec::with_capacity(files.len());

    for file in files {
        if !safe_rel(file) {
            return Ok(CandidateHygieneReport {
                protocol: PROTOCOL,
                ok: false,
                files: reports,
                reason: Some("candidate_hygiene_file_invalid".to_string()),
            });
        }

        let baseline = fs::read(baseline_root.join(file))
            .with_context(|| format!("cannot read baseline file {file}"))?;
        let candidate = fs::read(candidate_root.join(file))
            .with_context(|| format!("cannot read candidate file {file}"))?;

        let baseline_eol = classify_eol(&baseline);
        let candidate_eol = classify_eol(&candidate);

        if !baseline_eol.is_supported_baseline() {
            reports.push(FileHygiene {
                file: file.clone(),
                baseline_eol,
                candidate_eol,
                eol_preserved: false,
                git_diff_check: false,
                pass: false,
                detail: Some("baseline_eol_ambiguous".to_string()),
            });

            return Ok(CandidateHygieneReport {
                protocol: PROTOCOL,
                ok: false,
                files: reports,
                reason: Some("candidate_hygiene_baseline_eol_ambiguous".to_string()),
            });
        }

        let eol_ok = eol_preserved(baseline_eol, candidate_eol);

        if !eol_ok {
            reports.push(FileHygiene {
                file: file.clone(),
                baseline_eol,
                candidate_eol,
                eol_preserved: false,
                git_diff_check: false,
                pass: false,
                detail: Some(format!(
                    "eol_changed baseline={} candidate={}",
                    baseline_eol.as_str(),
                    candidate_eol.as_str(),
                )),
            });

            return Ok(CandidateHygieneReport {
                protocol: PROTOCOL,
                ok: false,
                files: reports,
                reason: Some("candidate_hygiene_eol_changed".to_string()),
            });
        }

        let (diff_ok, diagnostic) = git_diff_check_one(candidate_root, file, baseline_eol)?;

        let detail = (!diagnostic.is_empty()).then_some(diagnostic);

        reports.push(FileHygiene {
            file: file.clone(),
            baseline_eol,
            candidate_eol,
            eol_preserved: true,
            git_diff_check: diff_ok,
            pass: diff_ok,
            detail,
        });

        if !diff_ok {
            return Ok(CandidateHygieneReport {
                protocol: PROTOCOL,
                ok: false,
                files: reports,
                reason: Some("candidate_hygiene_git_diff_check_failed".to_string()),
            });
        }
    }

    Ok(CandidateHygieneReport {
        protocol: PROTOCOL,
        ok: true,
        files: reports,
        reason: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn eol_classifier_is_byte_exact() {
        assert_eq!(classify_eol(b"one\n"), EolKind::Lf);
        assert_eq!(classify_eol(b"one\r\n"), EolKind::Crlf);
        assert_eq!(classify_eol(b"one\r\ntwo\n"), EolKind::Mixed);
        assert_eq!(classify_eol(b"one\rtwo"), EolKind::BareCr);
        assert_eq!(classify_eol(b"one"), EolKind::None);
    }

    #[test]
    fn eol_preservation_is_fail_closed() {
        assert!(eol_preserved(EolKind::Lf, EolKind::Lf));
        assert!(eol_preserved(EolKind::Crlf, EolKind::Crlf));
        assert!(!eol_preserved(EolKind::Lf, EolKind::Crlf));
        assert!(!eol_preserved(EolKind::Crlf, EolKind::Lf));
        assert!(!eol_preserved(EolKind::Mixed, EolKind::Mixed));
    }

    fn fixture(
        name: &str,
        baseline: &[u8],
        candidate: &[u8],
    ) -> (std::path::PathBuf, std::path::PathBuf) {
        let nonce = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let parent = std::env::temp_dir().join(format!(
            "candidate-hygiene-{name}-{}-{nonce}",
            std::process::id()
        ));
        let baseline_root = parent.join("baseline");
        let candidate_root = parent.join("candidate");

        std::fs::create_dir_all(&baseline_root).unwrap();
        std::fs::create_dir_all(&candidate_root).unwrap();
        std::fs::write(baseline_root.join("sample.ts"), baseline).unwrap();

        let git = |args: &[&str]| {
            std::process::Command::new("git")
                .current_dir(&candidate_root)
                .args(args)
                .status()
                .unwrap()
                .success()
        };

        assert!(git(&["init", "-q"]));
        assert!(git(&["config", "user.email", "hygiene@example.invalid"]));
        assert!(git(&["config", "user.name", "Candidate Hygiene"]));
        assert!(git(&["config", "core.autocrlf", "false"]));

        std::fs::write(candidate_root.join("sample.ts"), baseline).unwrap();
        assert!(git(&["add", "--", "sample.ts"]));
        assert!(git(&["commit", "-qm", "baseline"]));

        std::fs::write(candidate_root.join("sample.ts"), candidate).unwrap();

        (baseline_root, candidate_root)
    }

    fn cleanup_fixture(baseline_root: &Path, candidate_root: &Path) {
        let parent = baseline_root.parent().unwrap();
        assert_eq!(candidate_root.parent(), Some(parent));
        let _ = std::fs::remove_dir_all(parent);
    }

    #[test]
    fn preserved_crlf_is_clean() {
        let (baseline, candidate) = fixture(
            "crlf-ok",
            b"const value = oldName();\r\n",
            b"const value = newName();\r\n",
        );

        let report =
            audit_candidate_hygiene(&baseline, &candidate, &["sample.ts".to_string()]).unwrap();

        assert!(report.ok, "{report:?}");
        assert_eq!(report.files[0].baseline_eol, EolKind::Crlf);
        assert_eq!(report.files[0].candidate_eol, EolKind::Crlf);
        assert!(report.files[0].git_diff_check);

        cleanup_fixture(&baseline, &candidate);
    }

    #[test]
    fn crlf_real_trailing_space_is_rejected() {
        let (baseline, candidate) = fixture(
            "crlf-space",
            b"const value = oldName();\r\n",
            b"const value = newName(); \r\n",
        );

        let report =
            audit_candidate_hygiene(&baseline, &candidate, &["sample.ts".to_string()]).unwrap();

        assert!(!report.ok);
        assert_eq!(
            report.reason.as_deref(),
            Some("candidate_hygiene_git_diff_check_failed")
        );
        assert!(
            report.files[0]
                .detail
                .as_deref()
                .unwrap_or_default()
                .contains("trailing whitespace")
        );

        cleanup_fixture(&baseline, &candidate);
    }

    #[test]
    fn lf_to_crlf_conversion_is_rejected_before_git_policy() {
        let (baseline, candidate) = fixture(
            "lf-to-crlf",
            b"const value = oldName();\n",
            b"const value = newName();\r\n",
        );

        let report =
            audit_candidate_hygiene(&baseline, &candidate, &["sample.ts".to_string()]).unwrap();

        assert!(!report.ok);
        assert_eq!(
            report.reason.as_deref(),
            Some("candidate_hygiene_eol_changed")
        );
        assert_eq!(report.files[0].baseline_eol, EolKind::Lf);
        assert_eq!(report.files[0].candidate_eol, EolKind::Crlf);

        cleanup_fixture(&baseline, &candidate);
    }

    #[test]
    fn mixed_baseline_fails_closed() {
        let (baseline, candidate) = fixture("mixed", b"one\r\ntwo\n", b"one\r\ntwo\n");

        let report =
            audit_candidate_hygiene(&baseline, &candidate, &["sample.ts".to_string()]).unwrap();

        assert!(!report.ok);
        assert_eq!(
            report.reason.as_deref(),
            Some("candidate_hygiene_baseline_eol_ambiguous")
        );

        cleanup_fixture(&baseline, &candidate);
    }
}
