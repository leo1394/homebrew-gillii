function __gillii_candidates
    set -l words (commandline -opc)
    set -l current (commandline -ct)
    set -l candidates (gillii __complete $words[2..-1] "$current")
    switch "$candidates[1]"
        case '@directories'
            __fish_complete_directories "$current"
        case '@paths'
            __fish_complete_path "$current"
        case '*'
            printf '%s\n' $candidates
    end
end
complete -c gillii -f -a '(__gillii_candidates)'
