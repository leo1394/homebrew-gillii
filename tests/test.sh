#!/bin/bash
set -eu
root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
scratch=$(mktemp -d "${TMPDIR:-/tmp}/gillii-test.XXXXXX")
trap 'rm -rf "$scratch"' EXIT
export PATH="$root/bin:$PATH"
export HOME="$scratch/home"
mkdir -p "$HOME"
export XDG_CACHE_HOME="$HOME/.cache"
python3 - "$root" "$scratch" <<'PYTEST'
import subprocess,sys,os,pathlib,re,json,struct,datetime
root=pathlib.Path(sys.argv[1]);scratch=pathlib.Path(sys.argv[2])
def run(*args,ok=True):
 r=subprocess.run(args,text=True,capture_output=True)
 if ok: assert r.returncode==0,(args,r.stdout,r.stderr)
 else: assert r.returncode!=0,(args,r.stdout,r.stderr)
 return r
expected='gillii version 0.1.0-dev (2026-10-02)\nhttps://github.com/leo1394/homebrew-gillii\n'
for arg in ['version','--version']:assert run('gillii',arg).stdout==expected
for cmd in ['list','clean','chase','info','setup','version','help','completion']:
 assert run('gillii','help',cmd).stdout
 assert run('gillii',cmd,'--help').stdout
for args in [('list',),('list','--'),('list','--root',str(scratch),'--')]:
 assert run('/bin/bash',str(root/'bin/gillii'),*args).stdout=='appid               modified\n'
assert 'version' in run('gillii','versoin',ok=False).stderr
assert '--output' in run('gillii','chase','--ouptut',ok=False).stderr
assert 'Did you mean' not in run('gillii','abcdefghi',ok=False).stderr
assert 'Node' in run('env','GILLII_NODE=/nonexistent','gillii','list',ok=False).stderr
assert run('env','GILLII_NODE=/nonexistent','gillii','help','chase').stdout
assert run('gillii','__complete','help','').stdout.splitlines()==['list','clean','chase','info','setup','version','help','completion']
assert run('gillii','__complete','completion','').stdout.splitlines()==['bash','zsh','fish']
assert run('gillii','__complete','chase','--input','').stdout=='@paths\n'
assert run('gillii','__complete','list','--root','').stdout=='@directories\n'
assert run('gillii','__complete','chase','--appid','').stdout==''
assert run('gillii','__complete','chase','--','').stdout==''
for shell in ['bash','zsh','fish']:assert run('gillii','completion',shell).stdout==(root/f'completions/gillii.{shell}').read_text()
cache=scratch.resolve()/'cache space';cache.mkdir()
appid='wx0123456789abcdef'
package=cache/appid/'1/__APP__.wxapkg';package.parent.mkdir(parents=True);package.write_text('fixture')
os.environ['TZ']='Asia/Shanghai'
stamp=datetime.datetime(2026,10,2,4,51,18,tzinfo=datetime.timezone.utc).timestamp();os.utime(package,(stamp,stamp))
other=cache/'wx1111111111111111/1/other.wxapkg';other.parent.mkdir(parents=True);other.write_text('fixture')
keep=package.parent/'data.db';keep.write_text('keep')
outside=scratch/'outside';outside.mkdir();external=outside/'external.wxapkg';external.write_text('keep')
(cache/'link').symlink_to(outside,target_is_directory=True)
(package.parent/'linked.wxapkg').symlink_to(external)
def clean(*args,ok=True):
 return json.loads(run('gillii','clean','--root',str(cache),*args,ok=ok).stdout)
