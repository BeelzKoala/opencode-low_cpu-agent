use anyhow::{Context, Result, bail};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    collections::{BTreeSet, HashSet},
    env, fs,
    io::{BufRead, BufReader, Read, Write},
    path::{Component, Path, PathBuf},
    process::{Child, ChildStdin, ChildStdout, Command, Stdio},
    time::Instant,
};

const PROTOCOL: &str = "semantic-resolver-v1.1";
const AUTHORITY: &str = "shadow_semantic";

const MAX_QUERIES: usize = 8;
const MAX_RESULTS: usize = 32;
const MAX_SOURCE_BYTES: u64 = 2 * 1024 * 1024;
const MAX_LSP_MESSAGE_BYTES: usize = 4 * 1024 * 1024;

#[derive(Debug, Deserialize)]
struct Request {
    protocol: String,
    root: String,
    language: String,
    queries: Vec<Query>,
}

#[derive(Debug, Deserialize)]
struct Query {
    id: String,
    operation: String,
    file: String,
    byte_offset: usize,
    max_results: Option<usize>,
}

#[derive(Debug, Serialize)]
struct Response {
    protocol: &'static str,
    authority: &'static str,
    engine: String,
    elapsed_ms: f64,
    results: Vec<QueryResult>,
}

#[derive(Debug, Serialize)]
struct QueryResult {
    id: String,
    operation: String,
    status: String,
    bounded_complete: bool,
    elapsed_ms: f64,
    locations: Vec<Location>,
    omitted_locations: usize,
    reason: Option<String>,
}

#[derive(Debug, Clone, Eq, PartialEq, Ord, PartialOrd, Serialize)]
struct Location {
    file: String,
    start_byte: usize,
    end_byte: usize,
    line: u64,
    character: u64,
}

struct EngineSpec {
    name: &'static str,
    command: String,
    args: Vec<String>,
}

struct Lsp {
    child: Child,
    input: ChildStdin,
    output: BufReader<ChildStdout>,
    next_id: u64,
    root_uri: String,
    capabilities: Value,
}

impl Drop for Lsp {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn safe_file(root: &Path, relative: &str) -> Result<PathBuf> {
    let rel = Path::new(relative);

    if rel.is_absolute() {
        bail!("absolute_file_path");
    }

    for component in rel.components() {
        match component {
            Component::Normal(_) | Component::CurDir => {}
            _ => bail!("unsafe_file_path"),
        }
    }

    let joined = root.join(rel);
    let canonical = joined
        .canonicalize()
        .with_context(|| format!("canonicalize {}", joined.display()))?;

    if !canonical.starts_with(root) {
        bail!("file_outside_root");
    }

    let metadata = canonical.metadata()?;

    if !metadata.is_file() {
        bail!("not_regular_file");
    }

    if metadata.len() > MAX_SOURCE_BYTES {
        bail!("source_file_too_large");
    }

