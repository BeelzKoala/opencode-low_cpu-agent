#!/usr/bin/env bash
set -Eeuo pipefail

REPO="${REPO:-$HOME/src/opencode-low_cpu-agent}"
RUST_ROOT="$REPO/rust/evidence-distiller"
SOURCE="$RUST_ROOT/src/patch_executor.rs"
BIN_SRC="$RUST_ROOT/target/release/opencode-patch-executor"
BIN_DIR="$HOME/.local/libexec/opencode-cpu-agent"
BIN="$BIN_DIR/opencode-patch-executor"
RESULT="$REPO/benchmarks/results/v2.14-a-shadow-executor-latest.json"

command -v cargo >/dev/null 2>&1 || { echo 'STOP: cargo required' >&2; exit 1; }
command -v python3 >/dev/null 2>&1 || { echo 'STOP: python3 required' >&2; exit 1; }
command -v git >/dev/null 2>&1 || { echo 'STOP: git required' >&2; exit 1; }
command -v sha256sum >/dev/null 2>&1 || { echo 'STOP: sha256sum required' >&2; exit 1; }
[[ -f "$SOURCE" ]] || { echo "STOP: missing $SOURCE" >&2; exit 1; }
grep -q 'const PROTOCOL: &str = "patch-executor-v1"' "$SOURCE" || {
  echo 'STOP: source is not v2.14-A patch executor' >&2
  exit 1
}

mkdir -p "$BIN_DIR" "$(dirname "$RESULT")"
BIN_BACKUP=""
KEEP_BIN=0
if [[ -f "$BIN" ]]; then
  BIN_BACKUP="$(mktemp)"
  cp "$BIN" "$BIN_BACKUP"
fi

cleanup() {
  local rc=$?
  if [[ "$KEEP_BIN" -ne 1 ]]; then
    if [[ -n "$BIN_BACKUP" ]]; then cp "$BIN_BACKUP" "$BIN"; else rm -f "$BIN"; fi
  fi
  [[ -n "$BIN_BACKUP" ]] && rm -f "$BIN_BACKUP"
  exit "$rc"
}
trap cleanup EXIT

START=$SECONDS
START_NS="$(date +%s%N)"

echo '=== 0. BUILD / UNIT TEST ==='
(
  cd "$RUST_ROOT"
  cargo test --bin opencode-patch-executor
  cargo build --release --bin opencode-patch-executor
)
install -m 0755 "$BIN_SRC" "$BIN"
cmp -s "$BIN_SRC" "$BIN" || { echo 'STOP: installed executor mismatch'; exit 1; }

echo
echo '=== 1-7. SHADOW EXECUTOR CONTRACT ==='
set +e
python3 - "$BIN" "$SOURCE" "$RESULT" "$START_NS" <<'PY'
import hashlib
import json
import pathlib
import subprocess
import sys
import tempfile
import time

BIN=pathlib.Path(sys.argv[1])
SOURCE=pathlib.Path(sys.argv[2])
RESULT=pathlib.Path(sys.argv[3])
started=time.perf_counter()
harness_started_ns=int(sys.argv[4])
passes=0
fails=0
elapsed=[]
records={}

def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()

def snapshot(root):
    out={}
    for p in sorted(root.rglob('*')):
        if p.is_file() and '.opencode' not in p.parts:
            out[p.relative_to(root).as_posix()]=sha(p)
    return out

def write_handoff(root, files, status='ready', partial=None, blocking=None):
    d=root/'.opencode'/'scout-handoffs'
    d.mkdir(parents=True, exist_ok=True)
    body={
        'protocol':'scout-handoff-v1',
        'search_protocol':'search-v2.13.6-scout-handoff',
        'status':status,
        'blocking_reasons':blocking or [],
        'partial_reasons':partial or [],
        'files':[],
    }
    for rel, lines in files:
        p=root/rel
        body['files'].append({
            'file':rel,
            'origins':['lexical'],
            'queries':[0],
            'evidence_lines':lines,
            'evidence_lines_truncated':False,
            'fingerprint':{
                'kind':'sha256',
                'strong':True,
                'sha256':sha(p),
                'evidence_fresh':True,
                'witnesses_checked':len(lines),
                'size':p.stat().st_size,
                'mtime_ms':int(p.stat().st_mtime*1000),
            },
            'changed_during_scout':False,
            'impact':[],
        })
    path=d/'fixture.json'
    path.write_text(json.dumps(body, indent=2)+'\n', encoding='utf-8')
    return path.relative_to(root).as_posix()

