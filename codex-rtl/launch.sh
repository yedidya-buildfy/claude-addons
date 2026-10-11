#!/bin/zsh
# dosu takes a bare program path with no arguments, so the codex function in
# ~/.zshrc passes them pre-quoted in CODEX_RTL_ARGS and this script runs them.
eval "exec codex $CODEX_RTL_ARGS"
