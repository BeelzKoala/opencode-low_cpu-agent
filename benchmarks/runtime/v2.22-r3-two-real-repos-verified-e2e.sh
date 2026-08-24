#!/usr/bin/env bash
set -Eeuo pipefail

REPO="${REPO:-$HOME/src/opencode-low_cpu-agent}"
OPENCODE="${OPENCODE:-$HOME/.opencode/bin/opencode2}"
SOURCE_PLUGIN="$REPO/opencode/plugins/cpu-search.ts"
RUNTIME_PLUGIN="$HOME/.config/opencode/plugins/cpu-search.ts"
EXPECTED_PLUGIN_SHA="5dc24be05ff469c7a401e8037d809996d94a93fd5ce310fce721a04e52e5857c"
DJANGO="${DJANGO_REPO:-$HOME/projects/bench-repos/django}"
TYPESCRIPT="${TYPESCRIPT_REPO:-$HOME/projects/bench-repos/typescript}"
STAMP="$(date +%Y%m%d-%H%M%S)"
OUT="${OUT:-/tmp/user/Downloads/v2.22-r3-two-real-repos-$STAMP}"
RESULT="$OUT/summary.json"
mkdir -p "$OUT"

sha(){ sha256sum "$1" | awk '{print $1}'; }

echo '=== 0. V2.22 RUNTIME PRECONDITIONS ==='
for c in git python3 sha256sum curl; do command -v "$c" >/dev/null || { echo "STOP missing $c" >&2; exit 2; }; done
[[ -x "$OPENCODE" ]] || { echo "STOP missing $OPENCODE" >&2; exit 2; }
[[ -f "$SOURCE_PLUGIN" && -f "$RUNTIME_PLUGIN" ]] || { echo 'STOP plugin missing' >&2; exit 2; }
[[ "$(sha "$SOURCE_PLUGIN")" == "$EXPECTED_PLUGIN_SHA" ]] || { echo 'STOP source plugin != exact v2.22' >&2; exit 2; }
[[ "$(sha "$RUNTIME_PLUGIN")" == "$EXPECTED_PLUGIN_SHA" ]] || { echo 'STOP runtime plugin != exact v2.22' >&2; exit 2; }
cmp -s "$SOURCE_PLUGIN" "$RUNTIME_PLUGIN" || { echo 'STOP source/runtime bytes differ' >&2; exit 2; }
curl -fsS --max-time 2 http://127.0.0.1:8080/health >/dev/null || { echo 'STOP llama health failed' >&2; exit 2; }
echo 'PASS exact v2.22 source/runtime identity'
echo 'PASS llama health'

