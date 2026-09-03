use std::collections::{BTreeMap, BTreeSet};
use std::io::{self, Read};

use anyhow::{Context, Result};
use ruff_python_ast::visitor::{Visitor, walk_expr, walk_parameter, walk_stmt};
use ruff_python_ast::{Expr, ExprContext, Parameter, Stmt, StmtFunctionDef};
use ruff_python_parser::parse_module;
use ruff_text_size::{Ranged, TextRange};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

const PROTOCOL: &str = "ruff-python-bridge-v1";
const CANONICALIZER_PROTOCOL: &str = "semantic-canonicalizer-v1";
const STRUCTURAL_WITNESS_PROTOCOL: &str = "ruff-python-structural-witness-v1";

#[derive(Debug, Deserialize)]
struct Request {
    command: String,
    #[serde(default)]
    source: Option<String>,
    #[serde(default)]
    unit: Option<UnitInput>,
    #[serde(default)]
    sources: Vec<SourceInput>,
}

#[derive(Debug, Deserialize, Clone)]
struct SourceInput {
    file: String,
    source: String,
}

#[derive(Debug, Deserialize, Clone)]
struct UnitInput {
    kind: String,
    name: String,
    #[serde(default)]
    parameters: String,
    #[serde(default)]
    returns: Option<String>,
    #[serde(default)]
    decorators: Vec<String>,
    body: String,
}

#[derive(Debug, Serialize, Clone)]
struct ByteRange {
    start: usize,
    end: usize,
}

#[derive(Debug, Serialize, Clone)]
struct NameRange {
    name: String,
    start: usize,
    end: usize,
}

#[derive(Debug, Serialize, Clone)]
struct ImportIntent {
    kind: String,
    module: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    name: Option<String>,
    local: String,
    canonical: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    alias: Option<String>,
    source: String,
}

#[derive(Default)]
struct Facts {
    loads: BTreeSet<String>,
    stores: BTreeSet<String>,
    parameters: BTreeSet<String>,
    load_ranges: Vec<NameRange>,
    imports: Vec<ImportIntent>,
    import_ranges: Vec<ByteRange>,
    has_global: bool,
    has_nonlocal: bool,
}

fn range(value: TextRange) -> ByteRange {
    ByteRange {
        start: value.start().to_usize(),
        end: value.end().to_usize(),
    }
}

fn source_slice(source: &str, value: TextRange) -> &str {
    &source[value.start().to_usize()..value.end().to_usize()]
}

fn compact_ws(source: &str) -> String {
    let mut out = String::with_capacity(source.len());
    let mut quote: Option<char> = None;
    let mut escaped = false;
    let mut pending_ws = false;

    for ch in source.chars() {
        if let Some(active) = quote {
            out.push(ch);
            if escaped {
                escaped = false;
            } else if ch == '\\' {
                escaped = true;
            } else if ch == active {
                quote = None;
            }
            continue;
        }

        if ch == '\'' || ch == '"' {
            if pending_ws && !out.is_empty() {
                out.push(' ');
            }
            pending_ws = false;
            quote = Some(ch);
            out.push(ch);
            continue;
        }

        if ch.is_whitespace() {
            pending_ws = true;
            continue;
        }

        if pending_ws && !out.is_empty() {
            out.push(' ');
        }
        pending_ws = false;
        out.push(ch);
    }

    out.trim().to_string()
}

fn strip_outer_parens(source: &str) -> &str {
    let trimmed = source.trim();
    if trimmed.starts_with('(') && trimmed.ends_with(')') && trimmed.len() >= 2 {
        &trimmed[1..trimmed.len() - 1]
    } else {
        trimmed
    }
}

fn import_intents(stmt: &Stmt) -> Result<Vec<ImportIntent>, String> {
    match stmt {
        Stmt::Import(import) => {
            let mut out = Vec::new();
            for alias in &import.names {
                let module = alias.name.as_str().to_string();
                let asname = alias
                    .asname
                    .as_ref()
                    .map(|value| value.as_str().to_string());
                let first = module.split('.').next().unwrap_or(&module).to_string();

                if asname.is_some() && module.contains('.') {
                    return Err("semantic_import_dotted_alias_unsupported".to_string());
                }

                let local = asname.clone().unwrap_or_else(|| first.clone());
                let canonical = first;
                out.push(ImportIntent {
                    kind: "module".to_string(),
                    module,
                    name: None,
                    local,
                    canonical,
                    alias: asname,
                    source: "model_static_import_hint".to_string(),
                });
            }
            Ok(out)
        }
        Stmt::ImportFrom(import) => {
            if import.level != 0 {
                return Err("semantic_relative_import_unsupported".to_string());
            }
            let Some(module) = import.module.as_ref() else {
                return Err("semantic_import_module_missing".to_string());
            };
            let module = module.as_str().to_string();
            let mut out = Vec::new();
            for alias in &import.names {
                let name = alias.name.as_str().to_string();
                if name == "*" {
                    return Err("semantic_star_import_unsupported".to_string());
                }
                let asname = alias
                    .asname
                    .as_ref()
                    .map(|value| value.as_str().to_string());
                let local = asname.clone().unwrap_or_else(|| name.clone());
                out.push(ImportIntent {
                    kind: "from".to_string(),
                    module: module.clone(),
                    name: Some(name.clone()),
                    local,
                    canonical: name,
                    alias: asname,
                    source: "model_static_import_hint".to_string(),
                });
            }
            Ok(out)
        }
        _ => Ok(Vec::new()),
    }
}

impl<'a> Visitor<'a> for Facts {
    fn visit_expr(&mut self, expr: &'a Expr) {
        if let Expr::Name(name) = expr {
            let id = name.id.as_str().to_string();
            match name.ctx {
                ExprContext::Load => {
                    self.loads.insert(id.clone());
                    self.load_ranges.push(NameRange {
                        name: id,
                        start: name.range.start().to_usize(),
                        end: name.range.end().to_usize(),
                    });
                }
                ExprContext::Store | ExprContext::Del => {
                    self.stores.insert(id);
                }
                _ => {}
            }
        }
        walk_expr(self, expr);
    }

    fn visit_parameter(&mut self, parameter: &'a Parameter) {
        self.parameters.insert(parameter.name.as_str().to_string());
        walk_parameter(self, parameter);
    }

