--!nocheck
-- Execution coverage for the server -> client signal publisher/subscriber
-- (roblox/signal-runtime.ts) over an in-process fake signal RemoteEvent.
return function(ctx)
	local t = ctx.t
	local schema = ctx.load("schema").schema
	local defineSignal = ctx.load("signal").defineSignal
	local signalRuntime = ctx.load("signal-runtime")

	-- A minimal shared remote: FireClient/FireAllClients fan out to every
	-- OnClientEvent handler in-process. FireClient/FireAllClients/Connect are
	-- plain function fields (the runtime types them as arrow properties, so the
	-- compiler emits dot calls without an implicit self).
	local function makeSignalRemote()
		local handlers = {}
		local function fire(message)
			local snapshot = {}
			for fn in handlers do
				table.insert(snapshot, fn)
			end
			for _, fn in snapshot do
				fn(message)
			end
		end
		local remote = {
			FireClient = function(_player, message)
				fire(message)
			end,
			FireAllClients = function(message)
				fire(message)
			end,
			OnClientEvent = {
				Connect = function(fn)
					handlers[fn] = true
					return {
						Disconnect = function()
							handlers[fn] = nil
						end,
					}
				end,
			},
		}
		return remote
	end

	local function makeSignals()
		return {
			["combat.damaged"] = defineSignal({
				id = "combat.damaged",
				payload = schema.object({ amount = schema.number(), source = schema.string() }),
			}),
			["world.tick"] = defineSignal({ id = "world.tick" }),
		}
	end

	t.describe("signal transport", function()
		t.it("delivers a published payload to a dynamic subscriber", function()
			local remote = makeSignalRemote()
			local signals = makeSignals()
			local publisher = signalRuntime.createRemoteSignalPublisher(remote, signals)
			local subscriber = signalRuntime.createRemoteSignalSubscriber(remote, signals)

			local received = nil
			subscriber.on("combat.damaged", function(payload)
				received = payload
			end)

			publisher.to("Ada", "combat.damaged", { amount = 7, source = "spike" })

			t.isFalse(received == nil, "handler should have fired")
			t.eq(received.amount, 7)
			t.eq(received.source, "spike")
			subscriber.dispose()
		end)

		t.it("broadcasts to all subscribers", function()
			local remote = makeSignalRemote()
			local signals = makeSignals()
			local publisher = signalRuntime.createRemoteSignalPublisher(remote, signals)
			local subscriber = signalRuntime.createRemoteSignalSubscriber(remote, signals)

			local count = 0
			subscriber.on("combat.damaged", function()
				count += 1
			end)

			publisher.toAll("combat.damaged", { amount = 1, source = "lava" })
			t.eq(count, 1)
			subscriber.dispose()
		end)

		t.it("stops delivering after disconnect", function()
			local remote = makeSignalRemote()
			local signals = makeSignals()
			local publisher = signalRuntime.createRemoteSignalPublisher(remote, signals)
			local subscriber = signalRuntime.createRemoteSignalSubscriber(remote, signals)

			local count = 0
			local connection = subscriber.on("combat.damaged", function()
				count += 1
			end)

			publisher.to("Ada", "combat.damaged", { amount = 1, source = "a" })
			connection.disconnect()
			publisher.to("Ada", "combat.damaged", { amount = 2, source = "b" })

			t.eq(count, 1)
			subscriber.dispose()
		end)

		t.it("rejects an unknown signal id on publish", function()
			local remote = makeSignalRemote()
			local signals = makeSignals()
			local publisher = signalRuntime.createRemoteSignalPublisher(remote, signals)

			local ok = pcall(function()
				publisher.to("Ada", "combat.unknown", { amount = 1, source = "a" })
			end)
			t.isFalse(ok, "publishing an unknown signal should throw")
		end)

		t.it("rejects a schema-invalid payload before the wire", function()
			local remote = makeSignalRemote()
			local signals = makeSignals()
			local publisher = signalRuntime.createRemoteSignalPublisher(remote, signals)
			local subscriber = signalRuntime.createRemoteSignalSubscriber(remote, signals)

			local count = 0
			subscriber.on("combat.damaged", function()
				count += 1
			end)

			local ok, err = pcall(function()
				publisher.to("Ada", "combat.damaged", { amount = "lots", source = "trap" })
			end)
			t.isFalse(ok, "invalid payload should throw on publish")
			t.contains(tostring(err), "amount: expected number")
			t.eq(count, 0, "no handler should run for a rejected payload")
			subscriber.dispose()
		end)

		t.it("toBatched sends every payload to one player, yielding between chunks", function()
			local remote = makeSignalRemote()
			local signals = makeSignals()
			local publisher = signalRuntime.createRemoteSignalPublisher(remote, signals)
			local subscriber = signalRuntime.createRemoteSignalSubscriber(remote, signals)

			local received = {}
			subscriber.on("combat.damaged", function(payload)
				table.insert(received, payload)
			end)

			local payloads = {}
			for index = 1, 5 do
				table.insert(payloads, { amount = index, source = "replay" })
			end

			local yields = 0
			local settled, ok = t.await(publisher.toBatched("Ada", "combat.damaged", payloads, {
				chunkSize = 2,
				["yield"] = function()
					yields += 1
				end,
			}))
			t.isTrue(settled and ok, "toBatched should resolve after the last chunk")

			t.eq(#received, 5)
			-- 5 payloads / chunkSize 2 -> yields after index 2 and 4, not after
			-- the last payload.
			t.eq(yields, 2)
			subscriber.dispose()
		end)

		t.it("drops a schema-invalid payload on delivery", function()
			-- Publisher and subscriber on separate remotes: bypass the publisher's
			-- validation to assert the subscriber-side schema guard independently.
			local remote = makeSignalRemote()
			local signals = makeSignals()
			local subscriber = signalRuntime.createRemoteSignalSubscriber(remote, signals)

			local count = 0
			subscriber.on("combat.damaged", function()
				count += 1
			end)

			-- Fire a raw malformed envelope straight onto the wire.
			remote.FireAllClients({ signalId = "combat.damaged", payload = { amount = "nope" } })
			t.eq(count, 0)
			subscriber.dispose()
		end)
	end)
end
