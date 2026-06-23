--!nocheck
-- Minimal Roblox API fakes for executing the compiled roblox-ts-native runtime
-- under Lune. Only the surface the runtime actually touches is implemented:
-- ReplicatedStorage child lookup, RemoteEvent signals, and Instance.new.

local task = require("@lune/task")

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
local function makeRemoteEvent()
	local onServer = makeSignal()
	local onClient = makeSignal()
	local fakePlayer = { UserId = 1, Name = "Tester" }

	local fields = {
		ClassName = "RemoteEvent",
		Name = "RemoteEvent",
		Parent = nil,
		OnServerEvent = onServer,
		OnClientEvent = onClient,
		_fakePlayer = fakePlayer,
		IsA = function(_self, className)
			return className == "RemoteEvent"
		end,
		FireServer = function(_self, ...)
			onServer:Fire(fakePlayer, ...)
		end,
		FireClient = function(_self, _player, ...)
			onClient:Fire(...)
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

-- Builds a fresh fake environment (game + Instance bound to one storage).
local function makeFakes()
	local storage = makeStorage()
	local heartbeat = makeSignal()

	local game = {
		GetService = function(_self, name)
			if name == "ReplicatedStorage" then
				return storage
			elseif name == "RunService" then
				return { Heartbeat = heartbeat }
			end
			error(`unhandled GetService: {name}`)
		end,
	}

	local Instance = {
		new = function(className)
			if className == "RemoteEvent" then
				return makeRemoteEvent()
			end
			error(`unhandled Instance.new: {className}`)
		end,
	}

	return {
		game = game,
		Instance = Instance,
		storage = storage,
		makeRemoteEvent = makeRemoteEvent,
	}
end

return makeFakes
