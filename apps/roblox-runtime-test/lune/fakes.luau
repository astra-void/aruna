--!nocheck
-- Minimal Roblox API fakes for executing the compiled roblox-ts-native runtime
-- under Lune. Only the surface the runtime actually touches is implemented:
-- ReplicatedStorage child lookup, RemoteEvent signals, and Instance.new.

local task = require("@lune/task")
local serde = require("@lune/serde")

local function makeSignal()
	local handlers = {}
	return {
		Connect = function(_self, fn)
			handlers[fn] = true
			return {
				Disconnect = function()
					handlers[fn] = nil
				end,
			}
		end,
		-- The Promise library's unhandled-rejection path calls Heartbeat:Wait();
		-- yield a frame so that path never errors during tests.
		Wait = function()
			task.wait()
		end,
		Fire = function(_self, ...)
			-- Snapshot handlers so a handler disconnecting mid-fire is safe.
			local snapshot = {}
			for fn in handlers do
				table.insert(snapshot, fn)
			end
			for _, fn in snapshot do
				fn(...)
			end
		end,
	}
end

-- A RemoteEvent that wires FireServer -> OnServerEvent (prepending a fake
-- player) and FireClient -> OnClientEvent in-process, so a client invoker and a
-- server binding sharing the instance complete a real round trip.
local function makeRemoteEvent(className)
	local remoteClassName = className or "RemoteEvent"
	local onServer = makeSignal()
	local onClient = makeSignal()
	local fakePlayer = { UserId = 1, Name = "Tester" }
	local attributes = {}

	local fields = {
		ClassName = remoteClassName,
		Name = remoteClassName,
		Parent = nil,
		OnServerEvent = onServer,
		OnClientEvent = onClient,
		_fakePlayer = fakePlayer,
		IsA = function(_self, queried)
			return queried == remoteClassName
		end,
		FireServer = function(_self, ...)
			onServer:Fire(fakePlayer, ...)
		end,
		FireClient = function(_self, _player, ...)
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
		__newindex = function(_t, key, value)
			if key == "Parent" and value ~= nil and value._addChild ~= nil then
				value:_addChild(fields)
			end
			fields[key] = value
		end,
	})
end

local function makeStorage()
	local children = {}
	return {
		FindFirstChild = function(_self, name)
			return children[name]
		end,
		WaitForChild = function(_self, name)
			local child = children[name]
			if child == nil then
				error(`WaitForChild timed out for {name}`)
			end
			return child
		end,
		_addChild = function(_self, instance)
			children[instance.Name] = instance
		end,
	}
end

-- An in-memory DataStore with the service's actual semantics: GetAsync returns
-- the stored value, and an UpdateAsync transform returning nil cancels the write
-- and leaves the record untouched. `failures` lets a spec make the next N calls
-- throw, which is how the retry policy is exercised.
local function makeDataStoreService()
	local stores = {}
	local budgets = {}
	local pendingFailures = {}
	local calls = { get = 0, set = 0, update = 0, remove = 0 }

	local function consumeFailure(kind)
		local queued = pendingFailures[kind]
		if queued ~= nil and #queued > 0 then
			return table.remove(queued, 1)
		end
		return nil
	end

	local function makeStore(name, scope)
		local key = if scope ~= nil then `{name}//{scope}` else name
		local entries = stores[key]
		if entries == nil then
			entries = {}
			stores[key] = entries
		end

		return {
			GetAsync = function(_self, entryKey)
				calls.get += 1
				local failure = consumeFailure("get")
				if failure ~= nil then
					error(failure, 0)
				end
				return entries[entryKey], { Version = "1" }
			end,
			SetAsync = function(_self, entryKey, value)
				calls.set += 1
				local failure = consumeFailure("set")
				if failure ~= nil then
					error(failure, 0)
				end
				entries[entryKey] = value
				return "version"
			end,
			UpdateAsync = function(_self, entryKey, transform)
				calls.update += 1
				local failure = consumeFailure("update")
				if failure ~= nil then
					error(failure, 0)
				end
				local nextValue = transform(entries[entryKey], { Version = "1" })
				if nextValue == nil then
					-- A nil result cancels the write, exactly like the real service.
					return entries[entryKey], { Version = "1" }
				end
				entries[entryKey] = nextValue
				return nextValue, { Version = "1" }
			end,
			RemoveAsync = function(_self, entryKey)
				calls.remove += 1
				local failure = consumeFailure("remove")
				if failure ~= nil then
					error(failure, 0)
				end
				local previous = entries[entryKey]
				entries[entryKey] = nil
				return previous, { Version = "1" }
			end,
		}
	end

	local service = {
		GetDataStore = function(_self, name, scope)
			return makeStore(name, scope)
		end,
		GetRequestBudgetForRequestType = function(_self, requestType)
			local budget = budgets[requestType]
			return if budget ~= nil then budget else 100
		end,
	}

	return {
		service = service,
		stores = stores,
		calls = calls,
		setBudget = function(requestType, amount)
			budgets[requestType] = amount
		end,
		queueFailure = function(kind, message)
			local queued = pendingFailures[kind]
			if queued == nil then
				queued = {}
				pendingFailures[kind] = queued
			end
			table.insert(queued, message)
		end,
		entriesFor = function(name, scope)
			local key = if scope ~= nil then `{name}//{scope}` else name
			return stores[key]
		end,
	}