    Ok(canonical)
}

fn encode_uri_path(path: &Path) -> String {
    let raw = path.to_string_lossy();
    let mut out = String::from("file://");

    for byte in raw.as_bytes() {
        let safe = byte.is_ascii_alphanumeric()
            || matches!(*byte, b'/' | b'-' | b'_' | b'.' | b'~' | b':');

        if safe {
            out.push(*byte as char);
        } else {
            out.push_str(&format!("%{:02X}", byte));
        }
    }

    out
}

fn hex_value(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}

fn decode_file_uri(uri: &str) -> Result<PathBuf> {
    let raw = uri.strip_prefix("file://").context("non_file_uri")?;

    let bytes = raw.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut index = 0;

    while index < bytes.len() {
        if bytes[index] == b'%' {
            if index + 2 >= bytes.len() {
                bail!("invalid_percent_encoding");
            }

            let hi = hex_value(bytes[index + 1]).context("invalid_percent_encoding")?;
            let lo = hex_value(bytes[index + 2]).context("invalid_percent_encoding")?;

            decoded.push((hi << 4) | lo);
            index += 3;
        } else {
            decoded.push(bytes[index]);
            index += 1;
        }
    }

    let text = String::from_utf8(decoded).context("non_utf8_file_uri")?;
    Ok(PathBuf::from(text))
}

fn byte_to_lsp_position(text: &str, offset: usize) -> Result<(u64, u64)> {
    if offset > text.len() || !text.is_char_boundary(offset) {
        bail!("invalid_byte_offset");
    }

    let before = &text[..offset];

    let line = before.bytes().filter(|byte| *byte == b'\n').count() as u64;
    let line_start = before.rfind('\n').map_or(0, |value| value + 1);

    let character = before[line_start..].encode_utf16().count() as u64;

    Ok((line, character))
}

fn lsp_position_to_byte(text: &str, line: u64, character: u64) -> Result<usize> {
    let target_line = line as usize;

    let mut current_line = 0usize;
    let mut line_start = 0usize;

    for (index, byte) in text.bytes().enumerate() {
        if current_line == target_line {
            break;
        }

        if byte == b'\n' {
            current_line += 1;
            line_start = index + 1;
        }
    }

    if current_line != target_line {
        bail!("invalid_lsp_line");
    }

    let line_end = text[line_start..]
        .find('\n')
        .map_or(text.len(), |value| line_start + value);

    let line_text = &text[line_start..line_end];

    let mut utf16 = 0u64;

    for (relative, ch) in line_text.char_indices() {
        if utf16 == character {
            return Ok(line_start + relative);
        }

        utf16 += ch.len_utf16() as u64;

        if utf16 > character {
            bail!("lsp_character_inside_surrogate");
        }
    }

    if utf16 == character {
        return Ok(line_end);
    }

    bail!("invalid_lsp_character")
}

fn engine_spec(language: &str) -> Result<EngineSpec> {
    match language {
        "python" => Ok(EngineSpec {
            name: "ty",
            command: env::var("OPENCODE_TY").unwrap_or_else(|_| "ty".to_string()),
            args: vec!["server".to_string()],
        }),

        "typescript" | "javascript" => {
            let command = env::var("OPENCODE_TS7_TSC").unwrap_or_else(|_| "tsc".to_string());

            Ok(EngineSpec {
                name: "typescript7-native",
                command,
                args: vec!["--lsp".to_string(), "--stdio".to_string()],
            })
        }

        _ => bail!("unsupported_language"),
    }
}

impl Lsp {
    fn spawn(spec: &EngineSpec, root: &Path) -> Result<Self> {
        let mut child = Command::new(&spec.command)
            .args(&spec.args)
            .current_dir(root)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .with_context(|| format!("spawn {}", spec.command))?;

        let input = child.stdin.take().context("missing child stdin")?;
        let output = child.stdout.take().context("missing child stdout")?;

        Ok(Self {
            child,
            input,
            output: BufReader::new(output),
            next_id: 1,
            root_uri: encode_uri_path(root),
            capabilities: Value::Null,
        })
    }

    fn send(&mut self, value: &Value) -> Result<()> {
        let body = serde_json::to_vec(value)?;

        if body.len() > MAX_LSP_MESSAGE_BYTES {
            bail!("outgoing_lsp_message_too_large");
        }

        write!(self.input, "Content-Length: {}\r\n\r\n", body.len())?;
        self.input.write_all(&body)?;
        self.input.flush()?;

        Ok(())
    }

    fn read_message(&mut self) -> Result<Value> {
        let mut content_length = None;

        loop {
            let mut line = String::new();

            if self.output.read_line(&mut line)? == 0 {
                bail!("lsp_eof");
            }

            if line == "\r\n" || line == "\n" {
                break;
            }

            if let Some(value) = line.to_ascii_lowercase().strip_prefix("content-length:") {
                content_length = Some(value.trim().parse::<usize>()?);
            }
        }

        let length = content_length.context("missing_content_length")?;

        if length > MAX_LSP_MESSAGE_BYTES {
            bail!("incoming_lsp_message_too_large");
        }

        let mut body = vec![0u8; length];
        self.output.read_exact(&mut body)?;

        Ok(serde_json::from_slice(&body)?)
    }

