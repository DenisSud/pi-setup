function pi --wraps pi --description 'pi with bot profiles (pi --bot <name>)'
    set -l bots_home (set -q PI_BOTS_HOME; and echo $PI_BOTS_HOME; or echo $HOME/Bots)
    set -l idx (contains -i -- --bot $argv)
    if test -n "$idx"
        set -l name $argv[(math $idx + 1)]
        if test -d "$bots_home/$name"
            set -e argv[(math $idx + 1)]
            set -e argv[$idx]
            command pi-bot $name $argv
            return
        end
    end
    command pi $argv
end