    fn visit_stmt(&mut self, stmt: &'a Stmt) {
        match stmt {
            Stmt::FunctionDef(function) => {
                self.stores.insert(function.name.as_str().to_string());
            }
            Stmt::ClassDef(class) => {
                self.stores.insert(class.name.as_str().to_string());
            }
            Stmt::Import(_) | Stmt::ImportFrom(_) => {
                if let Ok(rows) = import_intents(stmt) {
                    self.imports.extend(rows);
                }
                self.import_ranges.push(range(stmt.range()));
            }
            Stmt::Global(_) => self.has_global = true,
            Stmt::Nonlocal(_) => self.has_nonlocal = true,
            _ => {}
        }
        walk_stmt(self, stmt);
    }
}

fn top_level_names(body: &[Stmt]) -> Vec<String> {
    let mut names = BTreeSet::new();
    for stmt in body {
        match stmt {
            Stmt::FunctionDef(function) => {
                names.insert(function.name.as_str().to_string());
            }
            Stmt::ClassDef(class) => {
                names.insert(class.name.as_str().to_string());
            }
            Stmt::Assign(assign) => {
                for target in &assign.targets {
                    if let Expr::Name(name) = target {
                        names.insert(name.id.as_str().to_string());
                    }
                }
            }
            Stmt::AnnAssign(assign) => {
                if let Expr::Name(name) = assign.target.as_ref() {
                    names.insert(name.id.as_str().to_string());
                }
            }
            Stmt::Import(_) | Stmt::ImportFrom(_) => {
                if let Ok(rows) = import_intents(stmt) {
                    for row in rows {
                        names.insert(row.local);
                    }
                }
            }
            _ => {}
        }
    }
    names.into_iter().collect()
}

fn decorator_sources(source: &str, body: &[Stmt]) -> Vec<String> {
    let mut out = BTreeSet::new();
    for stmt in body {
        match stmt {
            Stmt::FunctionDef(function) => {
                for decorator in &function.decorator_list {
                    out.insert(compact_ws(source_slice(source, decorator.range())));
                }
            }
            Stmt::ClassDef(class) => {
                for decorator in &class.decorator_list {
                    out.insert(compact_ws(source_slice(source, decorator.range())));
                }
            }
            _ => {}
        }
    }
    out.into_iter().collect()
}

fn analyze(source: &str) -> Value {
    let parsed = match parse_module(source) {
        Ok(value) => value,
        Err(error) => {
            return json!({
                "ok": false,
                "protocol": PROTOCOL,
                "reason": "ruff_python_syntax_invalid",
                "detail": error.to_string(),
            });
        }
    };
    let module = parsed.syntax();
    let mut facts = Facts::default();
    facts.visit_body(&module.body);

    let mut module_imports = BTreeSet::new();
    let mut from_imports = BTreeSet::new();
    let mut top_imports = Vec::new();

    for stmt in &module.body {
        if matches!(stmt, Stmt::Import(_) | Stmt::ImportFrom(_)) {
            match import_intents(stmt) {
                Ok(rows) => {
                    for row in rows {
                        if row.kind == "module" && row.alias.is_none() {
                            module_imports.insert(row.module.clone());
                        }
                        if row.kind == "from"
                            && row.alias.is_none()
                            && let Some(name) = row.name.as_ref()
                        {
                            from_imports.insert((row.module.clone(), name.clone()));
                        }
                        top_imports.push(row);
                    }
                }
                Err(reason) => {
                    return json!({
                        "ok": false,
                        "protocol": PROTOCOL,
                        "reason": reason,
                    });
                }
            }
        }
    }

    json!({
        "ok": true,
        "protocol": PROTOCOL,
        "top_names": top_level_names(&module.body),
        "decorators": decorator_sources(source, &module.body),
        "loads": facts.loads,
        "stores": facts.stores,
        "parameters": facts.parameters,
        "load_ranges": facts.load_ranges,
        "imports": facts.imports,
        "top_imports": top_imports,
        "module_imports": module_imports,
        "from_imports": from_imports
            .into_iter()
            .map(|(module, name)| json!({"module": module, "name": name}))
            .collect::<Vec<_>>(),
        "has_global": facts.has_global,
        "has_nonlocal": facts.has_nonlocal,
    })
}