end

-- Builds a fresh fake environment (game + Instance bound to one storage).
local function makeFakes()
	local storage = makeStorage()
	local heartbeat = makeSignal()
	local playerAdded = makeSignal()
	local playerRemoving = makeSignal()
	-- Players present for `Players:GetPlayers()` boot backfill. Tests push to this
	-- before `createServerApp` and clear it afterwards.
	local playerList = {}
	local dataStores = makeDataStoreService()
	-- Studio state is a spec knob: the DataStore backend only probes for missing
	-- API access when it believes it is running in Studio.
	local studio = { enabled = false }
	local closeHandlers = {}

	local game = {
		JobId = "test-job",
		PlaceId = 1,
		BindToClose = function(_self, handler)
			table.insert(closeHandlers, handler)
		end,
		GetService = function(_self, name)
			if name == "ReplicatedStorage" then
				return storage
			elseif name == "RunService" then
				return {
					Heartbeat = heartbeat,
					IsStudio = function()
						return studio.enabled
					end,
				}
			elseif name == "HttpService" then
				return {
					JSONEncode = function(_self, value)
						return serde.encode("json", value)
					end,
					JSONDecode = function(_self, value)
						return serde.decode("json", value)
					end,
				}
			elseif name == "DataStoreService" then
				return dataStores.service
			elseif name == "Players" then
				return {
					PlayerAdded = playerAdded,
					PlayerRemoving = playerRemoving,
					GetPlayers = function(_self)
						local copy = {}
						for _, player in playerList do
							table.insert(copy, player)
						end
						return copy
					end,
				}
			end
			error(`unhandled GetService: {name}`)
		end,
	}

	local Instance = {
		new = function(className)
			if className == "RemoteEvent" or className == "UnreliableRemoteEvent" then
				return makeRemoteEvent(className)
			end
			error(`unhandled Instance.new: {className}`)
		end,
	}

	-- DateTime and Enum are the two Roblox globals the store touches. The clock is
	-- settable so a spec can age a session lock past its TTL without waiting.
	local clock = { ms = 1_000 }
	local DateTime = {
		now = function()
			return { UnixTimestampMillis = clock.ms }
		end,
	}
	local Enum = {
		DataStoreRequestType = {
			GetAsync = "GetAsync",
			SetIncrementAsync = "SetIncrementAsync",
			UpdateAsync = "UpdateAsync",
		},
	}

	return {
		game = game,
		Instance = Instance,
		DateTime = DateTime,
		Enum = Enum,
		clock = clock,
		storage = storage,
		makeRemoteEvent = makeRemoteEvent,
		playerAdded = playerAdded,
		playerRemoving = playerRemoving,
		playerList = playerList,
		dataStores = dataStores,
		studio = studio,
		closeHandlers = closeHandlers,
	}
end

return makeFakes
