--!nocheck
-- Loads a compiled Aruna project under Lune.
--
-- `aruna test` stages the project (specs included), compiles it to Luau with
-- rbxtsc, and hands the resulting `out/` tree to this loader. Compiled roblox-ts
-- modules resolve their imports through the Roblox Instance tree — every file
-- starts with `require(game:GetService("ReplicatedStorage"):WaitForChild(
-- "rbxts_include"):WaitForChild("RuntimeLib"))` and then calls
-- `TS.import(script, game:GetService(...), "TS", ...)` — so the loader rebuilds
-- that tree from directories on disk and serves `require` from files.
--
-- The real RuntimeLib is loaded rather than reimplemented: it brings every
-- roblox-ts helper (spread, Object.keys, async/await, the Promise library) and
-- the exact import semantics the compiled code was emitted against. A hand-rolled
-- `TS` table would drift from the compiler on the first helper a project uses.

local fs = require("@lune/fs")
local luau = require("@lune/luau")

local function isModuleFile(name)
	return string.sub(name, -5) == ".luau" or string.sub(name, -4) == ".lua"
end

local function moduleBaseName(name)
	if string.sub(name, -5) == ".luau" then
		return string.sub(name, 1, -6)
	end
	return string.sub(name, 1, -5)
end

local Loader = {}
Loader.__index = Loader

local function newInstance(className, name, parent)
	return {
		ClassName = className,
		Name = name,
		Parent = parent,
		_children = {},
	}
end

-- Instance methods live on one shared metatable so every node — folder or
-- module — answers the handful of members RuntimeLib and the runtime touch.
local instanceMethods = {}

function instanceMethods.FindFirstChild(self, name)
	return self._children[name]
end

function instanceMethods.WaitForChild(self, name)
	local child = self._children[name]
	if child == nil then
		-- Yielding forever is what Roblox does; under a test runner it would just
		-- hang, so this reports the missing path instead.
		error(`aruna test: {instanceMethods.GetFullName(self)} has no child "{name}"`, 2)
	end
	return child
end

function instanceMethods.GetChildren(self)
	local children = {}
	for _, child in self._children do
		table.insert(children, child)
	end
	return children
end

function instanceMethods.GetFullName(self)
	local parts = { self.Name }
	local node = self.Parent
	while node ~= nil do
		table.insert(parts, 1, node.Name)
		node = node.Parent
	end
	return table.concat(parts, ".")
end

function instanceMethods.IsA(self, className)
	return self.ClassName == className
end

function instanceMethods.FindFirstAncestorWhichIsA(self, className)
	local node = self.Parent
	while node ~= nil do
		if node.ClassName == className then
			return node
		end
		node = node.Parent
	end
	return nil
end

local instanceMeta = {
	__index = function(node, key)
		local method = instanceMethods[key]
		if method ~= nil then
			return method
		end
		return rawget(node, "_children")[key]
	end,
	__tostring = function(node)
		return instanceMethods.GetFullName(node)
	end,
}

local function attach(parent, child)
	child.Parent = parent
	parent._children[child.Name] = child
	return child
end

local function newFolder(name, parent)
	local folder = setmetatable(newInstance("Folder", name, parent), instanceMeta)
	if parent ~= nil then
		attach(parent, folder)
	end
	return folder
end

-- Mirrors one directory of compiled output as an Instance subtree. A `foo.luau`
-- next to a `foo/` directory becomes one ModuleScript holding that directory's
-- children, which is how Rojo merges the same pair.
local function buildTree(directory, name, parent)
	local root = newFolder(name, parent)
	if not fs.isDir(directory) then
		return root
	end

	local moduleFiles = {}
	local directories = {}
	for _, entry in fs.readDir(directory) do
		local entryPath = `{directory}/{entry}`
		if fs.isDir(entryPath) then
			directories[entry] = entryPath
		elseif isModuleFile(entry) then
			moduleFiles[moduleBaseName(entry)] = entryPath
		end
	end

	for base, filePath in moduleFiles do
		local node = setmetatable(newInstance("ModuleScript", base, root), instanceMeta)
		node._file = filePath
		attach(root, node)
	end

	for base, dirPath in directories do
		local existing = rawget(root._children, base)
		if existing ~= nil then
			-- `foo.luau` + `foo/`: keep the module, adopt the directory's children.
			local merged = buildTree(dirPath, base, nil)
			for childName, child in merged._children do
				child.Parent = existing
				existing._children[childName] = child
			end
		else
			buildTree(dirPath, base, root)
		end
	end

	return root
