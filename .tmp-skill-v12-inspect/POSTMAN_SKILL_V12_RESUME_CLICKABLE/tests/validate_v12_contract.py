#!/usr/bin/env python3
from pathlib import Path
import argparse
ap=argparse.ArgumentParser(); ap.add_argument('--repo-root',required=True); a=ap.parse_args(); r=Path(a.repo_root)
skill=(r/'.agents/skills/delegate-via-postman/SKILL.md').read_text(encoding='utf-8')
agents=(r/'AGENTS.md').read_text(encoding='utf-8')
test=(r/'postman/direct/tests/test_delegate_skill_contract.py').read_text(encoding='utf-8')
checks={
'v12':'DIRECT_POSTMAN_SKILL_VERSION: 12' in skill,
'resume-skill':'resume_request.ps1' in skill,
'resume-agents':'resume_request.ps1' in agents,
'testscript':'-TestScript' in skill,
'testspec':'-TestSpec' in skill,
'clickable':'Кликабельные изменённые файлы' in skill and 'Markdown inline code' in skill,
'agents-clickable':'Markdown inline code' in agents,
'test-contract':'test_clickable_changed_file_contract' in test,
'old-golden-removed':'→ PREPARE: один вызов prepare_result.ps1' not in skill,
'old-agents-removed':'normal production path: `prepare_result.ps1` →' not in agents,
}
for k,v in checks.items(): print(f'{k}={"PASS" if v else "FAIL"}')
bad=[k for k,v in checks.items() if not v]
if bad: raise SystemExit('CONTRACT_FAIL:'+','.join(bad))
print('POSTMAN_SKILL_V12_CONTRACT_PASS')