def run(root, handoff, edits):
    payload={'root':str(root),'handoff':handoff,'mode':'shadow','edit_protocol':'edit-script-v1','edits':edits}
    p=subprocess.run([str(BIN)], input=json.dumps(payload).encode(), stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if p.returncode != 0:
        raise AssertionError(f'executor rc={p.returncode}: {p.stderr.decode(errors="replace")}')
    row=json.loads(p.stdout)
    assert row['protocol']=='patch-executor-v1', row
    assert row['mode']=='shadow' and row['edit_protocol']=='edit-script-v1', row
    assert row['repo_mutated'] is False, row
    elapsed.append(float(row.get('elapsed_ms') or 0))
    return row

def case(name, fn):
    global passes, fails
    print(f'\n--- {name} ---')
    try:
        row=fn()
        records[name]=row
        print(json.dumps(row, indent=2, ensure_ascii=False))
        passes += 1
        print(f'VERDICT: PASS — {name}')
    except Exception as exc:
        fails += 1
        print(f'VERDICT: FAIL — {name}: {exc}')


def case_ready():
    with tempfile.TemporaryDirectory() as td:
        root=pathlib.Path(td)
        f=root/'single.py'
        f.write_text('def calculate():\n    value = 1\n    return value\n', encoding='utf-8')
        handoff=write_handoff(root,[('single.py',[3])])
        before=snapshot(root)
        row=run(root,handoff,[{'file':'single.py','kind':'replace_exact','before':'return value','after':'return value + 1'}])
        after=snapshot(root)
        assert row['admitted'] is True and row['reason'] is None, row
        assert row['git_apply_check'] is True and row['syntax_checked_files']==['single.py'], row
        assert row['changed_files']==['single.py'] and row['edits_accepted']==1, row
        assert 'return value + 1' in row['patch'] and row['patch_bytes'] > 0, row
        assert before==after, (before,after)
        return {'admitted':row['admitted'],'patch_bytes':row['patch_bytes'],'git_apply_check':row['git_apply_check'],'repo_unchanged':before==after,'elapsed_ms':row['elapsed_ms']}


def case_partial():
    with tempfile.TemporaryDirectory() as td:
        root=pathlib.Path(td); f=root/'single.py'
        f.write_text('def calculate():\n    return 1\n', encoding='utf-8')
        handoff=write_handoff(root,[('single.py',[2])],status='partial',partial=['evidence_incomplete'])
        row=run(root,handoff,[{'file':'single.py','kind':'replace_exact','before':'return 1','after':'return 2'}])
        assert row['admitted'] is False and row['reason']=='handoff_not_ready', row
        return {'admitted':False,'reason':row['reason'],'partial_reasons':row['partial_reasons']}


def case_stale():
    with tempfile.TemporaryDirectory() as td:
        root=pathlib.Path(td); f=root/'single.py'
        f.write_text('def calculate():\n    return 1\n', encoding='utf-8')
        handoff=write_handoff(root,[('single.py',[2])])
        f.write_text('def calculate():\n    return 9\n', encoding='utf-8')
        before=sha(f)
        row=run(root,handoff,[{'file':'single.py','kind':'replace_exact','before':'return 9','after':'return 10'}])
        assert row['admitted'] is False and row['reason']=='stale_fingerprint', row
        assert sha(f)==before
        return {'admitted':False,'reason':row['reason'],'executor_mutated':sha(f)!=before}


def case_scope():
    with tempfile.TemporaryDirectory() as td:
        root=pathlib.Path(td)
        (root/'a.py').write_text('def a():\n    return 1\n', encoding='utf-8')
        (root/'b.py').write_text('def b():\n    return 2\n', encoding='utf-8')
        handoff=write_handoff(root,[('a.py',[2])])
        row=run(root,handoff,[{'file':'b.py','kind':'replace_exact','before':'return 2','after':'return 3'}])
        assert row['admitted'] is False and row['reason']=='file_outside_handoff', row
        return {'admitted':False,'reason':row['reason'],'allowed_files':row['allowed_files']}


def case_ambiguous():
    with tempfile.TemporaryDirectory() as td:
        root=pathlib.Path(td); f=root/'many.py'
        f.write_text('def a():\n    return 1\n\ndef b():\n    return 1\n', encoding='utf-8')
        handoff=write_handoff(root,[('many.py',[2,5])])
        row=run(root,handoff,[{'file':'many.py','kind':'replace_exact','before':'return 1','after':'return 2'}])
        assert row['admitted'] is False and row['reason']=='precondition_not_unique', row
        return {'admitted':False,'reason':row['reason']}


def case_syntax():
    with tempfile.TemporaryDirectory() as td:
        root=pathlib.Path(td); f=root/'single.py'
        f.write_text('def calculate():\n    value = 1\n    return value\n', encoding='utf-8')
        handoff=write_handoff(root,[('single.py',[3])])
        before=sha(f)
        row=run(root,handoff,[{'file':'single.py','kind':'replace_exact','before':'return value','after':'return ('}])
        assert row['admitted'] is False and row['reason']=='candidate_syntax_invalid', row
        assert sha(f)==before
        return {'admitted':False,'reason':row['reason'],'source_unchanged':sha(f)==before}


def case_locality():
    with tempfile.TemporaryDirectory() as td:
        root=pathlib.Path(td); f=root/'far.py'
        lines=['anchor = 0'] + [f'v{i} = {i}' for i in range(2,130)] + ['target = 130']
        f.write_text('\n'.join(lines)+'\n', encoding='utf-8')
        handoff=write_handoff(root,[('far.py',[1])])
        row=run(root,handoff,[{'file':'far.py','kind':'replace_exact','before':'target = 130','after':'target = 131'}])
        assert row['admitted'] is False and row['reason']=='edit_outside_evidence_radius', row
        return {'admitted':False,'reason':row['reason'],'radius_limit_lines':96}

case('ready_shadow_patch', case_ready)
case('partial_handoff_rejected', case_partial)
case('stale_fingerprint_rejected', case_stale)
case('scope_escape_rejected', case_scope)
case('ambiguous_precondition_rejected', case_ambiguous)
case('syntax_break_rejected', case_syntax)
case('far_edit_rejected', case_locality)

record={
    'version':'v2.14-A',
    'protocol':'patch-executor-v1',
    'mode':'shadow',
    'verdict':'PASS' if fails==0 and passes==7 else 'FAIL',
    'pass':passes,
    'fail':fails,
    'total_wall_s':round((time.time_ns()-harness_started_ns)/1_000_000_000,3),
    'source_sha256':hashlib.sha256(SOURCE.read_bytes()).hexdigest(),
    'wins':{
        'ready_handoff_to_patch': records.get('ready_shadow_patch',{}).get('admitted') is True,
        'repo_byte_identity_preserved': records.get('ready_shadow_patch',{}).get('repo_unchanged') is True,
        'git_apply_check': records.get('ready_shadow_patch',{}).get('git_apply_check') is True,
        'partial_handoff_rejected': records.get('partial_handoff_rejected',{}).get('reason')=='handoff_not_ready',
        'stale_fingerprint_rejected': records.get('stale_fingerprint_rejected',{}).get('reason')=='stale_fingerprint',
        'scope_escape_rejected': records.get('scope_escape_rejected',{}).get('reason')=='file_outside_handoff',
        'ambiguous_precondition_rejected': records.get('ambiguous_precondition_rejected',{}).get('reason')=='precondition_not_unique',
        'syntax_break_rejected': records.get('syntax_break_rejected',{}).get('reason')=='candidate_syntax_invalid',
        'far_edit_rejected': records.get('far_edit_rejected',{}).get('reason')=='edit_outside_evidence_radius',
        'max_executor_elapsed_ms': round(max(elapsed or [0]),2),
    }
}
RESULT.parent.mkdir(parents=True,exist_ok=True)
RESULT.write_text(json.dumps(record,indent=2,ensure_ascii=False)+'\n',encoding='utf-8')
print('\n=== SUMMARY ===')
print(json.dumps(record,indent=2,ensure_ascii=False))
sys.exit(0 if record['verdict']=='PASS' else 1)
PY
RC=$?
set -e

TOTAL=$((SECONDS-START))
echo
echo '================================'
if [[ "$RC" -eq 0 ]]; then
  echo 'V2.14-A SHADOW EXECUTOR: PASS'
  KEEP_BIN=1
else
  echo 'V2.14-A SHADOW EXECUTOR: FAIL'
fi
echo '================================'
echo "TOTAL_WALL=${TOTAL}s"
echo "BENCHMARK_RECORD=$RESULT"

exit "$RC"
