_gillii() {
  local cur line marker path_prefix
  cur=${COMP_WORDS[COMP_CWORD]}
  path_prefix=$cur
  case "$path_prefix" in '~/'*) path_prefix="$HOME/${path_prefix#\~/}";; esac
  COMPREPLY=()
  while IFS= read -r line; do
    case "$line" in
      @directories) while IFS= read -r marker; do COMPREPLY+=("$marker"); done < <(compgen -d -- "$path_prefix");;
      @paths) while IFS= read -r marker; do COMPREPLY+=("$marker"); done < <(compgen -f -- "$path_prefix");;
      *) case "$line" in "$cur"*) COMPREPLY+=("$line");; esac;;
    esac
  done < <("${COMP_WORDS[0]}" __complete "${COMP_WORDS[@]:1:COMP_CWORD}")
  if type compopt >/dev/null 2>&1; then compopt -o filenames 2>/dev/null || :; fi
}
complete -o filenames -F _gillii gillii ./bin/gillii
