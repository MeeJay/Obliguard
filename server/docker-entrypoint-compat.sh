#!/bin/sh
# Compatibility shim: containers created before the image went non-root still
# carry Entrypoint ["/entrypoint.sh"] (or a compose `entrypoint:` override).
# The image itself sets no ENTRYPOINT; this only execs the command, as the
# unprivileged node user. An entrypoint override clears CMD, hence the default.
if [ "$#" -eq 0 ]; then set -- node dist/src/index.js; fi
exec "$@"
