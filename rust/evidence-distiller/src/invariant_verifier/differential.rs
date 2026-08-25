use ast_grep_language::{Language, LanguageExt, SupportLang};
use serde::Serialize;
use std::{ops::Range, path::Path};

const OBSERVATION_PROTOCOL: &str = "differential-observation-v1";
const OBSERVATION_AUTHORITY: &str = "shadow_observation";
const CONTROL_FLOW_KIND: &str = "python_control_flow_points_v1";

#[derive(Debug, Clone, Serialize)]
pub(super) struct DifferentialObservation {
    protocol: &'static str,
    kind: &'static str,
    authority: &'static str,
    status: &'static str,
    file: String,
    symbol: String,

    #[serde(skip_serializing_if = "Option::is_none")]
    before: Option<usize>,

    #[serde(skip_serializing_if = "Option::is_none")]
    after: Option<usize>,

    #[serde(skip_serializing_if = "Option::is_none")]
    delta: Option<i64>,

    #[serde(skip_serializing_if = "Option::is_none")]
    increased: Option<bool>,

    #[serde(skip_serializing_if = "Option::is_none")]
    reason: Option<&'static str>,
}

fn is_python(path: &Path) -> bool {
    matches!(
        path.extension().and_then(|value| value.to_str()),
        Some("py" | "pyi")
    )
}

fn is_definition_kind(kind: &str) -> bool {
    matches!(
        kind,
        "function_definition" | "function_declaration" | "method_definition" | "method_declaration"
    )
}

fn unique_definition_range(path: &Path, source: &str, symbol: &str) -> Option<Range<usize>> {
    let lang = SupportLang::from_path(path)?;
    let ast = lang.ast_grep(source);
    let root = ast.root();

    if root
        .clone()
        .dfs()
        .any(|node| node.is_error() || node.is_missing())
    {
        return None;
    }

    let mut matches = root
        .dfs()
        .filter(|node| {
            node.is_named()
                && is_definition_kind(node.kind().as_ref())
                && node
                    .field("name")
                    .map(|name| name.text().as_ref() == symbol)
                    .unwrap_or(false)
        })
        .map(|node| node.range());

    let first = matches.next()?;

    if matches.next().is_some() {
        return None;
    }

    Some(first)
}

fn decision_weight(kind: &str) -> usize {
    match kind {
        "if_statement"
        | "elif_clause"
        | "for_statement"
        | "while_statement"
        | "except_clause"
        | "conditional_expression"
        | "boolean_operator"
        | "case_clause" => 1,

        _ => 0,
    }
}

fn owner_control_flow_points(
    path: &Path,
    source: &str,
    owner: &Range<usize>,
) -> Result<usize, &'static str> {
    let lang = SupportLang::from_path(path).ok_or("language_unsupported")?;

    let ast = lang.ast_grep(source);
    let root = ast.root();

    if root
        .clone()
        .dfs()
        .any(|node| node.is_error() || node.is_missing())
    {
        return Err("source_syntax_invalid");
    }

    /*
     * Nested definitions would make a flat DFS attribute child control
     * flow to the parent owner. Until we have scope-aware pruning here,
     * abstain instead of publishing misleading evidence.
     */
    for node in root.clone().dfs().filter(|node| node.is_named()) {
        let range = node.range();

        if range.start < owner.start || range.end > owner.end {
            continue;
        }

        let same_owner = range.start == owner.start && range.end == owner.end;

        if !same_owner && is_definition_kind(node.kind().as_ref()) {
            return Err("nested_definition");
        }
    }

    let mut points = 0usize;

    for node in root.dfs().filter(|node| node.is_named()) {
        let range = node.range();

        if range.start < owner.start || range.end > owner.end {
            continue;
        }

        points = points.saturating_add(decision_weight(node.kind().as_ref()));
    }

    Ok(points)
}

fn skipped(path: &Path, symbol: &str, reason: &'static str) -> DifferentialObservation {
    DifferentialObservation {
        protocol: OBSERVATION_PROTOCOL,
        kind: CONTROL_FLOW_KIND,
        authority: OBSERVATION_AUTHORITY,
        status: "skipped",
        file: path.to_string_lossy().to_string(),
        symbol: symbol.to_string(),
        before: None,
        after: None,
        delta: None,
        increased: None,
        reason: Some(reason),
    }
}

pub(super) fn observe_python_control_flow(
    path: &Path,
    before_source: &str,
    after_source: &str,
    symbol: &str,
) -> Option<DifferentialObservation> {
    if !is_python(path) {
        return None;
    }

    let Some(before_owner) = unique_definition_range(path, before_source, symbol) else {
        return Some(skipped(path, symbol, "baseline_owner_unavailable"));
    };

    let Some(after_owner) = unique_definition_range(path, after_source, symbol) else {
        return Some(skipped(path, symbol, "candidate_owner_unavailable"));
    };

    let before = match owner_control_flow_points(path, before_source, &before_owner) {
        Ok(value) => value,
        Err(reason) => {
            return Some(skipped(path, symbol, reason));
        }
    };

    let after = match owner_control_flow_points(path, after_source, &after_owner) {
        Ok(value) => value,
        Err(reason) => {
            return Some(skipped(path, symbol, reason));
        }
    };

    let delta = after as i64 - before as i64;

    Some(DifferentialObservation {
        protocol: OBSERVATION_PROTOCOL,
        kind: CONTROL_FLOW_KIND,
        authority: OBSERVATION_AUTHORITY,
        status: "observed",
        file: path.to_string_lossy().to_string(),
        symbol: symbol.to_string(),
        before: Some(before),
        after: Some(after),
        delta: Some(delta),
        increased: Some(delta > 0),
        reason: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn observes_python_control_flow_delta() {
        let before = r#"
def f(value):
    return value
"#;

        let after = r#"
def f(value):
    if value:
        return value
    return 0
"#;

        let row = observe_python_control_flow(Path::new("sample.py"), before, after, "f").unwrap();

        assert_eq!(row.status, "observed");
        assert_eq!(row.authority, "shadow_observation");
        assert_eq!(row.before, Some(0));
        assert_eq!(row.after, Some(1));
        assert_eq!(row.delta, Some(1));
        assert_eq!(row.increased, Some(true));
    }

    #[test]
    fn nested_definition_abstains() {
        let source = r#"
def f(value):
    def nested():
        if value:
            return 1
        return 0
    return nested()
"#;

        let row = observe_python_control_flow(Path::new("sample.py"), source, source, "f").unwrap();

        assert_eq!(row.status, "skipped");
        assert_eq!(row.reason, Some("nested_definition"));
        assert_eq!(row.before, None);
        assert_eq!(row.after, None);
    }

    #[test]
    fn non_python_is_not_observed() {
        let row = observe_python_control_flow(
            Path::new("sample.ts"),
            "function f() {}",
            "function f() {}",
            "f",
        );

        assert!(row.is_none());
    }

    #[test]
    fn ambiguous_owner_abstains() {
        let source = r#"
def f():
    return 1

def f():
    return 2
"#;

        let row = observe_python_control_flow(Path::new("sample.py"), source, source, "f").unwrap();

        assert_eq!(row.status, "skipped");
        assert_eq!(row.reason, Some("baseline_owner_unavailable"),);
    }
}