preview=run('gillii','clean','--root',str(cache),'--dry-run').stdout
assert preview==run('gillii','list','--root',str(cache)).stdout
assert len(preview.splitlines())==3 and preview.splitlines()[0].split()==['appid','modified'] and all(re.fullmatch(r'\S+ +\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}',line) for line in preview.splitlines()[1:])
assert appid in preview and 'wx1111111111111111' in preview and str(cache) not in preview
assert package.exists() and other.exists()
unknown=cache/'unidentified.wxapkg';unknown.write_text('fixture');os.utime(unknown,(2000000000,2000000000))
listed=run('gillii','list','--root',str(cache)).stdout
assert listed.splitlines()[-1].startswith('(unknown)')
assert run('gillii','clean','--root',str(cache),'--dry-run').stdout==listed
unknown.unlink()
detail=json.loads(run('gillii','info',appid,'--root',str(cache)).stdout)
assert detail['appid']==appid and len(detail['packages'])==1
assert detail['packages'][0]['path']==str(package) and detail['packages'][0]['bytes']==7
assert detail['packages'][0]['cacheVersion']=='1'
assert detail['packages'][0]['modified']=='2026-10-02 12:51:18'
assert re.search(appid+r' +2026-10-02 12:51:18',preview)
extra=package.parent/'extra.wxapkg';extra.write_text('fixture');os.utime(extra,(package.stat().st_atime,package.stat().st_mtime))
assert run('gillii','list','--root',str(cache)).stdout==preview
assert len(json.loads(run('gillii','info',appid,'--root',str(cache)).stdout)['packages'])==2
extra.unlink()
assert 'Usage: gillii info <AppID>' in run('gillii','info',ok=False).stderr
assert 'Invalid AppID' in run('gillii','info','invalid',ok=False).stderr
assert json.loads(run('gillii','info','wx2222222222222222','--root',str(cache),ok=False).stdout)['packages']==[]
assert run('env','GILLII_NODE=/nonexistent','gillii','info','--help').stdout
assert run('gillii','__complete','info','--root','').stdout=='@directories\n'
result=clean('--appid',appid);assert result['packages'][0]['modified']=='2026-10-02 12:51:18';assert result['deleted']==[str(package)] and not package.exists() and other.exists()
assert keep.exists() and external.exists() and (package.parent/'linked.wxapkg').is_symlink()
assert clean()['deleted']==[str(other)] and not other.exists()
assert clean()['deleted']==[]
assert 'Duplicate' in run('gillii','clean','--dry-run','--dry-run',ok=False).stderr
assert '--dry-run' in run('gillii','__complete','clean','').stdout
assert run('gillii','__complete','clean','--root','').stdout=='@directories\n'
assert run('env','GILLII_NODE=/nonexistent','gillii','clean','--help').stdout
# Exercise the normal AppID-only flow with a synthetic main package and local npm stub.
work=scratch/'chase space';work.mkdir()
cachepath=pathlib.Path(os.environ['HOME'])/'Library/Containers/com.tencent.xinWeChat.MiniProgram/Data'/appid
cachepath.mkdir(parents=True)
def package_bytes(files):
 index=struct.pack('>I',len(files));offset=14+4+sum(12+len(name.encode()) for name in files)
 for name,body in files.items():
  encoded=name.encode();index+=struct.pack('>I',len(encoded))+encoded+struct.pack('>II',offset,len(body));offset+=len(body)
 return b'\xbe'+b'\0'*4+struct.pack('>II',len(index),sum(map(len,files.values())))+b'\xed'+b''.join([index,*files.values()])
main=cachepath/'main.wxapkg';main.write_bytes(package_bytes({'app-service.js':b'', 'app-config.json':b'{}'}))
sub=cachepath/'newer.wxapkg';sub.write_bytes(package_bytes({'page.js':b''}));os.utime(sub,(2000000000,2000000000))
npmroot=scratch/'npm mock';npmroot.mkdir();npm=npmroot/'npm'
npm.write_text('#!/bin/bash\nmkdir -p node_modules/acorn\nprintf stub > node_modules/acorn/package.json\nprintf called > "$HOME/npm-called"\n');npm.chmod(0o755)
autoenv=os.environ.copy();autoenv['PATH']=str(npmroot)+':'+autoenv['PATH']
for attempt in range(2):
 r=subprocess.run([str(root/'bin/gillii'),'chase',appid],cwd=work,env=autoenv,text=True,capture_output=True)
 assert r.returncode!=0 and 'Package:' in r.stdout,(r.stdout,r.stderr)
 assert ('Preparing dependencies' in r.stdout)==(attempt==0)
outputs=list(work.glob(appid+'-*'));assert len(outputs)==2
for output in outputs:
 assert (output/'original.wxapkg').read_bytes()==main.read_bytes()
 assert (output/'raw/app-config.json').exists()
 assert json.loads((output/'report.json').read_text())['input']==str(main)