fn dedent(source: &str) -> String {
    let lines: Vec<&str> = source.lines().collect();
    let indent = lines
        .iter()
        .filter(|line| !line.trim().is_empty())
        .map(|line| {
            line.chars()
                .take_while(|ch| *ch == ' ' || *ch == '\t')
                .count()
        })
        .min()
        .unwrap_or(0);

    lines
        .iter()
        .map(|line| {
            if line.trim().is_empty() {
                ""
            } else {
                let mut byte = 0usize;
                for (consumed, (index, ch)) in line.char_indices().enumerate() {
                    if consumed >= indent || (ch != ' ' && ch != '\t') {
                        byte = index;
                        break;
                    }
                    byte = index + ch.len_utf8();
                }
                &line[byte..]
            }
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn function_body_source(source: &str, function: &StmtFunctionDef) -> String {
    let Some(first) = function.body.first() else {
        return String::new();
    };
    let Some(last) = function.body.last() else {
        return String::new();
    };

    let start = line_expanded_range(source, first).start;
    let end = line_expanded_range(source, last).end;

    dedent(&source[start..end])
}

fn function_parameter_source(source: &str, function: &StmtFunctionDef) -> String {
    compact_ws(strip_outer_parens(source_slice(
        source,
        function.parameters.range(),
    )))
}

fn function_return_source(source: &str, function: &StmtFunctionDef) -> String {
    function
        .returns
        .as_ref()
        .map(|value| compact_ws(source_slice(source, value.range())))
        .unwrap_or_default()
}

fn function_decorators(source: &str, function: &StmtFunctionDef) -> Vec<String> {
    function
        .decorator_list
        .iter()
        .map(|value| {
            compact_ws(source_slice(source, value.range()))
                .trim_start_matches('@')
                .to_string()
        })
        .collect()
}

fn line_expanded_range(source: &str, stmt: &Stmt) -> ByteRange {
    let start = stmt.start().to_usize();
    let end = stmt.end().to_usize();

    let line_start = source[..start]
        .rfind('\n')
        .map(|value| value + 1)
        .unwrap_or(0);
    let line_end = source[end..]
        .find('\n')
        .map(|value| end + value + 1)
        .unwrap_or(source.len());

    ByteRange {
        start: line_start,
        end: line_end,
    }
}

fn is_docstring(stmt: &Stmt) -> bool {
    matches!(
        stmt,
        Stmt::Expr(expr) if matches!(expr.value.as_ref(), Expr::StringLiteral(_))
    )
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RepresentationRelation {
    Exact,
    WrapperOmitted,
    Conflict,
}

fn optional_redundant_scalar_relation(shell: &str, wrapper: &str) -> RepresentationRelation {
    if shell == wrapper {
        RepresentationRelation::Exact
    } else if !shell.is_empty() && wrapper.is_empty() {
        RepresentationRelation::WrapperOmitted
    } else {
        RepresentationRelation::Conflict
    }
}

fn optional_redundant_sequence_relation<T: PartialEq>(
    shell: &[T],
    wrapper: &[T],
) -> RepresentationRelation {
    if shell == wrapper {
        RepresentationRelation::Exact
    } else if !shell.is_empty() && wrapper.is_empty() {
        RepresentationRelation::WrapperOmitted
    } else {
        RepresentationRelation::Conflict
    }
}

fn canonical_parameter_layout(raw: &str) -> String {
    let chars = raw.chars().collect::<Vec<_>>();
    let mut out = String::with_capacity(raw.len());
    let mut index = 0usize;
    let mut quote: Option<(char, bool)> = None;
    let mut escaped = false;

    while index < chars.len() {
        let ch = chars[index];

        if let Some((delimiter, triple)) = quote {
            out.push(ch);

            if escaped {
                escaped = false;
                index += 1;
                continue;
            }

            if ch == '\\' {
                escaped = true;
                index += 1;
                continue;
            }

            if triple {
                if ch == delimiter
                    && index + 2 < chars.len()
                    && chars[index + 1] == delimiter
                    && chars[index + 2] == delimiter
                {
                    out.push(chars[index + 1]);
                    out.push(chars[index + 2]);
                    index += 3;
                    quote = None;
                    continue;
                }
            } else if ch == delimiter {
                quote = None;
            }

            index += 1;
            continue;
        }

        if ch == '\'' || ch == '"' {
            let triple =
                index + 2 < chars.len() && chars[index + 1] == ch && chars[index + 2] == ch;

            out.push(ch);

            if triple {
                out.push(chars[index + 1]);
                out.push(chars[index + 2]);
                index += 3;
            } else {
                index += 1;
            }

            quote = Some((ch, triple));
            continue;
        }

        if ch == ',' {
            while out
                .chars()
                .next_back()
                .is_some_and(|value| value.is_ascii_whitespace())
            {
                out.pop();
            }

            out.push(',');
            index += 1;

            while index < chars.len() && chars[index].is_ascii_whitespace() {
                index += 1;
            }

            continue;
        }

        out.push(ch);
        index += 1;
    }

    compact_ws(&out)
}

fn canonicalize_unit(unit: &UnitInput) -> Value {
    if unit.body.len() > 64 * 1024 {
        return json!({
            "ok": false,
            "protocol": PROTOCOL,
            "canonicalizer_protocol": CANONICALIZER_PROTOCOL,
            "reason": "semantic_unit_body_budget_exceeded",
        });
    }

    let mut body = unit.body.replace("\r\n", "\n").replace('\r', "\n");
    let mut normalizations = Vec::<String>::new();

    let parsed = match parse_module(&body) {
        Ok(value) => value,
        Err(error) => {
            return json!({
                "ok": false,
                "protocol": PROTOCOL,
                "canonicalizer_protocol": CANONICALIZER_PROTOCOL,
                "reason": "semantic_unit_body_syntax_invalid",
                "detail": error.to_string(),
            });
        }
    };

    if matches!(unit.kind.as_str(), "function" | "async_function")
        && parsed.syntax().body.len() == 1
        && let Stmt::FunctionDef(function) = &parsed.syntax().body[0]
    {
        let expected_async = unit.kind == "async_function";

        if function.name.as_str() != unit.name || function.is_async != expected_async {
            return json!({
                "ok": false,
                "protocol": PROTOCOL,
                "canonicalizer_protocol": CANONICALIZER_PROTOCOL,
                "reason": "representation_ambiguous",
                "detail": "redundant_wrapper_conflict",
                "conflict": "identity",
                "shell_name": unit.name.as_str(),
                "wrapper_name": function.name.as_str(),
                "shell_async": expected_async,
                "wrapper_async": function.is_async,
            });
        }

        let shell_params = canonical_parameter_layout(&unit.parameters);
        let wrapper_params =
            canonical_parameter_layout(&function_parameter_source(&body, function));
        let shell_returns = compact_ws(unit.returns.as_deref().unwrap_or(""));
        let wrapper_returns = function_return_source(&body, function);
        let shell_decorators = unit
            .decorators
            .iter()
            .map(|value| compact_ws(value.trim_start_matches('@')))
            .collect::<Vec<_>>();
        let wrapper_decorators = function_decorators(&body, function);

        // Parameters are never optional metadata. `()` is an explicit
        // zero-parameter signature, so any difference is a real conflict.
        if shell_params != wrapper_params {
            return json!({
                "ok": false,
                "protocol": PROTOCOL,
                "canonicalizer_protocol": CANONICALIZER_PROTOCOL,
                "reason": "representation_ambiguous",
                "detail": "redundant_wrapper_conflict",
                "conflict": "parameters",
                "shell_parameters": shell_params,
                "wrapper_parameters": wrapper_params,
            });
        }

        // Return annotations are optional redundant metadata.
        // The structured shell owns authority. A wrapper may omit the
        // annotation, but it may never add or contradict one.
        match optional_redundant_scalar_relation(&shell_returns, &wrapper_returns) {
            RepresentationRelation::Exact => {}
            RepresentationRelation::WrapperOmitted => {
                normalizations.push("redundant_wrapper_return_omission".to_string());
            }
            RepresentationRelation::Conflict => {
                return json!({
                    "ok": false,
                    "protocol": PROTOCOL,
                    "canonicalizer_protocol": CANONICALIZER_PROTOCOL,
                    "reason": "representation_ambiguous",
                    "detail": "redundant_wrapper_conflict",
                    "conflict": "return_annotation",
                    "shell_returns": shell_returns,
                    "wrapper_returns": wrapper_returns,
                });
            }
        }

        // Decorators materially affect semantics, but an empty wrapper
        // decorator list can safely be less informative than the shell.
        // Partial/different/additional wrapper decorators remain ambiguous.
        match optional_redundant_sequence_relation(&shell_decorators, &wrapper_decorators) {
            RepresentationRelation::Exact => {}
            RepresentationRelation::WrapperOmitted => {
                normalizations.push("redundant_wrapper_decorator_omission".to_string());
            }
            RepresentationRelation::Conflict => {
                return json!({
                    "ok": false,
                    "protocol": PROTOCOL,
                    "canonicalizer_protocol": CANONICALIZER_PROTOCOL,
                    "reason": "representation_ambiguous",
                    "detail": "redundant_wrapper_conflict",
                    "conflict": "decorators",
                    "shell_decorators": shell_decorators,
                    "wrapper_decorators": wrapper_decorators,
                });
            }
        }

        body = function_body_source(&body, function);
        normalizations.push("redundant_function_wrapper_removed".to_string());
    }

    let parsed = match parse_module(&body) {
        Ok(value) => value,
        Err(error) => {
            return json!({
                "ok": false,
                "protocol": PROTOCOL,
                "canonicalizer_protocol": CANONICALIZER_PROTOCOL,
                "reason": "semantic_unit_body_syntax_invalid_after_unwrap",
                "detail": error.to_string(),
            });
        }
    };

    let module = parsed.syntax();

    // Semantic-unit bodies are scope-bearing program text.
    //
    // An import at the beginning of a function/class body is NOT a
    // module import and therefore must never be hoisted merely because
    // it is a syntactic prefix. The model has no import authority;
    // dependency authority is established later by the Python frontend.
    //
    // Keep the canonicalizer output ABI stable: import_hints remains
    // present, but semantic-body imports are deliberately not converted
    // into model import hints.
    let import_hints = Vec::<ImportIntent>::new();

    let mut prefix_import_ranges = Vec::<ByteRange>::new();
    let mut prefix_open = true;
    let mut first = true;

    for stmt in &module.body {
        if first && is_docstring(stmt) {
            first = false;
            continue;
        }
        first = false;

        if prefix_open && matches!(stmt, Stmt::Import(_) | Stmt::ImportFrom(_)) {
            // Validate that this is a statically representable Python
            // import, but preserve the statement at its original scope.
            if let Err(reason) = import_intents(stmt) {
                return json!({
                    "ok": false,
                    "protocol": PROTOCOL,
                    "canonicalizer_protocol": CANONICALIZER_PROTOCOL,
                    "reason": "semantic_unsupported",
                    "detail": reason,
                });
            }

            prefix_import_ranges.push(line_expanded_range(&body, stmt));
            continue;
        }

        prefix_open = false;
    }

    let mut facts = Facts::default();
    facts.visit_body(&module.body);

    if !prefix_import_ranges.is_empty() {
        normalizations.push("scoped_prefix_import_preserved".to_string());
    }

    if facts.import_ranges.len() > prefix_import_ranges.len() {
        normalizations.push("scoped_nested_import_preserved".to_string());
    }

    if body.trim().is_empty() {
        return json!({
            "ok": false,
            "protocol": PROTOCOL,
            "canonicalizer_protocol": CANONICALIZER_PROTOCOL,
            "reason": "representation_ambiguous",
            "detail": "body_empty_after_normalization",
        });
    }

    json!({
        "ok": true,
        "protocol": PROTOCOL,
        "canonicalizer_protocol": CANONICALIZER_PROTOCOL,
        "body": body,
        "import_hints": import_hints,
        "normalizations": normalizations,
        "authority_expansion": false,
    })
}

fn structural_statement_kind(stmt: &Stmt) -> &'static str {
    match stmt {
        Stmt::FunctionDef(_) => "FunctionDef",
        Stmt::ClassDef(_) => "ClassDef",
        Stmt::Import(_) => "Import",
        Stmt::ImportFrom(_) => "ImportFrom",
        Stmt::Assign(_) => "Assign",
        Stmt::AnnAssign(_) => "AnnAssign",
        Stmt::AugAssign(_) => "AugAssign",
        Stmt::Expr(_) => "Expr",
        _ => "OtherStmt",
    }
}

const MODULE_FRAGMENT_CANONICALIZER_PROTOCOL: &str = "ruff-python-module-fragment-canonicalizer-v1";

fn source_fragment_statement_bounds(source: &str, stmt: &Stmt) -> (usize, usize) {
    let mut start = stmt.range().start().to_usize();
    if let Stmt::FunctionDef(function) = stmt {
        if let Some(decorator) = function.decorator_list.first() {
            let decorator_start = decorator.range().start().to_usize();
            let line_start = source.as_bytes()[..decorator_start]
                .iter()
                .rposition(|value| *value == b'\n')
                .map_or(0, |index| index + 1);
            start = start.min(line_start);
        }
    }
    (start, stmt.range().end().to_usize())
}

fn source_fragment_trivia_is_whitespace(bytes: &[u8]) -> bool {
    bytes
        .iter()
        .all(|value| matches!(value, b' ' | b'\t' | b'\n' | b'\r' | 0x0c))
}

fn canonicalize_source_fragment(source: &str) -> Value {
    let normalized = source.replace("\r\n", "\n").replace('\r', "\n");
    if normalized.is_empty() || normalized.len() > 96 * 1024 {
        return json!({
            "ok": false,
            "protocol": PROTOCOL,
            "canonicalizer_protocol": MODULE_FRAGMENT_CANONICALIZER_PROTOCOL,
            "reason": "source_fragment_budget_invalid",
            "authority": "representation_only",
            "mutation_authority": false,
        });
    }

    let parsed = match parse_module(&normalized) {
        Ok(value) => value,
        Err(error) => {
            return json!({
                "ok": false,
                "protocol": PROTOCOL,
                "canonicalizer_protocol": MODULE_FRAGMENT_CANONICALIZER_PROTOCOL,
                "reason": "source_fragment_syntax_invalid",
                "detail": error.to_string(),
                "authority": "representation_only",
                "mutation_authority": false,
            });
        }
    };

    let statements = &parsed.syntax().body;
    if statements.is_empty() || statements.len() > 8 {
        return json!({
            "ok": false,
            "protocol": PROTOCOL,
            "canonicalizer_protocol": MODULE_FRAGMENT_CANONICALIZER_PROTOCOL,
            "reason": "source_fragment_declaration_count_invalid",
            "statements": statements.len(),
            "max_statements": 8,
            "authority": "representation_only",
            "mutation_authority": false,
        });
    }

    let mut imports = Vec::<String>::new();
    let mut declarations = Vec::<String>::new();
    let mut bounds = Vec::<(usize, usize)>::with_capacity(statements.len());
    let mut declaration_seen = false;
    let mut import_after_declaration = false;

    for (index, stmt) in statements.iter().enumerate() {
        let (start, end) = source_fragment_statement_bounds(&normalized, stmt);
        if end <= start || end > normalized.len() {
            return json!({
                "ok": false,
                "protocol": PROTOCOL,
                "canonicalizer_protocol": MODULE_FRAGMENT_CANONICALIZER_PROTOCOL,
                "reason": "module_fragment_canonicalization_range_invalid",
                "statement_index": index,
                "authority": "representation_only",
                "mutation_authority": false,
            });
        }
        let Some(statement_source) = normalized.get(start..end) else {
            return json!({
                "ok": false,
                "protocol": PROTOCOL,
                "canonicalizer_protocol": MODULE_FRAGMENT_CANONICALIZER_PROTOCOL,
                "reason": "module_fragment_canonicalization_utf8_boundary_invalid",
                "statement_index": index,
                "authority": "representation_only",
                "mutation_authority": false,
            });
        };
        bounds.push((start, end));

        match stmt {
            Stmt::Import(_) | Stmt::ImportFrom(_) => {
                if import_intents(stmt).is_err() {
                    return json!({
                        "ok": false,
                        "protocol": PROTOCOL,
                        "canonicalizer_protocol": MODULE_FRAGMENT_CANONICALIZER_PROTOCOL,
                        "reason": "module_fragment_canonicalization_import_not_representable",
                        "statement_index": index,
                        "authority": "representation_only",
                        "mutation_authority": false,
                    });
                }
                if declaration_seen {
                    import_after_declaration = true;
                }
                imports.push(statement_source.to_string());
            }
            Stmt::FunctionDef(_) => {
                declaration_seen = true;
                declarations.push(statement_source.to_string());
            }
            _ => {
                return json!({
                    "ok": false,
                    "protocol": PROTOCOL,
                    "canonicalizer_protocol": MODULE_FRAGMENT_CANONICALIZER_PROTOCOL,
                    "reason": "module_fragment_canonicalization_forbidden_node",
                    "statement_index": index,
                    "node_kind": structural_statement_kind(stmt),
                    "authority": "representation_only",
                    "semantic_repair_required": true,
                    "mutation_authority": false,
                });
            }
        }
    }

    if declarations.is_empty() {
        return json!({
            "ok": false,
            "protocol": PROTOCOL,
            "canonicalizer_protocol": MODULE_FRAGMENT_CANONICALIZER_PROTOCOL,
            "reason": "module_fragment_canonicalization_declaration_missing",
            "authority": "representation_only",
            "mutation_authority": false,
        });
    }

    let bytes = normalized.as_bytes();
    let mut prior_end = 0usize;
    for (index, (start, end)) in bounds.iter().copied().enumerate() {
        if start < prior_end || !source_fragment_trivia_is_whitespace(&bytes[prior_end..start]) {
            return json!({
                "ok": false,
                "protocol": PROTOCOL,
                "canonicalizer_protocol": MODULE_FRAGMENT_CANONICALIZER_PROTOCOL,
                "reason": "module_fragment_canonicalization_trivia_ambiguous",
                "statement_index": index,
                "authority": "representation_only",
                "mutation_authority": false,
            });
        }
        prior_end = end;
    }
    if !source_fragment_trivia_is_whitespace(&bytes[prior_end..]) {
        return json!({
            "ok": false,
            "protocol": PROTOCOL,
            "canonicalizer_protocol": MODULE_FRAGMENT_CANONICALIZER_PROTOCOL,
            "reason": "module_fragment_canonicalization_trivia_ambiguous",
            "statement_index": statements.len(),
            "authority": "representation_only",
            "mutation_authority": false,
        });
    }

    if !import_after_declaration {
        return json!({
            "ok": false,
            "protocol": PROTOCOL,
            "canonicalizer_protocol": MODULE_FRAGMENT_CANONICALIZER_PROTOCOL,
            "reason": "module_fragment_canonicalization_not_needed",
            "authority": "representation_only",
            "mutation_authority": false,
        });
    }

    let mut canonical = String::new();
    if !imports.is_empty() {
        canonical.push_str(&imports.join("\n"));
        canonical.push_str("\n\n");
    }
    canonical.push_str(&declarations.join("\n\n"));
    if normalized.ends_with('\n') {
        canonical.push('\n');
    }

    let canonical_parsed = match parse_module(&canonical) {
        Ok(value) => value,
        Err(error) => {
            return json!({
                "ok": false,
                "protocol": PROTOCOL,
                "canonicalizer_protocol": MODULE_FRAGMENT_CANONICALIZER_PROTOCOL,
                "reason": "module_fragment_canonicalization_reparse_failed",
                "detail": error.to_string(),
                "authority": "representation_only",
                "mutation_authority": false,
            });
        }
    };
    let mut declaration_seen = false;
    for stmt in &canonical_parsed.syntax().body {
        match stmt {
            Stmt::Import(_) | Stmt::ImportFrom(_) if !declaration_seen => {}
            Stmt::FunctionDef(_) => declaration_seen = true,
            _ => {
                return json!({
                    "ok": false,
                    "protocol": PROTOCOL,
                    "canonicalizer_protocol": MODULE_FRAGMENT_CANONICALIZER_PROTOCOL,
                    "reason": "module_fragment_canonicalization_postcondition_failed",
                    "authority": "representation_only",
                    "mutation_authority": false,
                });
            }
        }
    }

    json!({
        "ok": true,
        "protocol": PROTOCOL,
        "canonicalizer_protocol": MODULE_FRAGMENT_CANONICALIZER_PROTOCOL,
        "reason": "module_fragment_import_prefix_canonicalized",
        "source": canonical,
        "source_changed": canonical != normalized,
        "import_statements": imports.len(),
        "declaration_statements": declarations.len(),
        "parser": "ruff_python_parser",
        "authority": "representation_only",
        "semantic_repair_required": false,
        "mutation_authority": false,
    })
}

fn lower_source_fragment(source: &str) -> Value {
    let normalized = source.replace("\r\n", "\n").replace('\r', "\n");
    if normalized.is_empty() || normalized.len() > 96 * 1024 {
        return json!({
            "ok": false,
            "protocol": PROTOCOL,
            "reason": "source_fragment_budget_invalid",
            "mutation_authority": false,
        });
    }

    let parsed = match parse_module(&normalized) {
        Ok(value) => value,
        Err(error) => {
            return json!({
                "ok": false,
                "protocol": PROTOCOL,
                "reason": "source_fragment_syntax_invalid",
                "detail": error.to_string(),
                "mutation_authority": false,
            });
        }
    };

    let statements = &parsed.syntax().body;
    if statements.is_empty() || statements.len() > 32 {
        return json!({
            "ok": false,
            "protocol": PROTOCOL,
            "reason": "source_fragment_statement_count_invalid",
            "statements": statements.len(),
            "max_statements": 32,
            "mutation_authority": false,
        });
    }

    let mut units = Vec::<Value>::new();
    let mut module_imports = Vec::<ImportIntent>::new();
    let mut declarations_started = false;

    for (index, stmt) in statements.iter().enumerate() {
        if matches!(stmt, Stmt::Import(_) | Stmt::ImportFrom(_)) {
            if declarations_started {
                return json!({
                    "ok": false,
                    "protocol": PROTOCOL,
                    "reason": "source_fragment_import_after_declaration",
                    "statement_index": index,
                    "mutation_authority": false,
                });
            }
            match import_intents(stmt) {
                Ok(rows) => module_imports.extend(rows),
                Err(reason) => {
                    return json!({
                        "ok": false,
                        "protocol": PROTOCOL,
                        "reason": "source_fragment_import_unsupported",
                        "statement_index": index,
                        "detail": reason,
                        "mutation_authority": false,
                    });
                }
            }
            continue;
        }

        declarations_started = true;
        let Stmt::FunctionDef(function) = stmt else {
            return json!({
                "ok": false,
                "protocol": PROTOCOL,
                "reason": "source_fragment_top_level_kind_forbidden",
                "statement_index": index,
                "structural_witness": {
                    "protocol": STRUCTURAL_WITNESS_PROTOCOL,
                    "parser": "ruff_python_parser",
                    "parser_input_normalization": "universal_newline_to_lf",
                    "node_kind": structural_statement_kind(stmt),
                    "statement_index": index,
                    "start_byte": stmt.range().start().to_usize(),
                    "end_byte": stmt.range().end().to_usize(),
                    "mutation_authority": false,
                },
                "mutation_authority": false,
            });
        };

        if units.len() >= 8 {
            return json!({
                "ok": false,
                "protocol": PROTOCOL,
                "reason": "source_fragment_declaration_count_invalid",
                "declarations": units.len() + 1,
                "max_declarations": 8,
                "mutation_authority": false,
            });
        }

        let body = function_body_source(&normalized, function);
        let body_parsed = match parse_module(&body) {
            Ok(value) => value,
            Err(error) => {
                return json!({
                    "ok": false,
                    "protocol": PROTOCOL,
                    "reason": "source_fragment_body_syntax_invalid",
                    "statement_index": index,
                    "detail": error.to_string(),
                    "mutation_authority": false,
                });
            }
        };
        let suite: Vec<String> = body_parsed
            .syntax()
            .body
            .iter()
            .map(|item| source_slice(&body, item.range()).trim_end().to_string())
            .collect();
        if suite.is_empty() {
            return json!({
                "ok": false,
                "protocol": PROTOCOL,
                "reason": "source_fragment_body_empty",
                "statement_index": index,
                "mutation_authority": false,
            });
        }

        let returns = function_return_source(&normalized, function);
        let mut unit = json!({
            "kind": if function.is_async { "async_function" } else { "function" },
            "name": function.name.as_str(),
            "parameters": function_parameter_source(&normalized, function),
            "decorators": function_decorators(&normalized, function),
            "suite": suite,
        });
        if !returns.is_empty() {
            unit.as_object_mut()
                .expect("unit object")
                .insert("returns".to_string(), json!(returns));
        }
        units.push(unit);
    }

    if units.is_empty() {
        return json!({
            "ok": false,
            "protocol": PROTOCOL,
            "reason": "source_fragment_declaration_missing",
            "mutation_authority": false,
        });
    }

    json!({
        "ok": true,
        "protocol": PROTOCOL,
        "source_fragment_protocol": "source-slot-python-fragment-v2",
        "units": units,
        "module_imports": module_imports,
        "module_import_count": module_imports.len(),
        "parser": "ruff_python_parser",
        "execution_model": "typed_source_fragment_frontend",
        "authority_expansion": false,
        "mutation_authority": false,
    })
}

fn suite_statement_shape(stmt: &Stmt) -> &'static str {
    match stmt {
        Stmt::Expr(expr) => match expr.value.as_ref() {
            Expr::Name(_) => "bare_name_expr",
            Expr::StringLiteral(_) => "string_literal_expr",
            _ => "expression",
        },
        _ => "statement",
    }
}

fn validate_suite_items(sources: &[SourceInput]) -> Value {
    const MAX_SUITE_ITEMS: usize = 64;
    const MAX_SUITE_ITEM_BYTES: usize = 64 * 1024;

    if sources.is_empty() || sources.len() > MAX_SUITE_ITEMS {
        return json!({
            "ok": false,
            "protocol": PROTOCOL,
            "suite_protocol": "python-suite-ir-v2",
            "reason": "semantic_suite_item_count_invalid",
            "items": sources.len(),
            "max_items": MAX_SUITE_ITEMS,
            "mutation_authority": false,
        });
    }

    let mut statement_counts = Vec::with_capacity(sources.len());
    let mut statement_shapes = Vec::with_capacity(sources.len());

    for (index, row) in sources.iter().enumerate() {
        if row.source.len() > MAX_SUITE_ITEM_BYTES {
            return json!({
                "ok": false,
                "protocol": PROTOCOL,
                "suite_protocol": "python-suite-ir-v2",
                "reason": "semantic_suite_item_budget_exceeded",
                "suite_index": index,
                "max_bytes": MAX_SUITE_ITEM_BYTES,
                "mutation_authority": false,
            });
        }

        let parsed = match parse_module(&row.source) {
            Ok(value) => value,
            Err(error) => {
                return json!({
                    "ok": false,
                    "protocol": PROTOCOL,
                    "suite_protocol": "python-suite-ir-v2",
                    "reason": "semantic_suite_item_syntax_invalid",
                    "suite_index": index,
                    "detail": error.to_string(),
                    "mutation_authority": false,
                });
            }
        };

        let statements = parsed.syntax().body.len();

        if statements < 1 {
            return json!({
                "ok": false,
                "protocol": PROTOCOL,
                "suite_protocol": "python-suite-ir-v2",
                "reason": "semantic_suite_item_statement_count_invalid",
                "suite_index": index,
                "statements": statements,
                "minimum_statements": 1,
                "mutation_authority": false,
            });
        }

        statement_counts.push(statements);
        statement_shapes.push(
            parsed
                .syntax()
                .body
                .iter()
                .map(suite_statement_shape)
                .collect::<Vec<_>>(),
        );
    }

    json!({
        "ok": true,
        "protocol": PROTOCOL,
        "suite_protocol": "python-suite-ir-v2",
        "items": sources.len(),
        "statement_counts": statement_counts,
        "statement_shapes": statement_shapes,
        "parser": "ruff_python_parser",
        "atomic_statement_boundary": false,
        "statement_chunk_boundary": true,
        "minimum_statements_per_chunk": 1,
        "mutation_authority": false,
    })
}

fn index_sources(sources: &[SourceInput]) -> Value {
    let mut aliases: BTreeMap<String, Vec<Value>> = BTreeMap::new();
    let mut observed_modules = BTreeSet::<String>::new();
    let mut files = 0usize;
    let mut bytes = 0usize;

    for row in sources {
        files += 1;
        bytes += row.source.len();

        let parsed = match parse_module(&row.source) {
            Ok(value) => value,
            Err(_) => continue,
        };
        let mut facts = Facts::default();
        facts.visit_body(&parsed.syntax().body);

        for import in facts.imports {
            observed_modules.insert(
                import
                    .module
                    .split('.')
                    .next()
                    .unwrap_or(import.module.as_str())
                    .to_string(),
            );
            aliases
                .entry(import.local.clone())
                .or_default()
                .push(json!({
                    "kind": import.kind,
                    "module": import.module,
                    "name": import.name,
                    "local": import.local,
                    "canonical": import.canonical,
                    "alias": import.alias,
                    "source": "repo_import_witness",
                    "witness_file": row.file,
                }));
        }
    }

    json!({
        "ok": true,
        "protocol": PROTOCOL,
        "aliases": aliases,
        "observed_modules": observed_modules,
        "files": files,
        "bytes": bytes,
    })
}

fn dispatch(request: Request) -> Value {
    match request.command.as_str() {
        "protocol" => json!({
            "ok": true,
            "protocol": PROTOCOL,
            "canonicalizer_protocol": CANONICALIZER_PROTOCOL,
        }),
        "analyze" => {
            let Some(source) = request.source.as_deref() else {
                return json!({"ok": false, "protocol": PROTOCOL, "reason": "source_missing"});
            };
            analyze(source)
        }
        "lower_source_fragment" => {
            let Some(source) = request.source.as_deref() else {
                return json!({"ok": false, "protocol": PROTOCOL, "reason": "source_missing"});
            };
            lower_source_fragment(source)
        }
        "canonicalize_source_fragment" => {
            let Some(source) = request.source.as_deref() else {
                return json!({"ok": false, "protocol": PROTOCOL, "reason": "source_missing"});
            };
            canonicalize_source_fragment(source)
        }
        "validate_suite_items" => validate_suite_items(&request.sources),
        "canonicalize_unit" => {
            let Some(unit) = request.unit.as_ref() else {
                return json!({"ok": false, "protocol": PROTOCOL, "reason": "unit_missing"});
            };
            canonicalize_unit(unit)
        }
        "index_sources" => index_sources(&request.sources),
        other => json!({
            "ok": false,
            "protocol": PROTOCOL,
            "reason": "command_unsupported",
            "command": other,
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn canonicalize(unit: UnitInput) -> Value {
        dispatch(Request {
            command: "canonicalize_unit".to_string(),
            source: None,
            unit: Some(unit),
            sources: Vec::new(),
        })
    }

    fn unit(kind: &str, name: &str, body: &str) -> UnitInput {
        UnitInput {
            kind: kind.to_string(),
            name: name.to_string(),
            parameters: "value: int".to_string(),
            returns: Some("int".to_string()),
            decorators: Vec::new(),
            body: body.to_string(),
        }
    }

    #[test]
    fn canonicalizes_exact_redundant_wrapper() {
        let row = canonicalize(unit(
            "function",
            "answer",
            concat!(
                "def answer(value: int) -> int:\n",
                "    import math\n",
                "    return math.floor(value)\n",
            ),
        ));

        assert_eq!(row.get("ok").and_then(Value::as_bool), Some(true));
        assert_eq!(
            row.get("authority_expansion").and_then(Value::as_bool),
            Some(false)
        );
        assert_eq!(
            row.get("body").and_then(Value::as_str),
            Some("import math\nreturn math.floor(value)")
        );

        let normalizations = row
            .get("normalizations")
            .and_then(Value::as_array)
            .expect("normalizations");

        assert!(
            normalizations
                .iter()
                .any(|value| { value.as_str() == Some("redundant_function_wrapper_removed") })
        );
        assert!(
            normalizations
                .iter()
                .any(|value| { value.as_str() == Some("scoped_prefix_import_preserved") })
        );
    }

    #[test]
    fn accepts_wrapper_return_omission_for_open_annotation_space() {
        // Product code MUST NOT maintain a whitelist of Python types.
        // These are representative syntax families only.
        let annotations = [
            "None",
            "bool",
            "int",
            "float",
            "complex",
            "str",
            "bytes",
            "list[str]",
            "dict[str, int]",
            "set[str]",
            "frozenset[str]",
            "tuple[str, ...]",
            "str | None",
            "typing.Optional[str]",
            "typing.Union[str, int]",
            "typing.Literal[\"x\"]",
            "typing.Annotated[int, \"unit\"]",
            "collections.abc.Callable[[str], int]",
            "Response",
            "T",
        ];

        for annotation in annotations {
            let mut value = unit(
                "function",
                "answer",
                concat!("def answer(value: int):\n", "    return value\n",),
            );
            value.returns = Some(annotation.to_string());

            let row = canonicalize(value);

            assert_eq!(
                row.get("ok").and_then(Value::as_bool),
                Some(true),
                "annotation={annotation} row={row}",
            );
            assert_eq!(
                row.get("authority_expansion").and_then(Value::as_bool),
                Some(false),
            );

            let normalizations = row
                .get("normalizations")
                .and_then(Value::as_array)
                .expect("normalizations");

            assert!(
                normalizations
                    .iter()
                    .any(|value| { value.as_str() == Some("redundant_wrapper_return_omission") }),
                "annotation={annotation} row={row}",
            );
        }
    }

    #[test]
    fn rejects_wrapper_return_authority_expansion() {
        let mut value = unit(
            "function",
            "answer",
            concat!("def answer(value: int) -> int:\n", "    return value\n",),
        );
        value.returns = None;

        let row = canonicalize(value);

        assert_eq!(row.get("ok").and_then(Value::as_bool), Some(false));
        assert_eq!(
            row.get("reason").and_then(Value::as_str),
            Some("representation_ambiguous"),
        );
        assert_eq!(
            row.get("conflict").and_then(Value::as_str),
            Some("return_annotation"),
        );
    }

    #[test]
    fn rejects_explicit_wrapper_return_conflict() {
        let mut value = unit(
            "function",
            "answer",
            concat!(
                "def answer(value: int) -> str:\n",
                "    return str(value)\n",
            ),
        );
        value.returns = Some("int".to_string());

        let row = canonicalize(value);

        assert_eq!(row.get("ok").and_then(Value::as_bool), Some(false));
        assert_eq!(
            row.get("conflict").and_then(Value::as_str),
            Some("return_annotation"),
        );
    }

    #[test]
    fn rejects_redundant_wrapper_parameter_conflict() {
        let row = canonicalize(unit(
            "function",
            "answer",
            concat!("def answer(other: int) -> int:\n", "    return other\n",),
        ));

        assert_eq!(row.get("ok").and_then(Value::as_bool), Some(false));
        assert_eq!(
            row.get("conflict").and_then(Value::as_str),
            Some("parameters"),
        );
    }

    #[test]
    fn accepts_wrapper_decorator_omission() {
        let mut value = unit(
            "function",
            "answer",
            concat!("def answer(value: int) -> int:\n", "    return value\n",),
        );
        value.decorators = vec!["staticmethod".to_string()];

        let row = canonicalize(value);

        assert_eq!(row.get("ok").and_then(Value::as_bool), Some(true));
        assert_eq!(
            row.get("authority_expansion").and_then(Value::as_bool),
            Some(false),
        );

        let normalizations = row
            .get("normalizations")
            .and_then(Value::as_array)
            .expect("normalizations");

        assert!(
            normalizations
                .iter()
                .any(|value| { value.as_str() == Some("redundant_wrapper_decorator_omission") })
        );
    }

    #[test]
    fn rejects_wrapper_decorator_authority_expansion() {
        let row = canonicalize(unit(
            "function",
            "answer",
            concat!(
                "@staticmethod\n",
                "def answer(value: int) -> int:\n",
                "    return value\n",
            ),
        ));

        assert_eq!(row.get("ok").and_then(Value::as_bool), Some(false));
        assert_eq!(
            row.get("conflict").and_then(Value::as_str),
            Some("decorators"),
        );
    }

    #[test]
    fn rejects_explicit_wrapper_decorator_conflict() {
        let mut value = unit(
            "function",
            "answer",
            concat!(
                "@staticmethod\n",
                "def answer(value: int) -> int:\n",
                "    return value\n",
            ),
        );
        value.decorators = vec!["classmethod".to_string()];

        let row = canonicalize(value);

        assert_eq!(row.get("ok").and_then(Value::as_bool), Some(false));
        assert_eq!(
            row.get("conflict").and_then(Value::as_str),
            Some("decorators"),
        );
    }

    #[test]
    fn rejects_wrong_redundant_wrapper_identity() {
        let row = canonicalize(unit(
            "function",
            "answer",
            concat!(
                "def completely_different(value: int) -> int:\n",
                "    return value\n",
            ),
        ));

        assert_eq!(row.get("ok").and_then(Value::as_bool), Some(false));
        assert_eq!(
            row.get("reason").and_then(Value::as_str),
            Some("representation_ambiguous")
        );
        assert_eq!(
            row.get("detail").and_then(Value::as_str),
            Some("redundant_wrapper_conflict")
        );
        assert_eq!(
            row.get("conflict").and_then(Value::as_str),
            Some("identity")
        );
    }

    #[test]
    fn rejects_sync_async_wrapper_identity_mismatch() {
        let row = canonicalize(unit(
            "function",
            "answer",
            concat!(
                "async def answer(value: int) -> int:\n",
                "    return value\n",
            ),
        ));

        assert_eq!(row.get("ok").and_then(Value::as_bool), Some(false));
        assert_eq!(
            row.get("reason").and_then(Value::as_str),
            Some("representation_ambiguous")
        );
        assert_eq!(
            row.get("detail").and_then(Value::as_str),
            Some("redundant_wrapper_conflict")
        );
        assert_eq!(
            row.get("conflict").and_then(Value::as_str),
            Some("identity")
        );
    }

    #[test]
    fn accepts_redundant_wrapper_parameter_comma_whitespace() {
        let mut input = unit(
            "function",
            "answer",
            concat!(
                "def answer(left, right) -> int:\n",
                "    return left + right\n",
            ),
        );

        input.parameters = "left,right".to_string();

        let row = canonicalize(input);

        assert_eq!(row.get("ok").and_then(Value::as_bool), Some(true), "{row}");
        assert_eq!(
            row.get("authority_expansion").and_then(Value::as_bool),
            Some(false),
            "{row}"
        );
        assert!(
            row.get("normalizations")
                .and_then(Value::as_array)
                .is_some_and(|rows| rows
                    .iter()
                    .any(|value| { value.as_str() == Some("redundant_function_wrapper_removed") })),
            "{row}"
        );
    }

    #[test]
    fn redundant_wrapper_parameter_string_content_remains_authoritative() {
        let mut input = unit(
            "function",
            "answer",
            concat!("def answer(value=\"a,b\") -> int:\n", "    return 1\n",),
        );

        input.parameters = "value=\"a, b\"".to_string();

        let row = canonicalize(input);

        assert_eq!(row.get("ok").and_then(Value::as_bool), Some(false), "{row}");
        assert_eq!(
            row.get("reason").and_then(Value::as_str),
            Some("representation_ambiguous"),
            "{row}"
        );
    }

    #[test]
    fn accepts_matching_async_redundant_wrapper() {
        let row = canonicalize(unit(
            "async_function",
            "answer",
            concat!(
                "async def answer(value: int) -> int:\n",
                "    return value\n",
            ),
        ));

        assert_eq!(row.get("ok").and_then(Value::as_bool), Some(true));
        assert_eq!(
            row.get("authority_expansion").and_then(Value::as_bool),
            Some(false)
        );
        assert_eq!(
            row.get("body").and_then(Value::as_str),
            Some("return value")
        );
    }
}

fn main() -> Result<()> {
    let mut raw = String::new();
    io::stdin().read_to_string(&mut raw).context("read stdin")?;

    let request: Request = serde_json::from_str(&raw).context("decode request")?;
    let response = dispatch(request);
    serde_json::to_writer(io::stdout(), &response).context("encode response")?;
    println!();
    Ok(())
}