    fn respond_to_server_request(&mut self, message: &Value) -> Result<bool> {
        let Some(method) = message.get("method").and_then(Value::as_str) else {
            return Ok(false);
        };

        let Some(id) = message.get("id").cloned() else {
            return Ok(false);
        };

        let result = match method {
            "workspace/configuration" => {
                let count = message
                    .pointer("/params/items")
                    .and_then(Value::as_array)
                    .map_or(0, Vec::len);

                Value::Array((0..count).map(|_| json!({})).collect())
            }

            "workspace/workspaceFolders" => json!([
                {
                    "uri": self.root_uri,
                    "name": "workspace"
                }
            ]),

            "workspace/applyEdit" => json!({
                "applied": false
            }),

            _ => Value::Null,
        };

        self.send(&json!({
            "jsonrpc": "2.0",
            "id": id,
            "result": result
        }))?;

        Ok(true)
    }

    fn request(&mut self, method: &str, params: Value) -> Result<Value> {
        let id = self.next_id;
        self.next_id += 1;

        self.send(&json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": method,
            "params": params
        }))?;

        loop {
            let message = self.read_message()?;

            if message.get("method").is_some() && message.get("id").is_some() {
                self.respond_to_server_request(&message)?;
                continue;
            }

            if message.get("id").and_then(Value::as_u64) != Some(id) {
                continue;
            }

            if let Some(error) = message.get("error") {
                bail!("lsp_error:{error}");
            }

            return Ok(message.get("result").cloned().unwrap_or(Value::Null));
        }
    }

    fn notify(&mut self, method: &str, params: Value) -> Result<()> {
        self.send(&json!({
            "jsonrpc": "2.0",
            "method": method,
            "params": params
        }))
    }

    fn initialize(&mut self) -> Result<()> {
        let result = self.request(
            "initialize",
            json!({
                "processId": std::process::id(),
                "clientInfo": {
                    "name": "opencode-semantic-resolver",
                    "version": "1"
                },
                "rootUri": self.root_uri,
                "workspaceFolders": [{
                    "uri": self.root_uri,
                    "name": "workspace"
                }],
                "capabilities": {
                    "workspace": {
                        "configuration": true,
                        "workspaceFolders": true
                    },
                    "textDocument": {
                        "definition": {},
                        "references": {},
                        "implementation": {},
                        "callHierarchy": {}
                    }
                }
            }),
        )?;

        self.capabilities = result.get("capabilities").cloned().unwrap_or(Value::Null);

        self.notify("initialized", json!({}))?;

        Ok(())
    }

    fn supported(&self, operation: &str) -> bool {
        let key = match operation {
            "definition" => "definitionProvider",
            "references" => "referencesProvider",
            "implementation" => "implementationProvider",
            _ => return false,
        };

        match self.capabilities.get(key) {
            Some(Value::Bool(value)) => *value,
            Some(Value::Object(_)) => true,
            _ => false,
        }
    }
}

fn location_values(result: &Value) -> Vec<&Value> {
    match result {
        Value::Array(values) => values.iter().collect(),
        Value::Null => Vec::new(),
        value => vec![value],
    }
}

