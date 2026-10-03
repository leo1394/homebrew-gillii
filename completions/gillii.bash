_gillii() {
  local cur line marker
  cur=${COMP_WORDS[COMP_CWORD]}
  COMPREPLY=()
  while IFS= read -r line; do
    case "$line" in
      @directories) while IFS= read -r marker; do COMPREPLY+=("$marker"); done < <(compgen -d -- "$cur");;
      @paths) while IFS= read -r marker; do COMPREPLY+=("$marker"); done < <(compgen -f -- "$cur");;
      *) case "$line" in "$cur"*) COMPREPLY+=("$line");; esac;;
    esac
  done < <(gillii __complete "${COMP_WORDS[@]:1:COMP_CWORD}")
  if type compopt >/dev/null 2>&1; then compopt -o filenames 2>/dev/null || :; fi
}
complete -o filenames -F _gillii gillii
