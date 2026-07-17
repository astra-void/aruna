--!nocheck
-- Loads compiled roblox-ts Luau modules under Lune.
--
-- The real roblox-ts RuntimeLib resolves imports through the Roblox Instance
-- tree (require on ModuleScripts), which Lune cannot do. Instead we provide a
-- minimal `TS` shim: `TS.import` resolves sibling modules by base name from the
-- compiled output directory, and `TS.Promise` is the real roblox-ts Promise
-- library loaded standalone. Roblox globals the runtime touches (task, typeIs,
-- game, Instance) are injected per module.

local fs = require("@lune/fs")
local luau = require("@lune/luau")
local task = require("@lune/task")
-- Real Roblox value types (Vector3/Color3/CFrame) so the native binary codec's
-- userdata path executes against genuine datatypes, matching how RemoteEvents
-- carry them in-engine.
local roblox = require("@lune/roblox")

-- `runtimeDirs` is a compiled-output directory (string) or an ordered list of
-- them (table). Multiple dirs let a consumer project point this loader at
-- both the vendored aruna runtime output and its own compiled action modules
-- without merging the two into one directory — each is searched in order for
-- `{name}.luau`, so base names must stay unique across all of them.
local function makeLoader(runtimeDirs, promisePath, fakes)
	local dirs = type(runtimeDirs) == "table" and runtimeDirs or { runtimeDirs }
	-- Shared `_G`; each module reads `local TS = _G[script]`.
	local globalTable = {}
	local folder = setmetatable({ Name = "runtime" }, {
		__tostring = function()
			return "Folder(runtime)"
		end,
	})

	local function baseEnv(scriptObj, ts)
		globalTable[scriptObj] = ts
		return {
			script = scriptObj,
			_G = globalTable,
			task = task,
			game = fakes.game,
			Instance = fakes.Instance,
			typeIs = function(value, typeName)
				return typeof(value) == typeName
			end,
			Vector3 = roblox.Vector3,
			Vector2 = roblox.Vector2,
			Color3 = roblox.Color3,
			CFrame = roblox.CFrame,
			UDim = roblox.UDim,
			UDim2 = roblox.UDim2,
			BrickColor = roblox.BrickColor,
			-- The Promise library warns on unhandled rejections; the dispatch
			-- path intentionally swallows rejections into result payloads, so
			-- keep the test output clean.
			warn = function() end,
		}
	end

	local function newScript(name)
		return setmetatable({ Name = name, Parent = folder }, {
			__tostring = function()
				return `Script({name})`
			end,
		})
	end

	-- Load the Promise library standalone (it reads game:GetService at load).
	local promiseSource = fs.readFile(promisePath)
	local promiseFn = luau.load(promiseSource, {
		debugName = "Promise",
		environment = baseEnv(newScript("Promise"), nil),
		injectGlobals = true,
	})
	local Promise = promiseFn()

	local ts = { Promise = Promise }
	local cache = {}

	local function findModulePath(name)
		for _, dir in dirs do
			local path = `{dir}/{name}.luau`
			if fs.isFile(path) then
				return path
			end
		end
		return nil
	end

	local function loadModule(name)
		local cached = cache[name]
		if cached ~= nil then
			return cached
		end

		local path = findModulePath(name)
		assert(path ~= nil, `module not found in any runtime dir: {name}`)
		local source = fs.readFile(path)
		local fn = luau.load(source, {
			debugName = name,
			environment = baseEnv(newScript(name), ts),
			injectGlobals = true,
		})
		local result = fn()
		cache[name] = result
		return result
	end

	-- Compiled modules call TS.import(script, script.Parent, "name"). All runtime
	-- modules are flat siblings, so the final vararg is the module base name.
	ts.import = function(_context, _module, ...)
		local names = { ... }
		return loadModule(names[#names])
	end

	return {
		load = loadModule,
		Promise = Promise,
	}
end

return makeLoader