fn resolve_locations(
    root: &Path,
    result: &Value,
    max_results: usize,
) -> Result<(Vec<Location>, usize, bool)> {
    let raw = location_values(result);
    let truncated = raw.len() > max_results;

    let mut locations = BTreeSet::new();
    let mut omitted = 0usize;

    for item in raw.into_iter().take(max_results) {
        let uri = item
            .get("uri")
            .or_else(|| item.get("targetUri"))
            .and_then(Value::as_str);

        let range = item
            .get("range")
            .or_else(|| item.get("targetSelectionRange"))
            .or_else(|| item.get("targetRange"));

        let (Some(uri), Some(range)) = (uri, range) else {
            omitted += 1;
            continue;
        };

        let candidate = match decode_file_uri(uri)
            .and_then(|path| path.canonicalize().map_err(anyhow::Error::from))
        {
            Ok(value) => value,
            Err(_) => {
                omitted += 1;
                continue;
            }
        };

        if !candidate.starts_with(root) {
            omitted += 1;
            continue;
        }

        let metadata = match candidate.metadata() {
            Ok(value) => value,
            Err(_) => {
                omitted += 1;
                continue;
            }
        };

        if metadata.len() > MAX_SOURCE_BYTES {
            omitted += 1;
            continue;
        }

        let text = match fs::read_to_string(&candidate) {
            Ok(value) => value,
            Err(_) => {
                omitted += 1;
                continue;
            }
        };

        let Some(start) = range.get("start") else {
            omitted += 1;
            continue;
        };

        let Some(end) = range.get("end") else {
            omitted += 1;
            continue;
        };

        let Some(start_line) = start.get("line").and_then(Value::as_u64) else {
            omitted += 1;
            continue;
        };

        let Some(start_character) = start.get("character").and_then(Value::as_u64) else {
            omitted += 1;
            continue;
        };

        let Some(end_line) = end.get("line").and_then(Value::as_u64) else {
            omitted += 1;
            continue;
        };

        let Some(end_character) = end.get("character").and_then(Value::as_u64) else {
            omitted += 1;
            continue;
        };

        let start_byte = match lsp_position_to_byte(&text, start_line, start_character) {
            Ok(value) => value,
            Err(_) => {
                omitted += 1;
                continue;
            }
        };

        let end_byte = match lsp_position_to_byte(&text, end_line, end_character) {
            Ok(value) => value,
            Err(_) => {
                omitted += 1;
                continue;
            }
        };

        let relative = candidate
            .strip_prefix(root)?
            .to_string_lossy()
            .replace('\\', "/");

        locations.insert(Location {
            file: relative,
            start_byte,
            end_byte,
            line: start_line,
            character: start_character,
        });
    }

    Ok((
        locations.into_iter().collect(),
        omitted,
        !truncated && omitted == 0,
    ))
}

fn operation_method(operation: &str) -> Option<&'static str> {
    match operation {
        "definition" => Some("textDocument/definition"),
        "references" => Some("textDocument/references"),
        "implementation" => Some("textDocument/implementation"),
        _ => None,
    }
}

fn run_query(
    lsp: &mut Lsp,
    root: &Path,
    language: &str,
    query: Query,
    opened: &mut HashSet<PathBuf>,
) -> QueryResult {
    let started = Instant::now();

    let fail = |status: &str, reason: String| QueryResult {
        id: query.id.clone(),
        operation: query.operation.clone(),
        status: status.to_string(),
        bounded_complete: false,
        elapsed_ms: started.elapsed().as_secs_f64() * 1000.0,
        locations: Vec::new(),
        omitted_locations: 0,
        reason: Some(reason),
    };

    let Some(method) = operation_method(&query.operation) else {
        return fail("unsupported", "unsupported_operation".to_string());
    };

    if !lsp.supported(&query.operation) {
        return fail("unsupported", "engine_capability_missing".to_string());
    }

    let path = match safe_file(root, &query.file) {
        Ok(value) => value,
        Err(error) => return fail("error", error.to_string()),
    };

    let text = match fs::read_to_string(&path) {
        Ok(value) => value,
        Err(error) => return fail("error", error.to_string()),
    };

    let (line, character) = match byte_to_lsp_position(&text, query.byte_offset) {
        Ok(value) => value,
        Err(error) => return fail("error", error.to_string()),
    };

    if opened.insert(path.clone()) {
        let language_id = match language {
            "python" => "python",
            "typescript" => "typescript",
            "javascript" => "javascript",
            _ => language,
        };

        if let Err(error) = lsp.notify(
            "textDocument/didOpen",
            json!({
                "textDocument": {
                    "uri": encode_uri_path(&path),
                    "languageId": language_id,
                    "version": 1,
                    "text": text
                }
            }),
        ) {
            return fail("error", error.to_string());
        }
    }

    let params = if query.operation == "references" {
        json!({
            "textDocument": {
                "uri": encode_uri_path(&path)
            },
            "position": {
                "line": line,
                "character": character
            },
            "context": {
                "includeDeclaration": true
            }
        })
    } else {
        json!({
            "textDocument": {
                "uri": encode_uri_path(&path)
            },
            "position": {
                "line": line,
                "character": character
            }
        })
    };

    let result = match lsp.request(method, params) {
        Ok(value) => value,
        Err(error) => return fail("error", error.to_string()),
    };

    let max_results = query
        .max_results
        .unwrap_or(MAX_RESULTS)
        .clamp(1, MAX_RESULTS);

    let (locations, omitted, bounded_complete) = match resolve_locations(root, &result, max_results)
    {
        Ok(value) => value,
        Err(error) => return fail("error", error.to_string()),
    };

    let status = match query.operation.as_str() {
        "definition" if !bounded_complete => "ambiguous",
        "definition" if locations.len() == 1 => "resolved",
        "definition" if locations.is_empty() => "unresolved",
        "definition" => "ambiguous",

        _ if locations.is_empty() => "unresolved",
        _ => "resolved",
    };

    QueryResult {
        id: query.id,
        operation: query.operation,
        status: status.to_string(),
        bounded_complete,
        elapsed_ms: started.elapsed().as_secs_f64() * 1000.0,
        locations,
        omitted_locations: omitted,
        reason: None,
    }
}

