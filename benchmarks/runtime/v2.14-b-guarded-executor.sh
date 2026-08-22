#!/usr/bin/env bash
set -Eeuo pipefail

REPO="${REPO:-$HOME/src/opencode-low_cpu-agent}"
RUST_ROOT="$REPO/rust/evidence-distiller"
SOURCE="$RUST_ROOT/src/patch_executor.rs"
BIN_SRC="$RUST_ROOT/target/release/opencode-patch-executor"
BIN_DIR="$HOME/.local/libexec/opencode-cpu-agent"
BIN="$BIN_DIR/opencode-patch-executor"
RESULT="$REPO/benchmarks/results/v2.14-b-guarded-executor-latest.json"

command -v cargo >/dev/null 2>&1 || { echo 'STOP: cargo required' >&2; exit 1; }
command -v python3 >/dev/null 2>&1 || { echo 'STOP: python3 required' >&2; exit 1; }
command -v git >/dev/null 2>&1 || { echo 'STOP: git required' >&2; exit 1; }
command -v sha256sum >/dev/null 2>&1 || { echo 'STOP: sha256sum required' >&2; exit 1; }
[[ -f "$SOURCE" ]] || { echo "STOP: missing $SOURCE" >&2; exit 1; }
grep -q 'const PROTOCOL: &str = "patch-executor-v2"' "$SOURCE" || {
  echo 'STOP: source is not v2.14-B guarded executor' >&2
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
echo '=== 1-9. GUARDED EXECUTOR CONTRACT ==='
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
HARNESS_STARTED_NS=int(sys.argv[4])
passes=0
fails=0
records={}
elapsed=[]


def sh(root, *args, check=True):
    p=subprocess.run(args, cwd=root, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    if check and p.returncode != 0:
        raise AssertionError(f"command failed {args}: {p.stderr}")
    return p


def init_repo(root, files):
    sh(root, 'git', 'init', '-q')
    sh(root, 'git', 'config', 'user.email', 'executor@test.local')
    sh(root, 'git', 'config', 'user.name', 'Executor Test')
    for rel, text in files.items():
        p=root/rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(text, encoding='utf-8')
    sh(root, 'git', 'add', '--', *files.keys())
    sh(root, 'git', 'commit', '-qm', 'baseline')


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def worktree_count(root):
    p=sh(root, 'git', 'worktree', 'list', '--porcelain')
    return sum(1 for line in p.stdout.splitlines() if line.startswith('worktree '))


def write_handoff(root, files, status='ready', partial=None, blocking=None):
    body={
        'protocol':'scout-handoff-v1',
        'search_protocol':'search-v2.13.6-scout-handoff',
        'status':status,
        'blocking_reasons':blocking or [],
        'partial_reasons':partial or [],
        'files':[],
    }
    for rel, evidence in files:
        p=root/rel
        body['files'].append({
            'file':rel,
            'origins':['lexical'],
            'query_indices':[0],
            'evidence_lines':evidence,
            'fingerprint':{
                'kind':'sha256',
                'strong':True,
                'sha256':sha(p),
                'evidence_fresh':True,
                'witnesses_checked':1,
                'lines':len(p.read_text(encoding='utf-8').splitlines()),
                'size':p.stat().st_size,
                'mtime_ms':int(p.stat().st_mtime*1000),
            },
            'changed_during_scout':False,
            'impact':[],
        })
    d=root/'.opencode'/'scout-handoffs'
    d.mkdir(parents=True, exist_ok=True)
    path=d/'fixture.json'
    path.write_text(json.dumps(body, indent=2)+'\n', encoding='utf-8')
    return path.relative_to(root).as_posix()


def run(root, handoff, edits, checks=None):
    before_count=worktree_count(root)
    payload={
        'root':str(root),
        'handoff':handoff,
        'mode':'guarded',
        'edit_protocol':'edit-script-v2',
        'edits':edits,
        'checks':checks or [],
    }
    p=subprocess.run([str(BIN)], input=json.dumps(payload).encode(), stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if p.returncode != 0:
        raise AssertionError(f'executor rc={p.returncode}: {p.stderr.decode(errors="replace")}')
    row=json.loads(p.stdout)
    after_count=worktree_count(root)
    assert row['protocol']=='patch-executor-v2', row
    assert row['mode']=='guarded' and row['edit_protocol']=='edit-script-v2', row
    assert after_count == before_count == 1, (before_count, after_count, row)
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


def case_guarded_exact():
    with tempfile.TemporaryDirectory() as td:
        root=pathlib.Path(td)
        init_repo(root, {'single.py':'def calculate():\n    value = 1\n    return value\n'})
        handoff=write_handoff(root,[('single.py',[3])])
        before=sha(root/'single.py')
        row=run(
            root,handoff,
            [{'file':'single.py','kind':'replace_exact','before':'return value','after':'return value + 1'}],
            [{'file':'single.py','kind':'contains_exact','value':'return value + 1'}],
        )
        assert row['admitted'] is True and row['reason'] is None, row
        assert row['worktree_used'] is True and row['worktree_cleaned'] is True, row
        assert row['git_diff_check'] is True and row['git_apply_check'] is True, row
        assert row['structural_edits']==0 and row['postconditions_checked']==1, row
        assert row['changed_files']==['single.py'] and 0 < row['changed_lines'] <= 120, row
        assert 'return value + 1' in row['patch'] and row['patch_bytes'] > 0, row
        assert sha(root/'single.py')==before and row['repo_mutated'] is False, row
        return {'admitted':True,'worktree_cleaned':True,'changed_lines':row['changed_lines'],'repo_unchanged':sha(root/'single.py')==before,'elapsed_ms':row['elapsed_ms']}


def case_structural():
    with tempfile.TemporaryDirectory() as td:
        root=pathlib.Path(td)
        init_repo(root, {'calc.py':'def calculate():\n    return add(1,  2)\n'})
        handoff=write_handoff(root,[('calc.py',[2])])
        before=sha(root/'calc.py')
        assert 'add(1, 2)' not in (root/'calc.py').read_text(encoding='utf-8')
        row=run(
            root,handoff,
            [{'file':'calc.py','kind':'replace_ast','before':'add(1, 2)','after':'add(1, 3)'}],
            [{'file':'calc.py','kind':'contains_exact','value':'add(1, 3)'}],
        )
        assert row['admitted'] is True and row['structural_edits']==1, row
        assert '-    return add(1,  2)' in row['patch'] and '+    return add(1, 3)' in row['patch'], row
        assert sha(root/'calc.py')==before
        return {'admitted':True,'structural_edits':1,'matched_despite_trivia':True,'repo_unchanged':True,'elapsed_ms':row['elapsed_ms']}


def case_partial():
    with tempfile.TemporaryDirectory() as td:
        root=pathlib.Path(td)
        init_repo(root, {'single.py':'def calculate():\n    return 1\n'})
        handoff=write_handoff(root,[('single.py',[2])],status='partial',partial=['evidence_incomplete'])
        row=run(root,handoff,[{'file':'single.py','kind':'replace_exact','before':'return 1','after':'return 2'}])
        assert row['admitted'] is False and row['reason']=='handoff_not_ready', row
        assert row['worktree_used'] is False
        return {'admitted':False,'reason':row['reason'],'worktree_used':False}


def case_stale():
    with tempfile.TemporaryDirectory() as td:
        root=pathlib.Path(td)
        init_repo(root, {'single.py':'def calculate():\n    return 1\n'})
        handoff=write_handoff(root,[('single.py',[2])])
        (root/'single.py').write_text('def calculate():\n    return 9\n', encoding='utf-8')
        before=sha(root/'single.py')
        row=run(root,handoff,[{'file':'single.py','kind':'replace_exact','before':'return 9','after':'return 10'}])
        assert row['admitted'] is False and row['reason']=='stale_fingerprint', row
        assert row['worktree_used'] is False and sha(root/'single.py')==before
        return {'admitted':False,'reason':row['reason'],'worktree_used':False}


def case_scope():
    with tempfile.TemporaryDirectory() as td:
        root=pathlib.Path(td)
        init_repo(root, {
            'a.py':'def a():\n    return 1\n',
            'b.py':'def b():\n    return 2\n',
        })
        handoff=write_handoff(root,[('a.py',[2])])
        row=run(root,handoff,[{'file':'b.py','kind':'replace_exact','before':'return 2','after':'return 3'}])
        assert row['admitted'] is False and row['reason']=='file_outside_handoff', row
        return {'admitted':False,'reason':row['reason'],'allowed_files':row['allowed_files']}


def case_head_mismatch():
    with tempfile.TemporaryDirectory() as td:
        root=pathlib.Path(td)
        init_repo(root, {'single.py':'def calculate():\n    return 1\n'})
        (root/'single.py').write_text('def calculate():\n    return 9\n', encoding='utf-8')
        handoff=write_handoff(root,[('single.py',[2])])
        before=sha(root/'single.py')
        row=run(root,handoff,[{'file':'single.py','kind':'replace_exact','before':'return 9','after':'return 10'}])
        assert row['admitted'] is False and row['reason']=='worktree_baseline_mismatch', row
        assert row['worktree_used'] is True and row['worktree_cleaned'] is True, row
        assert sha(root/'single.py')==before
        return {'admitted':False,'reason':row['reason'],'worktree_cleaned':row['worktree_cleaned'],'repo_unchanged':True}


def case_syntax_rollback():
    with tempfile.TemporaryDirectory() as td:
        root=pathlib.Path(td)
        init_repo(root, {'single.py':'def calculate():\n    value = 1\n    return value\n'})
        handoff=write_handoff(root,[('single.py',[3])])
        before=sha(root/'single.py')
        row=run(root,handoff,[{'file':'single.py','kind':'replace_exact','before':'return value','after':'return ('}])
        assert row['admitted'] is False and row['reason']=='candidate_syntax_invalid', row
        assert row['worktree_used'] is True and row['worktree_cleaned'] is True, row
        assert row['patch'] is None and sha(root/'single.py')==before
        return {'admitted':False,'reason':row['reason'],'worktree_cleaned':True,'patch_exported':False,'repo_unchanged':True}


def case_postcondition_rollback():
    with tempfile.TemporaryDirectory() as td:
        root=pathlib.Path(td)
        init_repo(root, {'single.py':'def calculate():\n    return 1\n'})
        handoff=write_handoff(root,[('single.py',[2])])
        before=sha(root/'single.py')
        row=run(
            root,handoff,
            [{'file':'single.py','kind':'replace_exact','before':'return 1','after':'return 2'}],
            [{'file':'single.py','kind':'contains_exact','value':'return 999'}],
        )
        assert row['admitted'] is False and row['reason']=='postcondition_failed', row
        assert row['worktree_used'] is True and row['worktree_cleaned'] is True, row
        assert row['patch'] is None and sha(root/'single.py')==before
        return {'admitted':False,'reason':row['reason'],'worktree_cleaned':True,'repo_unchanged':True}


def case_line_budget():
    with tempfile.TemporaryDirectory() as td:
        root=pathlib.Path(td)
        old_items=''.join(f'        {i},\n' for i in range(70))
        new_items=''.join(f'        {i+1000},\n' for i in range(70))
        before_block='    return [\n'+old_items+'    ]'
        after_block='    return [\n'+new_items+'    ]'
        source='def values():\n'+before_block+'\n'
        init_repo(root, {'many.py':source})
        handoff=write_handoff(root,[('many.py',[2])])
        before=sha(root/'many.py')
        row=run(root,handoff,[{'file':'many.py','kind':'replace_exact','before':before_block,'after':after_block}])
        assert row['admitted'] is False and row['reason']=='changed_line_budget_exceeded', row
        assert row['worktree_used'] is True and row['worktree_cleaned'] is True, row
        assert row['patch'] is None and sha(root/'many.py')==before
        return {'admitted':False,'reason':row['reason'],'limit':120,'worktree_cleaned':True,'repo_unchanged':True}


case('guarded_exact_patch', case_guarded_exact)
case('structural_ast_patch', case_structural)
case('partial_handoff_rejected', case_partial)
case('stale_fingerprint_rejected', case_stale)
case('scope_escape_rejected', case_scope)
case('head_baseline_mismatch_rejected', case_head_mismatch)
case('syntax_failure_rolls_back', case_syntax_rollback)
case('postcondition_failure_rolls_back', case_postcondition_rollback)
case('changed_line_budget_rejected', case_line_budget)

record={
    'version':'v2.14-B',
    'protocol':'patch-executor-v2',
    'mode':'guarded',
    'edit_protocol':'edit-script-v2',
    'verdict':'PASS' if fails==0 and passes==9 else 'FAIL',
    'pass':passes,
    'fail':fails,
    'total_wall_s':round((time.time_ns()-HARNESS_STARTED_NS)/1_000_000_000,3),
    'source_sha256':hashlib.sha256(SOURCE.read_bytes()).hexdigest(),
    'wins':{
        'detached_worktree_mutation': records.get('guarded_exact_patch',{}).get('worktree_cleaned') is True,
        'main_worktree_unchanged': records.get('guarded_exact_patch',{}).get('repo_unchanged') is True,
        'structural_ast_edit': records.get('structural_ast_patch',{}).get('matched_despite_trivia') is True,
        'partial_handoff_rejected': records.get('partial_handoff_rejected',{}).get('reason')=='handoff_not_ready',
        'stale_fingerprint_rejected': records.get('stale_fingerprint_rejected',{}).get('reason')=='stale_fingerprint',
        'scope_escape_rejected': records.get('scope_escape_rejected',{}).get('reason')=='file_outside_handoff',
        'head_baseline_mismatch_rejected': records.get('head_baseline_mismatch_rejected',{}).get('reason')=='worktree_baseline_mismatch',
        'syntax_failure_rollback': records.get('syntax_failure_rolls_back',{}).get('repo_unchanged') is True,
        'postcondition_failure_rollback': records.get('postcondition_failure_rolls_back',{}).get('repo_unchanged') is True,
        'changed_line_budget_rejected': records.get('changed_line_budget_rejected',{}).get('reason')=='changed_line_budget_exceeded',
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
  echo 'V2.14-B GUARDED EXECUTOR: PASS'
  KEEP_BIN=1
else
  echo 'V2.14-B GUARDED EXECUTOR: FAIL'
fi
echo '================================'
echo "TOTAL_WALL=${TOTAL}s"
echo "BENCHMARK_RECORD=$RESULT"

exit "$RC"
