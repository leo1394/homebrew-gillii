root=$1
function compdef() { : }
source "$root/completions/gillii.zsh"
function compadd() { shift; print -l -- "$@" }
function _files() { print -r -- "files:$*" }
words=(gillii help cha);CURRENT=3
[[ "$(_gillii)" == *chase* ]] || exit 1
words=(gillii completion z);CURRENT=3
[[ "$(_gillii)" == *zsh* ]] || exit 1
words=(gillii chase --input 'file space');CURRENT=4
[[ "$(_gillii)" == 'files:' ]] || exit 1
words=(gillii list --root 'directory space');CURRENT=4
[[ "$(_gillii)" == 'files:-/' ]] || exit 1
print 'PASS: Zsh completion candidates and path dispatch (interactive quoting unverified)'
