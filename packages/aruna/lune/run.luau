--!nocheck
-- `aruna test` entry point.
--
-- Usage: lune run run.luau -- <outRoot> <includeRoot> <generatedDir> <nodeModules|-> [filter]
--
-- Requires every compiled spec (which registers its tests as a side effect, the
-- way a spec file does under any runner), then asks the project's own compiled
-- copy of `aruna/testing` to run them. Reaching for the project's copy rather
-- than a runner-side one is the whole point: the tests were collected into that
-- module's state, and it is the same build the game ships.

local fs = require("@lune/fs")
local process = require("@lune/process")
local roblox = require("@lune/roblox")
local task = require("@lune/task")

local loaderModule = require("./loader")
local fakesModule = require("./fakes")

local outRoot = process.args[1]
local includeRoot = process.args[2]
local generatedDir = process.args[3]
local nodeModules = process.args[4]
local filter = process.args[5]

assert(outRoot ~= nil, "aruna test: missing compiled output directory")
assert(includeRoot ~= nil, "aruna test: missing include directory")
assert(generatedDir ~= nil, "aruna test: missing generated directory name")
if nodeModules == "-" then
	nodeModules = nil
end

-- Collected before the loader exists, because the loader needs the globals table.
local globals = {
	task = task,
	Vector3 = roblox.Vector3,
	Vector2 = roblox.Vector2,
	Color3 = roblox.Color3,
	CFrame = roblox.CFrame,
	UDim = roblox.UDim,
	UDim2 = roblox.UDim2,
	BrickColor = roblox.BrickColor,
	typeIs = function(value, typeName)
		return typeof(value) == typeName
	end,
	DateTime = {
		now = function()
			return { UnixTimestampMillis = math.floor(os.time() * 1000) }
		end,
		fromUnixTimestampMillis = function(millis)
			return { UnixTimestampMillis = millis }
		end,
	},
	Enum = {
		DataStoreRequestType = {
			GetAsync = "GetAsync",
			SetIncrementAsync = "SetIncrementAsync",
			UpdateAsync = "UpdateAsync",
		},
	},
	-- The Promise library warns on unhandled rejections, and a spec asserting a
	-- rejection is exactly that. Test output stays about the tests.
	warn = function() end,
}

local fakes
local loader = loaderModule.makeLoader({
	outRoot = outRoot,
	includeRoot = includeRoot,
	nodeModules = nodeModules,
	globals = globals,
	makeGame = function(services)
		fakes = fakesModule.makeFakes(services)
		globals.Instance = fakes.Instance
		return fakes.game
	end,
})

-- Every compiled spec, in a stable order so a failure list reads the same twice.
local function collectSpecs(directory, prefix, found)
	if not fs.isDir(directory) then
		return found
	end
	local entries = fs.readDir(directory)
	table.sort(entries)
	for _, entry in entries do
		local entryPath = `{directory}/{entry}`
		if fs.isDir(entryPath) then
			collectSpecs(entryPath, if prefix == "" then entry else `{prefix}/{entry}`, found)
		elseif string.sub(entry, -5) == ".luau" then
			local base = string.sub(entry, 1, -6)
			table.insert(found, {
				segments = if prefix == "" then { base } else string.split(`{prefix}/{base}`, "/"),
				display = if prefix == "" then base else `{prefix}/{base}`,
			})
		end
	end
	return found
end

local specs = collectSpecs(`{outRoot}/test`, "", {})
local total = #specs
if filter ~= nil and filter ~= "" then
	local kept = {}
	for _, spec in specs do
		if string.find(spec.display, filter, 1, true) ~= nil then
			table.insert(kept, spec)
		end
	end
	specs = kept
end

if #specs == 0 then
	-- A filter that matched nothing is a failure: reporting a pass would say the
	-- suite ran when it did not. A project with no specs at all is not.
	if total > 0 then
		print(`no specs match "{filter}" (of {total} found)`)
		process.exit(1)
	end
	print("no specs found — add a *.test.ts next to the code it exercises")
	process.exit(0)
end

-- The spec tree is mounted as ServerScriptService.ArunaTests, matching the Rojo
-- project the staged build compiled against.
local testsRoot = loader.trees.tests
for _, spec in specs do
	local node = testsRoot
	for _, segment in spec.segments do
		node = node:WaitForChild(segment)
	end
	loader.require(node)
end

-- The project's compiled `aruna/testing`, vendored under the generated dir.
local sharedRoot = loader.trees.shared
local testingModule = sharedRoot:WaitForChild(generatedDir):WaitForChild("runtime"):WaitForChild("testing")
local testing = loader.require(testingModule)

local report = nil
local failed = nil
testing.runTests({
	onTest = function(outcome)
		if outcome.skipped then
			print(`  - {outcome.name} (skipped)`)
		elseif outcome.ok then
			print(`  ✓ {outcome.name}`)
		else
			print(`  ✗ {outcome.name}`)
			print(`      {outcome.message}`)
		end
	end,
}):andThen(function(result)
	report = result
end, function(reason)
	failed = reason
end)

-- Pump the scheduler until the run settles. Lune's main thread has to keep
-- yielding for the Promise chain — and any task.wait() a spec performs — to make
-- progress.
local deadline = os.clock() + 120
while report == nil and failed == nil and os.clock() < deadline do
	task.wait()
end

if failed ~= nil then
	print(`\naruna test: the run itself failed: {tostring(failed)}`)
	process.exit(1)
end
if report == nil then
	print("\naruna test: timed out after 120s waiting for the suite to finish")
	process.exit(1)
end

local summary = `{report.passed} passed, {report.failed} failed`
if report.skipped > 0 then
	summary = `{summary}, {report.skipped} skipped`
end
print(`\n{summary}`)

if report.failed > 0 then
	print("\nFailures:")
	for _, outcome in report.outcomes do
		if not outcome.ok then
			print(`  - {outcome.name}\n      {outcome.message}`)
		end
	end
	process.exit(1)
end
process.exit(0)
