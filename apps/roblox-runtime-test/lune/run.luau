--!nocheck
-- Entry point: loads the compiled native runtime and runs every spec.
-- Usage: lune run lune/run.luau -- <compiled-runtime-dir> <promise.lua path>

local process = require("@lune/process")
local makeLoader = require("./loader")
local makeFakes = require("./fakes")
local framework = require("./framework")

local runtimeDir = process.args[1]
local promisePath = process.args[2]

assert(runtimeDir ~= nil, "missing compiled runtime directory argument")
assert(promisePath ~= nil, "missing Promise.lua path argument")

local fakes = makeFakes()
local loader = makeLoader(runtimeDir, promisePath, fakes)

local ctx = {
	load = loader.load,
	Promise = loader.Promise,
	fakes = fakes,
	t = framework,
}

require("./specs/schema")(ctx)
require("./specs/serialization")(ctx)
require("./specs/rate-limit")(ctx)
require("./specs/dispatch")(ctx)
require("./specs/server-app")(ctx)
require("./specs/transport")(ctx)
require("./specs/binary")(ctx)
require("./specs/signal")(ctx)
require("./specs/store")(ctx)

local failed = framework.finish()
if failed > 0 then
	process.exit(1)
end