assert (pathlib.Path(os.environ['HOME'])/'npm-called').exists()
assert 'Usage: gillii chase <AppID>' in run('gillii','chase',ok=False).stderr
assert 'Invalid AppID' in run('gillii','chase','invalid',ok=False).stderr
prefix=scratch/'install space'
run('bash',str(root/'install.sh'),'--prefix',str(prefix),'--version','0.1.0-dev')
exe=prefix/'bin/gillii';assert run(str(exe),'version').stdout==expected
saved=exe.read_bytes()
run('bash',str(root/'install.sh'),'--prefix',str(prefix),'--version','9.9.9',ok=False)
assert exe.read_bytes()==saved
mock=scratch/'mockbin';mock.mkdir()
curl=mock/'curl';curl.write_text('#!/bin/bash\nexit 22\n');curl.chmod(0o755)
mockenv=os.environ.copy();mockenv['PATH']=str(mock)+':'+mockenv['PATH']
command=['bash',str(root/'install.sh'),'--prefix',str(prefix),'--version','0.1.0-dev','--archive','https://example.invalid/source.tar.gz','--sha256','0'*64]
r=subprocess.run(command,env=mockenv,text=True,capture_output=True);assert r.returncode!=0
assert exe.read_bytes()==saved
curl.write_text('#!/bin/bash\nwhile [ "$#" -gt 0 ];do if [ "$1" = -o ];then shift;printf bad > "$1";exit 0;fi;shift;done\nexit 1\n')
r=subprocess.run(command,env=mockenv,text=True,capture_output=True);assert r.returncode!=0 and 'SHA256 mismatch' in r.stderr
assert exe.read_bytes()==saved
run('bash',str(root/'install.sh'),'--prefix',str(prefix))
assert run(str(exe),'--version').stdout==expected
for resource in ['share/man/man1/gillii.1','share/bash-completion/completions/gillii','share/zsh/site-functions/_gillii','share/fish/vendor_completions.d/gillii.fish']:assert (prefix/resource).exists()
env=os.environ.copy();env['MANPATH']=str(prefix/'share/man')+':'
r=subprocess.run(['man','-w','gillii'],env=env,text=True,capture_output=True);assert r.returncode==0 and 'gillii.1' in r.stdout,(r.stdout,r.stderr)
rendered=run('mandoc','-T','utf8',str(prefix/'share/man/man1/gillii.1')).stdout;rendered=re.sub(r'.\x08', '', rendered);assert 'SYNOPSIS' in rendered and 'V1MMWX' in rendered
for name in ['README.md','README-ZH.md']:
 text=(root/name).read_text();assert 'assets/banner.svg' in text and 'assets/logo.svg' in text
assert not (root/'.github/FUNDING.yml').exists()
print('PASS: CLI contract, candidates, isolated install/upgrade, version-failure preservation, manual and documentation')
PYTEST
mkdir -p "$scratch/path space/child dir"
touch "$scratch/path space/package file.wxapkg"
. "$root/completions/gillii.bash"
COMP_WORDS=(gillii help cha);COMP_CWORD=2;_gillii
[ "${COMPREPLY[0]}" = chase ]
COMP_WORDS=(gillii completion z);COMP_CWORD=2;_gillii
[ "${COMPREPLY[0]}" = zsh ]
COMP_WORDS=(gillii chase --input "$scratch/path space/p");COMP_CWORD=3;_gillii
[ "${COMPREPLY[0]}" = "$scratch/path space/package file.wxapkg" ]
COMP_WORDS=(gillii list --root "$scratch/path space/c");COMP_CWORD=3;_gillii
[ "${COMPREPLY[0]}" = "$scratch/path space/child dir" ]
COMP_WORDS=(gillii chase --appid wx0123456789abcdef --input "$scratch/path space/p");COMP_CWORD=5;_gillii
[ "${COMPREPLY[0]}" = "$scratch/path space/package file.wxapkg" ]
COMP_WORDS=(gillii chase -- '');COMP_CWORD=3;_gillii
[ "${#COMPREPLY[@]}" -eq 0 ]
printf 'PASS: Bash completion options, enums, repeated valued options, paths with spaces, separator\n'
if command -v zsh >/dev/null 2>&1; then
  zsh -f "$root/tests/zsh-completion.zsh" "$root"
fi
if command -v fish >/dev/null 2>&1;then
  fish -c "source '$root/completions/gillii.fish'; complete -C 'gillii completion z'" | grep zsh >/dev/null
else printf 'UNVERIFIED: Fish behavioral completion (Fish unavailable)\n';fi
