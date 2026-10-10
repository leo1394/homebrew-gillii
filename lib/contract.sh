gillii_commands='list clean chase info open setup version help completion'
gillii_options() {
  case "$1" in
    list) printf '%s\n' --appid --root --help;;
    info) printf '%s\n' --root --help;;
    clean) printf '%s\n' --appid --root --dry-run --help;;
    chase) printf '%s\n' --appid --input --output --help;;
    completion) printf '%s\n' bash zsh fish;;
    *) printf '%s\n' --help;;
  esac
}