pub fn run_cli() -> Result<()> {
    let mut input = String::new();
    std::io::stdin().read_to_string(&mut input)?;

    let request: Request = serde_json::from_str(&input)?;

    if request.protocol != PROTOCOL {
        bail!("protocol_mismatch");
    }

    if request.queries.is_empty() || request.queries.len() > MAX_QUERIES {
        bail!("query_count_out_of_bounds");
    }

    let root = PathBuf::from(&request.root)
        .canonicalize()
        .context("canonicalize root")?;

    if !root.is_dir() {
        bail!("root_not_directory");
    }

    let spec = engine_spec(&request.language)?;

    let started = Instant::now();

    let mut lsp = Lsp::spawn(&spec, &root)?;
    lsp.initialize()?;

    let mut opened = HashSet::new();
    let mut results = Vec::with_capacity(request.queries.len());

    for query in request.queries {
        results.push(run_query(
            &mut lsp,
            &root,
            &request.language,
            query,
            &mut opened,
        ));
    }

    let response = Response {
        protocol: PROTOCOL,
        authority: AUTHORITY,
        engine: spec.name.to_string(),
        elapsed_ms: started.elapsed().as_secs_f64() * 1000.0,
        results,
    };

    serde_json::to_writer(std::io::stdout(), &response)?;
    println!();

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn byte_utf16_round_trip_handles_unicode() {
        let source = "α = \"🙂\"\nvalue = α\n";

        for offset in source
            .char_indices()
            .map(|(offset, _)| offset)
            .chain([source.len()])
        {
            let (line, character) = byte_to_lsp_position(source, offset).unwrap();
            let recovered = lsp_position_to_byte(source, line, character).unwrap();

            assert_eq!(offset, recovered);
        }
    }

    #[test]
    fn definition_with_multiple_locations_is_ambiguous_contract() {
        let locations = [
            Location {
                file: "a.py".into(),
                start_byte: 1,
                end_byte: 2,
                line: 0,
                character: 1,
            },
            Location {
                file: "b.py".into(),
                start_byte: 3,
                end_byte: 4,
                line: 0,
                character: 3,
            },
        ];

        assert_eq!(locations.len(), 2);
    }

    #[test]
    fn max_query_and_result_bounds_are_small() {
        assert_eq!(MAX_QUERIES, 8);
        assert_eq!(MAX_RESULTS, 32);
        assert_eq!(MAX_SOURCE_BYTES, 2 * 1024 * 1024);
    }
}