echo
echo '=== 1. TWO REAL REPOS / DETERMINISTIC PREFLIGHT ==='
python3 - "$DJANGO" "$TYPESCRIPT" <<'PY'
import pathlib,re,subprocess,sys
cases=[
 ('django',pathlib.Path(sys.argv[1]),'django/apps/config.py','_path_from_module',2),
 ('typescript',pathlib.Path(sys.argv[2]),'packages/typescript/src/api/fs.ts','getNodeFromPath',4),
]
for name,root,rel,sym,want in cases:
 root=root.expanduser().resolve(); target=root/rel
 assert target.is_file(),target
 text=target.read_text(encoding='utf-8',errors='replace')
 pat=re.compile(r'(?<![A-Za-z0-9_$])'+re.escape(sym)+r'(?![A-Za-z0-9_$])')
 got=len(pat.findall(text)); assert got==want,(name,got,want)
 p=subprocess.run(['git','grep','-l','-w','--',sym,'--','.'],cwd=root,text=True,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
 assert p.returncode in (0,1),(name,p.returncode,p.stderr)
 suffix=('.py','.pyi','.ts','.tsx','.js','.jsx','.mjs','.cjs')
 files=sorted(x.strip().removeprefix('./') for x in p.stdout.splitlines() if x.strip().endswith(suffix))
 assert files==[rel],(name,files)
 print(f'PASS {name} target={rel} exact_identifier_count={got}')
PY

echo
echo '=== 2. V2.22 RENAME TARGET CAPABILITY — TWO REAL REPOS ==='
echo "OUT=$OUT"
set +e
python3 - "$OPENCODE" "$DJANGO" "$TYPESCRIPT" "$RESULT" "$EXPECTED_PLUGIN_SHA" <<'PY'
from __future__ import annotations
import hashlib,json,os,pathlib,re,shutil,subprocess,sys,tempfile,time

OC=pathlib.Path(sys.argv[1]).expanduser().resolve()
RESULT=pathlib.Path(sys.argv[4]); PLUGIN_SHA=sys.argv[5]
CASES=[
 dict(name='django',repo=pathlib.Path(sys.argv[2]).expanduser().resolve(),file='django/apps/config.py',symbol='_path_from_module',new='_path_from_module_v222_probe',glob='**/*.py',count=2),
 dict(name='typescript',repo=pathlib.Path(sys.argv[3]).expanduser().resolve(),file='packages/typescript/src/api/fs.ts',symbol='getNodeFromPath',new='getNodeFromPathV222Probe',glob='**/*.ts',count=4),
]

def run(argv,cwd,timeout=30,env=None):
 return subprocess.run([str(x) for x in argv],cwd=cwd,env=env,text=True,errors='replace',stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=timeout,check=False)
def git(root,*args,timeout=30): return run(['git',*args],root,timeout=timeout)
def must(root,*args):
 p=git(root,*args)
 if p.returncode: raise AssertionError(f"git {' '.join(args)} rc={p.returncode}: {p.stderr[-1200:]}")
 return p.stdout
def H(s): return hashlib.sha256(s.encode('utf-8','replace')).hexdigest()
def state(root):
 return dict(head=must(root,'rev-parse','HEAD').strip(),status=H(must(root,'status','--porcelain=v1','-z','--untracked-files=no')),unstaged=H(must(root,'diff','--binary','--no-ext-diff')),staged=H(must(root,'diff','--cached','--binary','--no-ext-diff')))
def add_wt(base,prefix):
 parent=pathlib.Path(tempfile.mkdtemp(prefix=prefix)); wt=parent/'tree'
 p=git(base,'worktree','add','--detach','--quiet',str(wt),'HEAD',timeout=60)
 if p.returncode: shutil.rmtree(parent,ignore_errors=True); raise AssertionError(p.stderr[-1200:])
 return parent,wt
def rm_wt(base,parent,wt):
 subprocess.run(['git','worktree','remove','--force',str(wt)],cwd=base,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
 subprocess.run(['git','worktree','prune'],cwd=base,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
 shutil.rmtree(parent,ignore_errors=True)
def jsonl(path):
 out=[]
 if not path.exists(): return out
 for line in path.read_text(encoding='utf-8',errors='replace').splitlines():
  try: x=json.loads(line)
  except Exception: continue
  if isinstance(x,dict): out.append(x)
 return out
def events(stdout):
 out=[]
 for line in stdout.splitlines():
  try: x=json.loads(line)
  except Exception: continue
  if x.get('type')!='tool_use': continue
  part=x.get('part') or {}; st=part.get('state') or x.get('state') or {}
  meta=st.get('metadata') or part.get('metadata') or x.get('metadata') or {}
  out.append(dict(tool=part.get('tool') or x.get('tool'),input=st.get('input'),output=st.get('output'),metadata=meta if isinstance(meta,dict) else {}))
 return out
def run_agent(root,prompt):
 env=os.environ.copy(); env['PWD']=str(root)
 try:
  p=subprocess.run([str(OC),'run','--format','json',prompt],cwd=root,env=env,text=True,errors='replace',stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=210,check=False)
  return p.returncode,p.stdout,p.stderr,False
 except subprocess.TimeoutExpired as e:
  o=e.stdout or ''; er=e.stderr or ''
  if isinstance(o,bytes): o=o.decode('utf-8','replace')
  if isinstance(er,bytes): er=er.decode('utf-8','replace')
  return 124,o,er,True
def flat(x,p=''):
 out=[]
 if isinstance(x,dict):
  for k,v in x.items():
   q=f'{p}.{k}' if p else str(k); out.append((q,v)); out.extend(flat(v,q))
 elif isinstance(x,list):
  for i,v in enumerate(x): out.extend(flat(v,f'{p}[{i}]'))
 return out
def rename_meta(meta,sym,target):
 rows={k:v for k,v in flat(meta) if 'rename' in k.lower()}; blob=json.dumps(rows,ensure_ascii=False,sort_keys=True)
 return dict(rows=rows,has=bool(rows),symbol=sym in blob,target=(target in blob or './'+target in blob))
def receipt(root):
 d=root/'.opencode'/'patches'
 if not d.exists(): return None
 for p in sorted(d.glob('*.json')):
  try: x=json.loads(p.read_text(encoding='utf-8'))
  except Exception: continue
  if x.get('protocol')=='patch-receipt-v1': return x
 return None
def ident(text,sym): return len(re.findall(r'(?<![A-Za-z0-9_$])'+re.escape(sym)+r'(?![A-Za-z0-9_$])',text))
def accept(run_wt,c,r):
   rel=r.get('patch_path')
   assert isinstance(rel,str) and rel

   patch=run_wt/rel
   assert patch.is_file(),patch

   parent,wt=add_wt(c['repo'],f"v222-{c['name']}-verify-")
   try:
    target=wt/c['file']
    before_bytes=target.read_bytes()

    # Determine EOL contract from the actual detached baseline.
    lf_positions=[i for i,b in enumerate(before_bytes) if b==10]
    consistent_crlf=bool(lf_positions) and all(
     i>0 and before_bytes[i-1]==13
     for i in lf_positions
    )

    # Keep git whitespace verification strict. Only teach git that CR at EOL
    # is intentional when the baseline itself proves consistent CRLF.
    ws_prefix=[]
    if consistent_crlf:
     cfg=git(wt,'config','--get','core.whitespace')
     raw=cfg.stdout.strip() if cfg.returncode==0 else ''

     parts=[
      x for x in raw.split(',')
      if x and x not in ('cr-at-eol','-cr-at-eol')
     ]
     parts.append('cr-at-eol')

     ws_prefix=['-c','core.whitespace='+','.join(parts)]

    cp=parent/'candidate.diff'
    shutil.copy2(patch,cp)

    # Independent applicability gate.
    p=git(
     wt,
     *ws_prefix,
     'apply',
     '--whitespace=error-all',
     str(cp),
    )
    assert p.returncode==0,p.stderr[-1500:]

    changed=sorted(
     x
     for x in must(wt,'diff','--name-only').splitlines()
     if x
    )
    assert changed==[c['file']],changed

    after_bytes=target.read_bytes()

    old_b=c['symbol'].encode('utf-8')
    new_b=c['new'].encode('utf-8')

    pat_b=re.compile(
     rb'(?<![A-Za-z0-9_$])'
     + re.escape(old_b)
     + rb'(?![A-Za-z0-9_$])'
    )

    expected_bytes,replaced=pat_b.subn(
     new_b,
     before_bytes,
    )

    assert replaced==c['count'],(
     'unexpected baseline identifier count',
     replaced,
     c['count'],
    )

    # Strong independent oracle:
    # no byte may change except the intended identifier occurrences.
    assert after_bytes==expected_bytes,\
     'not a pure exact byte-preserving rename'

    after=after_bytes.decode('utf-8','strict')

    assert ident(after,c['symbol'])==0
    assert ident(after,c['new'])==c['count']

    # Independent whitespace gate after application.
    p=git(
     wt,
     *ws_prefix,
     'diff',
     '--check',
    )
    assert p.returncode==0,p.stdout+p.stderr

    if c['name']=='django':
     compile(after,str(target),'exec')

    return dict(
     pass_=True,
     changed_files=changed,
     pure_exact_rename=True,
     byte_exact=True,
     baseline_crlf=consistent_crlf,
     new_identifier_count=c['count'],
    )
   finally:
    rm_wt(c['repo'],parent,wt)

def outcome(text):
 t=str(text or '')
 for key,val in [('PATCH_READY','ready'),('PATCH_RETRY','retry'),('PATCH_RESCOUT','rescout'),('PATCH_STOP','stop')]:
  if key in t:return val
 return 'unknown'

def one(c):
 base=c['repo']; before_state=state(base); parent,wt=add_wt(base,f"v222-{c['name']}-run-"); started=time.monotonic()
 try:
  shutil.rmtree(wt/'.opencode',ignore_errors=True)
  prompt=(f"Rename-only task. Use search exactly once with {{\"queries\":[\"{c['symbol']}\"],\"glob\":\"{c['glob']}\"}}. Do not search again. "
          f"Rename the uniquely defined symbol `{c['symbol']}` to `{c['new']}` and update only proven references. Do not use execute_replace_node. "
          f"If execute_rename_symbol is exposed, call it exactly once with only {{\"new_name\":\"{c['new']}\"}}. If authority or downstream rename is unsupported, stop safely.")
  rc,stdout,stderr,timed=run_agent(wt,prompt); ev=events(stdout)
  searches=[e for e in ev if e['tool']=='search']; renames=[e for e in ev if e['tool']=='execute_rename_symbol']; replaces=[e for e in ev if e['tool']=='execute_replace_node']
  assert len(searches)==1,f"search calls={len(searches)}"; assert not replaces,replaces; assert len(renames)==1,f"rename calls={len(renames)}"
  assert renames[0]['input']=={'new_name':c['new']},f"ABI leak: {renames[0]['input']}"
  trace=jsonl(wt/'.opencode'/'search-trace.jsonl'); sm=dict(searches[0]['metadata']);
  if trace: sm.update(trace[-1])
  blob=json.dumps(sm,ensure_ascii=False,sort_keys=True); assert 'execute_rename_symbol' in str(searches[0]['output']) or 'execute_rename_symbol' in blob,'rename frontier absent'
  rm=rename_meta(sm,c['symbol'],c['file']); assert rm['has'] and rm['symbol'] and rm['target'],f"rename authority telemetry mismatch: {rm}"
  requested=sm.get('requested_queries') or sm.get('queries');
  if isinstance(requested,list): assert requested==[c['symbol']],requested
  o=outcome(renames[0]['output']); r=receipt(wt); acc=None
  if o=='ready': assert r is not None,'PATCH_READY without receipt'; acc=accept(wt,c,r)
  else: assert r is None,f"non-ready persisted receipt: {r}"
  after_state=state(base); assert before_state==after_state,'main checkout changed'
  safety_pass=o in {'ready','retry','rescout','stop'} and (o!='ready' or bool(acc and acc.get('pass_')))
  verified=o=='ready' and bool(acc and acc.get('pass_'))
  return dict(case=c['name'],pass_=verified,safety_pass=safety_pass,class_=('verified' if o=='ready' else 'capability_pass_safe_fail'),wall_s=round(time.monotonic()-started,3),cli_rc=rc,cli_timed_out=timed,search_calls=1,rename_calls=1,replace_calls=0,rename_input=renames[0]['input'],rename_outcome=o,rename_output=str(renames[0]['output'])[-1600:],rename_target_authority=rm,query_formulation_used=sm.get('query_formulation_used'),independent_acceptance=acc,false_verified=False,main_checkout_unchanged=True,model_dispatches=len([x for x in jsonl(wt/'.opencode'/'cpu-agent-trace.jsonl') if x.get('kind')=='model_dispatch']),stderr_tail=stderr[-1200:])
 finally:
  diag=RESULT.parent/'artifacts'/c['name']
  srcdiag=wt/'.opencode'
  if srcdiag.exists():
   shutil.copytree(srcdiag,diag,dirs_exist_ok=True)
  rm_wt(base,parent,wt)

rows=[]
for c in CASES:
 print(f"\n--- real_repo_{c['name']} ---",flush=True)
 before=state(c['repo'])
 try: r=one(c)
 except Exception as e: r=dict(case=c['name'],pass_=False,class_='failure',error=repr(e),false_verified=False,main_checkout_unchanged=(state(c['repo'])==before))
 rows.append(r); print(json.dumps(r,indent=2,ensure_ascii=False),flush=True); print(f"VERDICT: {'PASS' if r.get('pass_') else 'FAIL'} — {c['name']}",flush=True)
summary=dict(protocol='v2.22-r3-two-real-repos-verified-e2e',plugin_sha256=PLUGIN_SHA,repos_total=2,repos_passed=sum(bool(r.get('pass_')) for r in rows),false_verified_count=sum(bool(r.get('false_verified')) for r in rows),authority_failures=[r['case'] for r in rows if r.get('rename_target_authority') is not None and not ((r.get('rename_target_authority') or {}).get('has') and (r.get('rename_target_authority') or {}).get('symbol') and (r.get('rename_target_authority') or {}).get('target'))],main_checkout_mutations=[r['case'] for r in rows if r.get('main_checkout_unchanged') is False],cases=rows)
summary['verdict']='PASS' if summary['repos_passed']==2 and summary['false_verified_count']==0 and not summary['authority_failures'] and not summary['main_checkout_mutations'] else 'FAIL'
RESULT.parent.mkdir(parents=True,exist_ok=True); RESULT.write_text(json.dumps(summary,indent=2,ensure_ascii=False)+'\n',encoding='utf-8')
print('\n=== SUMMARY ==='); print(json.dumps(summary,indent=2,ensure_ascii=False)); sys.exit(0 if summary['verdict']=='PASS' else 1)
PY
RC=$?
set -e

echo
echo '=============================================='
if [[ "$RC" -eq 0 ]]; then echo 'V2.22-R3 TWO REAL REPOS VERIFIED RENAME: PASS'; else echo 'V2.22-R3 TWO REAL REPOS VERIFIED RENAME: FAIL'; fi
echo '=============================================='
echo "RESULT=$RESULT"
exit "$RC"
