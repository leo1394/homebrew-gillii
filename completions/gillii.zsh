#compdef gillii
_gillii() {
  local -a candidates
  candidates=("${(@f)$(gillii __complete "${words[@]:1:$((CURRENT-1))}")}")
  case "${candidates[1]:-}" in
    @directories) _files -/;;
    @paths) _files;;
    *) compadd -- "${candidates[@]}";;
  esac
}
compdef _gillii gillii
