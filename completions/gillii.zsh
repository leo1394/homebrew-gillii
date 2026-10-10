#compdef gillii
_gillii() {
  local -a candidates values
  local candidate result=1
  candidates=("${(@f)$("${words[1]}" __complete "${words[@]:1:$((CURRENT-1))}")}")
  for candidate in "${candidates[@]}"; do
    case "$candidate" in
      @directories) _files -/ && result=0;;
      @paths) _files && result=0;;
      '') ;;
      *) values+=("$candidate");;
    esac
  done
  if (( ${#values} )); then compadd -- "${values[@]}" && result=0; fi
  return $result
}
compdef _gillii gillii ./bin/gillii
