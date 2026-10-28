--!nocheck
-- Entry point: loads the compiled native runtime and runs every spec.
-- Usage: lune run lune/run.luau -- <compiled-runtime-dir> <promise.lua path> <conformance table path>

local process = require("@lune/process")
local makeLoader = require("./loader")
local makeFakes = require("./fakes")
local framework = require("./framework")

local runtimeDir = process.args[1]
local promisePath = process.args[2]
local conformancePath = process.args[3]

assert(runtimeDir ~= nil, "missing compiled runtime directory argument")
assert(promisePath ~= nil, "missing Promise.lua path argument")
assert(conformancePath ~= nil, "missing conformance table path argument")

local fakes = makeFakes()
local loader = makeLoader(runtimeDir, promisePath, fakes)

local ctx = {
	load = loader.load,
	Promise = loader.Promise,
	fakes = fakes,
	t = framework,
	conformancePath = conformancePath,
}

fakes.startHeartbeat()

require("./specs/schema")(ctx)
require("./specs/serialization")(ctx)
require("./specs/rate-limit")(ctx)
require("./specs/dispatch")(ctx)
require("./specs/server-app")(ctx)
require("./specs/transport")(ctx)
require("./specs/binary")(ctx)
require("./specs/signal")(ctx)
require("./specs/store")(ctx)
require("./specs/testing")(ctx)
require("./specs/conformance")(ctx)

fakes.stopHeartbeat()
local failed = framework.finish()
-- Exit explicitly, as the `aruna test` runner does: a timer a spec left armed
-- (an invoker's request timeout, a Heartbeat-driven Promise.delay) must not hold
-- the process open once the results are in.
process.exit(if failed > 0 then 1 else 0)
