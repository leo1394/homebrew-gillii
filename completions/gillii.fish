function __gillii_candidates
    set -l words (commandline -opc)
    set -l current (commandline -ct)
    set -l candidates ($words[1] __complete $words[2..-1] "$current")
    for candidate in $candidates
        switch "$candidate"
            case '@directories'
                __fish_complete_directories "$current"
            case '@paths'
                __fish_complete_path "$current"
            case '*'
                printf '%s\n' "$candidate"
        end
    end
end
complete -c gillii -f -a '(__gillii_candidates)'