end

-- `makeLoader(options)` returns the pieces a runner needs: the service tree the
-- fake `game` serves, a `require` that loads compiled modules from disk, and the
-- shared `TS` table.
--
-- options = {
--   outRoot        -- compiled partitions: client/, server/, shared/, test/
--   includeRoot    -- rbxtsc's runtime library (RuntimeLib.lua, Promise.lua)
--   nodeModules    -- optional path to the project's node_modules (for @rbxts)
--   globals        -- Roblox globals injected into every module environment
--   makeGame       -- called with the service table; returns the fake `game`
-- }
local function makeLoader(options)
	local root = setmetatable(newInstance("DataModel", "game", nil), instanceMeta)

	local replicatedStorage = newFolder("ReplicatedStorage", root)
	replicatedStorage.ClassName = "ReplicatedStorage"
	local serverScriptService = newFolder("ServerScriptService", root)
	serverScriptService.ClassName = "ServerScriptService"
	local starterPlayer = newFolder("StarterPlayer", root)
	local starterPlayerScripts = newFolder("StarterPlayerScripts", starterPlayer)

	-- The same mounts `partitionedRojoProject` declares, which is what rbxtsc
	-- resolved every import against when it compiled this output.
	local shared = buildTree(`{options.outRoot}/shared`, "TS", replicatedStorage)
	local server = buildTree(`{options.outRoot}/server`, "TS", serverScriptService)
	buildTree(`{options.outRoot}/client`, "TS", starterPlayerScripts)
	local tests = buildTree(`{options.outRoot}/test`, "ArunaTests", serverScriptService)

	local include = buildTree(options.includeRoot, "rbxts_include", replicatedStorage)
	if options.nodeModules ~= nil and fs.isDir(`{options.nodeModules}/@rbxts`) then
		local nodeModules = newFolder("node_modules", include)
		buildTree(`{options.nodeModules}/@rbxts`, "@rbxts", nodeModules)
	end

	local services = {
		ReplicatedStorage = replicatedStorage,
		ServerScriptService = serverScriptService,
		StarterPlayer = starterPlayer,
	}
	local game = options.makeGame(services, root)

	local sharedG = {}
	local cache = {}
	local requireModule

	local function environmentFor(node)
		local environment = {
			script = node,
			_G = sharedG,
			game = game,
			require = requireModule,
		}
		for key, value in options.globals do
			environment[key] = value
		end
		return environment
	end

	requireModule = function(node)
		if type(node) ~= "table" or rawget(node, "_file") == nil then
			error(`aruna test: require expects a ModuleScript, got {tostring(node)}`, 2)
		end
		local cached = cache[node]
		if cached ~= nil then
			return cached.value
		end

		local source = fs.readFile(node._file)
		local chunk = luau.load(source, {
			debugName = instanceMethods.GetFullName(node),
			environment = environmentFor(node),
			injectGlobals = true,
		})
		local value = chunk()
		cache[node] = { value = value }
		return value
	end

	-- Every compiled module opens by requiring RuntimeLib out of the tree, so it
	-- loads through the same shim and shares this loader's `_G`.
	local runtimeLib = replicatedStorage._children["rbxts_include"]._children["RuntimeLib"]
	assert(runtimeLib ~= nil, "aruna test: rbxts_include/RuntimeLib is missing from the compiled output")

	return {
		game = game,
		services = services,
		require = requireModule,
		TS = requireModule(runtimeLib),
		trees = { shared = shared, server = server, tests = tests, include = include },
	}
end

return {
	makeLoader = makeLoader,
	buildTree = buildTree,
	newFolder = newFolder,
	instanceMeta = instanceMeta,
}
