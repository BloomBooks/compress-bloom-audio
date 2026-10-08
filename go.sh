#!/usr/bin/env bash
# Start the dev server: the GUI (React + the in-process compression API) on
# http://localhost:5190, with @compress-bloom-audio/lib resolved from SOURCE, so
# editing packages/lib is live in the running server.
#
# The native desktop shell (packages/app, Neutralino) is separate — run
# `pnpm app-dev` alongside this and its window points at this dev server.
set -e
exec vp run -F @compress-bloom-audio/gui dev
