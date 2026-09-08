--!nocheck
-- Roblox API doubles for running a compiled Aruna project under Lune.
--
-- Only the surface the Aruna runtime and a typical spec actually touch is
-- implemented: the services a server app reaches for, RemoteEvents wired
-- in-process, and an in-memory DataStore. Anything else raises a named error
-- rather than a nil index, so a spec that wandered outside the supported surface
-- says so instead of failing three frames later.

local serde = require("@lune/serde")
local task = require("@lune/task")

local function makeSignal()
	local handlers = {}
	return {
		Connect = function(_self, callback)
			handlers[callback] = true
			return {
				Disconnect = function()
					handlers[callback] = nil
				end,
			}
		end,
		Wait = function()
			task.wait()
		end,
		Fire = function(_self, ...)
			-- Snapshot first: a handler that disconnects mid-fire is safe.
			local snapshot = {}
			for callback in handlers do
				table.insert(snapshot, callback)
			end
			for _, callback in snapshot do
				callback(...)
			end
		end,
	}
end

-- A RemoteEvent that wires FireServer -> OnServerEvent and FireClient ->
-- OnClientEvent in-process, so a client invoker and a server binding sharing the
-- instance complete a real round trip. Parenting registers it with the container,
-- which is what `WaitForChild` on the client side then finds.
local function makeRemoteEvent(className, localPlayer)
	local onServer = makeSignal()
	local onClient = makeSignal()
	local attributes = {}
	local fields = {
		ClassName = className,
		Name = className,
		Parent = nil,
		OnServerEvent = onServer,
		OnClientEvent = onClient,
		IsA = function(_self, queried)
			return queried == className
		end,
		GetFullName = function(self)
			return self.Name
		end,
		FireServer = function(_self, ...)
			onServer:Fire(localPlayer, ...)
		end,
		FireClient = function(_self, _player, ...)
			onClient:Fire(...)
		end,
		FireAllClients = function(_self, ...)
			onClient:Fire(...)
		end,
		SetAttribute = function(_self, name, value)
			attributes[name] = value
		end,
		GetAttribute = function(_self, name)
			return attributes[name]
		end,
	}

	return setmetatable({}, {
		__index = fields,
		__newindex = function(_table, key, value)
			if key == "Parent" and value ~= nil and rawget(value, "_children") ~= nil then
				value._children[fields.Name] = fields
			end
			fields[key] = value
		end,
	})
end

-- An in-memory DataStore with the service's real semantics: an UpdateAsync
-- transform returning nil cancels the write, and the request budget is
-- unlimited. A spec that wants failures should use `createMemoryStoreBackend`
-- from `aruna/server` instead, which is built for injecting them.
local function makeDataStoreService()
	local stores = {}

	local function makeStore(name, scope)
		local key = if scope ~= nil then `{name}//{scope}` else name
		local entries = stores[key]
		if entries == nil then
			entries = {}
			stores[key] = entries
		end
		return {
			GetAsync = function(_self, entryKey)
				return entries[entryKey], { Version = "1" }
			end,
			SetAsync = function(_self, entryKey, value)
				entries[entryKey] = value
				return "version"
			end,
			UpdateAsync = function(_self, entryKey, transform)
				local nextValue = transform(entries[entryKey], { Version = "1" })
				if nextValue == nil then
					return entries[entryKey], { Version = "1" }
				end
				entries[entryKey] = nextValue
				return nextValue, { Version = "1" }
			end,
			RemoveAsync = function(_self, entryKey)
				local previous = entries[entryKey]
				entries[entryKey] = nil
				return previous, { Version = "1" }
			end,
		}
	end

	return {
		GetDataStore = function(_self, name, scope)
			return makeStore(name, scope)
		end,
		GetRequestBudgetForRequestType = function()
			return 100
		end,
	}
end

-- `services` are the Instance-tree containers the loader built from the compiled
-- output; the behavioural services are created here.
local function makeFakes(services)
	local heartbeat = makeSignal()
	local playerAdded = makeSignal()
	local playerRemoving = makeSignal()
	local playerList = {}
	local dataStoreService = makeDataStoreService()
	local closeHandlers = {}
	local localPlayer = { Name = "LocalPlayer", UserId = 1 }
	local loaded = makeSignal()

	local players = {
		LocalPlayer = localPlayer,
		PlayerAdded = playerAdded,
		PlayerRemoving = playerRemoving,
		GetPlayers = function()
			local copy = {}
			for _, player in playerList do
				table.insert(copy, player)
			end
			return copy
		end,
	}

	local runService = {
		Heartbeat = heartbeat,
		IsStudio = function()
			return false
		end,
		IsRunning = function()
			return false
		end,
		IsClient = function()
			return false
		end,
		IsServer = function()
			return true
		end,
	}

	local httpService = {
		JSONEncode = function(_self, value)
			return serde.encode("json", value)
		end,
		JSONDecode = function(_self, value)
			return serde.decode("json", value)
		end,
		GenerateGUID = function()
			return `{math.random(0, 2 ^ 31)}-{math.random(0, 2 ^ 31)}`
		end,
	}

	local game
	game = {
		JobId = "aruna-test",
		PlaceId = 0,
		Loaded = loaded,
		IsLoaded = function()
			return true
		end,
		BindToClose = function(_self, handler)
			table.insert(closeHandlers, handler)
		end,
		GetService = function(_self, name)
			local container = services[name]
			if container ~= nil then
				return container
			end
			if name == "Players" then
				return players
			elseif name == "RunService" then
				return runService
			elseif name == "HttpService" then
				return httpService
			elseif name == "DataStoreService" then
				return dataStoreService
			end
			error(
				`aruna test: {name} is not available under Lune. Specs run outside a game, `
					.. `so only the services the Aruna runtime needs are faked.`,
				2
			)
		end,
	}

	local Instance = {
		new = function(className)
			if className == "RemoteEvent" or className == "UnreliableRemoteEvent" then
				return makeRemoteEvent(className, localPlayer)
			end
			error(`aruna test: Instance.new("{className}") is not available under Lune.`, 2)
		end,
	}

	return {
		game = game,
		Instance = Instance,
		players = players,
		playerList = playerList,
		closeHandlers = closeHandlers,
		dataStoreService = dataStoreService,
	}
end

return {
	makeFakes = makeFakes,
	makeSignal = makeSignal,
	makeRemoteEvent = makeRemoteEvent,
}
