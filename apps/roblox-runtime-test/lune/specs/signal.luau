--!nocheck
-- Execution coverage for the server -> client signal publisher/subscriber
-- (roblox/signal-runtime.ts) over an in-process fake signal RemoteEvent.
local fs = require("@lune/fs")
local serde = require("@lune/serde")

return function(ctx)
	local t = ctx.t
	local schema = ctx.load("schema").schema
	local defineSignal = ctx.load("signal").defineSignal
	local signalRuntime = ctx.load("signal-runtime")
	local wire = ctx.load("wire")

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

	-- Wire frames (docs/wire-protocol.md) pass through the remote as is. The
	-- publishers here go through an unbatched server channel, so a signal is on
	-- the wire when `to` returns.
	local function unbatchedPublisher(remote, signals, unreliableRemote)
		return signalRuntime.createRemoteSignalPublisher(
			wire.createServerChannel(remote, { batching = false }),
			signals,
			unreliableRemote
		)
	end

	-- A subscriber reading `remote` through a client channel of its own.
	local function subscriberOver(remote, signals, unreliableRemote)
		return signalRuntime.createRemoteSignalSubscriber(
			wire.createClientChannel(remote, "signals"),
			signals,
			unreliableRemote
		)
	end

	-- One signal in its own frame, as a raw server would fire it.
	local function frameOf(signalId, payload)
		return { 1, { t = 3, s = signalId, d = payload } }
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
			local publisher = unbatchedPublisher(remote, signals)
			local subscriber = subscriberOver(remote, signals)

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
			local publisher = unbatchedPublisher(remote, signals)
			local subscriber = subscriberOver(remote, signals)

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
			local publisher = unbatchedPublisher(remote, signals)
			local subscriber = subscriberOver(remote, signals)

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
			local publisher = unbatchedPublisher(remote, signals)

			local ok = pcall(function()
				publisher.to("Ada", "combat.unknown", { amount = 1, source = "a" })
			end)
			t.isFalse(ok, "publishing an unknown signal should throw")
		end)

		t.it("rejects a schema-invalid payload before the wire", function()
			local remote = makeSignalRemote()
			local signals = makeSignals()
			local publisher = unbatchedPublisher(remote, signals)
			local subscriber = subscriberOver(remote, signals)

			local count = 0
			subscriber.on("combat.damaged", function()
				count += 1
			end)

			local ok, err = pcall(function()
				publisher.to("Ada", "combat.damaged", { amount = "lots", source = "trap" })
			end)
			t.isFalse(ok, "invalid payload should throw on publish")
			t.contains(tostring(err), "amount: expected finite number")
			t.eq(count, 0, "no handler should run for a rejected payload")
			subscriber.dispose()
		end)

		t.it("toBatched sends every payload to one player, yielding between chunks", function()
			local remote = makeSignalRemote()
			local signals = makeSignals()
			local publisher = unbatchedPublisher(remote, signals)
			local subscriber = subscriberOver(remote, signals)

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

		t.it("routes unreliable signals over the unreliable remote", function()
			local reliableRemote = makeSignalRemote()
			local unreliableRemote = makeSignalRemote()
			local signals = {
				["combat.damaged"] = {
					id = "combat.damaged",
					payload = makeSignals()["combat.damaged"].payload,
				},
				["player.moved"] = {
					id = "player.moved",
					unreliable = true,
				},
			}
			local publisher =
				unbatchedPublisher(reliableRemote, signals, unreliableRemote)
			local subscriber =
				subscriberOver(reliableRemote, signals, unreliableRemote)

			local reliableCount, movedCount = 0, 0
			subscriber.on("combat.damaged", function()
				reliableCount += 1
			end)
			subscriber.on("player.moved", function()
				movedCount += 1
			end)

			publisher.toAll("combat.damaged", { amount = 1, source = "trap" })
			publisher.toAll("player.moved", { x = 1 })

			t.eq(reliableCount, 1, "reliable signal delivered via the reliable remote")
			t.eq(movedCount, 1, "unreliable signal delivered via the unreliable remote")

			-- Prove the routing: a subscriber without the unreliable channel
			-- never sees the unreliable signal.
			local reliableOnly = subscriberOver(reliableRemote, signals)
			local missed = 0
			reliableOnly.on("player.moved", function()
				missed += 1
			end)
			publisher.toAll("player.moved", { x = 2 })
			t.eq(missed, 0, "unreliable signal does not travel the reliable remote")
			reliableOnly.dispose()
			subscriber.dispose()
		end)

		t.it("falls back to the reliable remote when no unreliable remote is given", function()
			local remote = makeSignalRemote()
			local signals = { ["player.moved"] = { id = "player.moved", unreliable = true } }
			local publisher = unbatchedPublisher(remote, signals)
			local subscriber = subscriberOver(remote, signals)

			local count = 0
			subscriber.on("player.moved", function()
				count += 1
			end)
			publisher.toAll("player.moved", { x = 1 })
			t.eq(count, 1)
			subscriber.dispose()
		end)

		t.it("drops a schema-invalid payload on delivery", function()
			-- Publisher and subscriber on separate remotes: bypass the publisher's
			-- validation to assert the subscriber-side schema guard independently.
			local remote = makeSignalRemote()
			local signals = makeSignals()
			local subscriber = subscriberOver(remote, signals)

			local count = 0
			subscriber.on("combat.damaged", function()
				count += 1
			end)

			-- Fire a raw signal with a malformed payload straight onto the wire.
			remote.FireAllClients(frameOf("combat.damaged", { amount = "nope" }))
			t.eq(count, 0)
			subscriber.dispose()
		end)
	end)

	-- The golden table: the frame must stay byte-identical to the pinned bytes,
	-- which is what a client on the previous release decodes.
	local binaryTable = serde.decode(
		"json",
		fs.readFile((string.gsub(ctx.conformancePath, "dispatch%.json$", "binary-signals.json")))
	)

	local function toSchema(descriptor)
		local kind = descriptor.type
		if kind == "string" then
			local base = schema.string()
			return if descriptor.maxLength ~= nil then base.maxLength(descriptor.maxLength) else base
		elseif kind == "number" then
			return if descriptor.format ~= nil then schema[descriptor.format]() else schema.number()
		elseif kind == "boolean" then
			return schema.boolean()
		elseif kind == "literal" then
			return schema.literal(descriptor.value)
		elseif kind == "enum" then
			return schema.enum(descriptor.values)
		elseif kind == "optional" then
			return schema.optional(toSchema(descriptor.inner))
		elseif kind == "array" then
			local base = schema.array(toSchema(descriptor.item))
			return if descriptor.maxItems ~= nil then base.maxItems(descriptor.maxItems) else base
		elseif kind == "object" then
			local fields = {}
			for key, field in descriptor.fields do
				fields[key] = toSchema(field)
			end
			return schema.object(fields)
		elseif kind == "union" then
			local members = {}
			for _, member in descriptor.members do
				table.insert(members, toSchema(member))
			end
			return schema.union(members)
		end
		error(`unknown descriptor type: {tostring(kind)}`)
	end

	local function toHex(buf)
		local parts = {}
		for index = 0, buffer.len(buf) - 1 do
			table.insert(parts, string.format("%02x", buffer.readu8(buf, index)))
		end
		return table.concat(parts)
	end

	local function deepEq(left, right)
		if type(left) ~= "table" or type(right) ~= "table" then
			return left == right
		end
		for key, value in left do
			if not deepEq(value, right[key]) then
				return false
			end
		end
		for key in right do
			if left[key] == nil then
				return false
			end
		end
		return true
	end

	local function recordingRemote()
		local sent = {}
		local remote = makeSignalRemote()
		local fireAll = remote.FireAllClients
		-- One entry per signal a frame carries.
		local function record(frame)
			for index = 2, #frame do
				table.insert(sent, { signalId = frame[index].s, payload = frame[index].d })
			end
			fireAll(frame)
		end
		local recording = {
			FireClient = function(_player, frame)
				record(frame)
			end,
			FireAllClients = function(frame)
				record(frame)
			end,
			OnClientEvent = remote.OnClientEvent,
		}
		return recording, sent
	end

	t.describe("binary signal wire (native)", function()
		for _, case in binaryTable.cases do
			t.it(case.name, function()
				local signals = {
					["fx.hit"] = defineSignal({ id = "fx.hit", payload = toSchema(case.payload), wire = "binary" }),
				}
				local remote, sent = recordingRemote()
				local received = {}
				local subscriber = subscriberOver(remote, signals)
				subscriber.on("fx.hit", function(payload)
					table.insert(received, payload)
				end)

				unbatchedPublisher(remote, signals).to({}, "fx.hit", case.value)

				t.eq(#sent, 1)
				t.eq(typeof(sent[1].payload), "buffer", "a binary signal sends a buffer")
				t.eq(toHex(sent[1].payload), case.bytes, "byte-identical to the golden frame")
				t.eq(#received, 1)
				if not deepEq(received[1], case.value) then
					t.fail(`decoded payload differs: {serde.encode("json", received[1])}`)
				end
				subscriber.dispose()
			end)
		end

		t.it("drops a frame encoded with another schema version, and a non-buffer payload", function()
			local v1 = { ["fx.hit"] = defineSignal({ id = "fx.hit", payload = schema.object({ hp = schema.u8() }), wire = "binary" }) }
			local v2 = { ["fx.hit"] = defineSignal({ id = "fx.hit", payload = schema.object({ hp = schema.u16() }), wire = "binary" }) }
			local remote, sent = recordingRemote()
			local received = { count = 0 }
			local subscriber = subscriberOver(remote, v2)
			subscriber.on("fx.hit", function()
				received.count += 1
			end)

			unbatchedPublisher(remote, v1).to({}, "fx.hit", { hp = 5 })
			remote.FireAllClients(frameOf("fx.hit", { hp = 5 }))
			remote.FireAllClients(frameOf("fx.hit", buffer.create(2)))

			t.eq(#sent, 3)
			t.eq(received.count, 0)
			subscriber.dispose()
		end)

		-- An unbounded array, so only the runtime can catch an oversized frame.
		-- Binary frame: 4-byte header + 4-byte count + 1 per u8. Wire frame:
		-- "fx.burst" (8) + SIGNAL_FRAME_OVERHEAD_BYTES (75).
		local function items(count)
			local list = table.create(count, 1)
			return list
		end

		t.it("refuses a binary unreliable frame that is over the limit with its wire frame", function()
			t.eq(signalRuntime.SIGNAL_FRAME_OVERHEAD_BYTES, 75)
			local signals = {
				["fx.burst"] = defineSignal({
					id = "fx.burst",
					payload = schema.array(schema.u8()),
					wire = "binary",
					unreliable = true,
				}),
			}
			local remote, sent = recordingRemote()
			local publisher = unbatchedPublisher(remote, signals, remote)

			-- 817 + 83 = 900 fits; 818 + 83 = 901 does not.
			publisher.to({}, "fx.burst", items(809))
			t.eq(#sent, 1)

			local ok, err = pcall(publisher.to, {}, "fx.burst", items(810))
			t.isFalse(ok)
			-- Luau prefixes a thrown string with its position.
			t.contains(
				err,
				"Unreliable signal fx.burst carries 901 bytes, over Roblox's 900-byte unreliable limit; larger payloads are dropped without an error."
			)
			t.isFalse((pcall(publisher.toAll, "fx.burst", items(810))))
			t.isFalse((pcall(publisher.toMany, { {} }, "fx.burst", items(810))))
			local settled, resolved, reason = t.await(publisher.toBatched({}, "fx.burst", { items(1), items(810) }))
			t.isTrue(settled)
			t.isFalse(resolved)
			t.contains(tostring(reason), "fx.burst carries 901 bytes")
			t.eq(#sent, 2, "the batch's first payload went out")
		end)

		t.it("leaves reliable and table-encoded signals alone", function()
			local signals = {
				["fx.burst"] = defineSignal({ id = "fx.burst", payload = schema.array(schema.u8()), wire = "binary" }),
				["fx.table"] = defineSignal({ id = "fx.table", payload = schema.array(schema.u8()), unreliable = true }),
			}
			local remote, sent = recordingRemote()
			local publisher = unbatchedPublisher(remote, signals, remote)
			publisher.to({}, "fx.burst", items(2000))
			publisher.to({}, "fx.table", items(2000))
			t.eq(#sent, 2)
		end)
	end)
end
