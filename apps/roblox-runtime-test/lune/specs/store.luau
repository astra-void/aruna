--!nocheck
-- Covers the persistence stack running against the real DataStoreService
-- adapter: the envelope round trip through UpdateAsync, the refusal to write
-- over a record that could not be read, the retry policy, and the session lock
-- that keeps two servers from trading a player's save file back and forth.
return function(ctx)
	local t = ctx.t
	local storeModule = ctx.load("store")
	local playerStoreModule = ctx.load("player-store")
	local datastore = ctx.load("datastore")
	local schema = ctx.load("schema").schema
	local fakes = ctx.fakes

	local profileSchema = schema.object({ coins = schema.number(), name = schema.string() })

	local function definition(overrides)
		local base = {
			id = "player.profile",
			schema = profileSchema,
			defaultValue = { coins = 0, name = "guest" },
		}
		for key, value in overrides or {} do
			base[key] = value
		end
		return base
	end

	-- Every store in this spec talks to the fake DataStoreService through the
	-- real adapter, so the UpdateAsync transform contract is exercised for real.
	local function backendFor(target)
		return datastore.robloxDataStoreBackend(target)
	end

	-- A scheduler whose callbacks only run when a spec says so. Heartbeats are the
	-- one part of the store that arms a timer forever, and a live timer keeps the
	-- Lune scheduler from draining — so every player store here gets a manual
	-- clock, and the heartbeat spec drives it explicitly.
	local function manualScheduler()
		local pending = {}
		return {
			delay = function(_ms, callback)
				table.insert(pending, callback)
				return {
					cancel = function()
						for index, queued in pending do
							if queued == callback then
								table.remove(pending, index)
								break
							end
						end
					end,
				}
			end,
			runAll = function()
				local queued = pending
				pending = {}
				for _, callback in queued do
					callback()
				end
			end,
			count = function()
				return #pending
			end,
		}
	end

	local function storedEntry(key)
		local entries = fakes.dataStores.entriesFor("player.profile")
		return if entries ~= nil then entries[key] else nil
	end

	t.describe("store persistence", function()
		t.it("round-trips a value through a versioned envelope", function()
			local store = storeModule.createStore(definition({ version = 3 }), {
				createBackend = backendFor,
			})

			local settled, ok = t.await(store.save("versioned", { coins = 10, name = "ada" }))
			t.isTrue(settled and ok, "save should resolve")

			local entry = storedEntry("versioned")
			t.eq(entry.v, 3, "envelope version")
			t.eq(entry.d.coins, 10, "stored coins")

			local loadedSettled, loadedOk, result = t.await(store.load("versioned"))
			t.isTrue(loadedSettled and loadedOk, "load should resolve")
			t.isTrue(result.ok, "load result should be ok")
			t.eq(result.value.coins, 10, "loaded coins")
		end)

		t.it("returns the default for a key that was never written", function()
			local store = storeModule.createStore(definition(), { createBackend = backendFor })
			local _, _, result = t.await(store.load("missing"))
			t.isTrue(result.ok, "load should succeed")
			t.eq(result.value.name, "guest", "default value")
		end)

		t.it("fails instead of resetting when the stored record is corrupt", function()
			local store = storeModule.createStore(definition(), { createBackend = backendFor })
			local entries = fakes.dataStores.entriesFor("player.profile")
			entries["corrupt"] = { ["$aruna"] = 1, v = 1, t = 0, d = { coins = "lots" } }

			local _, _, result = t.await(store.load("corrupt"))
			t.isFalse(result.ok, "load should fail")
			t.eq(result.error.name, "StoreValidationError", "error name")

			-- And the corrupt record is still there to inspect: a failed read never
			-- turns into a write.
			local written = t.await(store.save("corrupt", { coins = 1, name = "ada" }))
			t.isTrue(written, "save should settle")
			t.eq(entries["corrupt"].d.coins, "lots", "corrupt record untouched")
		end)

		t.it("refuses a record from a newer version without migrating or writing it", function()
			local migrateCalls = { count = 0 }
			local store = storeModule.createStore(
				definition({
					version = 2,
					migrate = function(stored)
						migrateCalls.count += 1
						return stored
					end,
				}),
				{ createBackend = backendFor }
			)
			local entries = fakes.dataStores.entriesFor("player.profile")
			entries["ahead"] = { ["$aruna"] = 1, v = 3, t = 0, d = { coins = 500, name = "future" } }

			local _, _, loaded = t.await(store.load("ahead"))
			t.isFalse(loaded.ok, "load should fail")
			t.eq(loaded.error.name, "StoreVersionAheadError", "error name")
			t.isFalse(loaded.error.retryable, "not retryable")

			local _, _, saved = t.await(store.save("ahead", { coins = 1, name = "ada" }))
			t.eq(saved.error.name, "StoreVersionAheadError", "save refused")
			local _, _, updated = t.await(store.update("ahead", function(current)
				return current
			end))
			t.eq(updated.error.name, "StoreVersionAheadError", "update refused")

			t.eq(migrateCalls.count, 0, "migrate never ran")
			t.eq(entries["ahead"].v, 3, "record still at its version")
			t.eq(entries["ahead"].d.coins, 500, "record untouched")
		end)

		t.it("refuses a value that does not match the schema", function()
			local store = storeModule.createStore(definition(), { createBackend = backendFor })
			local _, _, result = t.await(store.save("k2", { coins = "many", name = "ada" }))
			t.isFalse(result.ok, "save should fail")
			t.eq(result.error.name, "StoreValidationError", "error name")
		end)

		t.it("retries a transient DataStore failure", function()
			local store = storeModule.createStore(definition({ retry = { baseDelayMs = 1 } }), {
				createBackend = backendFor,
			})
			t.await(store.save("retry", { coins = 3, name = "ada" }))
			fakes.dataStores.queueFailure("get", "502: service unavailable")

			local _, _, result = t.await(store.load("retry"), 3)
			t.isTrue(result.ok, "load should succeed after the retry")
			t.eq(result.value.coins, 3, "the retried read returns the record")
		end)

		t.it("does not retry a place without API access", function()
			local store = storeModule.createStore(definition(), { createBackend = backendFor })
			local before = fakes.dataStores.calls.get
			fakes.dataStores.queueFailure("get", "403: Studio access to APIs is not enabled")

			local _, _, result = t.await(store.load("retry"), 3)
			t.isFalse(result.ok, "load should fail")
			t.eq(result.error.name, "StoreUnavailableError", "error name")
			t.eq(fakes.dataStores.calls.get - before, 1, "should spend exactly one request")
		end)

		t.it("falls back to memory when Studio has no API access", function()
			fakes.studio.enabled = true
			fakes.dataStores.queueFailure("get", "403: Studio access to APIs is not enabled")

			local store = storeModule.createStore(definition({ id = "studio.fallback" }), {
				createBackend = function(target)
					return datastore.robloxDataStoreBackend(target, { onFallback = function() end })
				end,
			})
			fakes.studio.enabled = false

			local _, _, saved = t.await(store.save("k", { coins = 1, name = "ada" }))
			t.isTrue(saved.ok, "save should succeed against the in-memory fallback")
			-- The probe touched the data store, but no write reached it: the record
			-- lives only in memory.
			local entries = fakes.dataStores.entriesFor("studio.fallback")
			t.eq(if entries ~= nil then entries["k"] else nil, nil, "nothing is persisted")
		end)
	end)

	t.describe("session locking", function()
		local function playerStoreFor(owner, nowMs, overrides)
			local settings = overrides or {}
			return playerStoreModule.createPlayerStore(
				definition({
					id = "player.profile",
					session = {
						heartbeatMs = 1_000,
						lockTtlMs = 10_000,
						acquireAttempts = 1,
						acquireDelayMs = 1,
					},
				}),
				{
					createBackend = backendFor,
					owner = owner,
					nowMs = function()
						return nowMs()
					end,
					onLoadFailed = function() end,
					onSaveFailed = function() end,
					scheduler = if settings.scheduler ~= nil then settings.scheduler else manualScheduler(),
				}
			)
		end

		t.it("writes the lock as part of the load", function()
			local player = { UserId = 100 }
			local store = playerStoreFor("server-a", function()
				return 1_000
			end)

			local _, _, result = t.await(store.load(player))
			t.isTrue(result.ok, "load should succeed")
			t.eq(storedEntry("player_100").l.o, "server-a", "lock owner")
		end)

		t.it("refuses a second server while the lock is live", function()
			local player = { UserId = 101 }
			local first = playerStoreFor("server-a", function()
				return 1_000
			end)
			t.await(first.load(player))

			local second = playerStoreFor("server-b", function()
				return 3_000
			end)
			local _, _, blocked = t.await(second.load(player), 3)

			t.isFalse(blocked.ok, "second load should fail")
			t.eq(blocked.error.name, "StoreLockedError", "error name")
		end)

		t.it("treats a record from a newer version as a failed load and writes no lock", function()
			local player = { UserId = 109 }
			local entries = fakes.dataStores.entriesFor("player.profile")
			entries["player_109"] = { ["$aruna"] = 1, v = 3, t = 0, d = { coins = 500, name = "future" } }
			local failures = {}
			local store = playerStoreModule.createPlayerStore(
				definition({
					session = { heartbeatMs = 1_000, lockTtlMs = 10_000, acquireAttempts = 2, acquireDelayMs = 1 },
				}),
				{
					createBackend = backendFor,
					owner = "old-server",
					nowMs = function()
						return 1_000
					end,
					onLoadFailed = function(_player, err)
						table.insert(failures, err.name)
					end,
					onSaveFailed = function() end,
					scheduler = manualScheduler(),
				}
			)

			local _, _, result = t.await(store.load(player), 3)
			t.isFalse(result.ok, "load should fail")
			t.eq(result.error.name, "StoreVersionAheadError")
			t.eq(#failures, 1)
			t.eq(failures[1], "StoreVersionAheadError")
			t.eq(store.get(player), nil, "no document")
			t.eq(entries["player_109"].l, nil, "no lock written")
			t.eq(entries["player_109"].d.coins, 500, "record untouched")

			t.await(store.release(player), 3)
			t.eq(entries["player_109"].d.coins, 500, "release writes nothing")
		end)

		t.it("takes over a lock whose heartbeat went stale", function()
			local player = { UserId = 102 }
			local first = playerStoreFor("server-a", function()
				return 1_000
			end)
			t.await(first.load(player))

			-- Past the 10s TTL: the previous holder is gone.
			local second = playerStoreFor("server-b", function()
				return 30_000
			end)
			local _, _, result = t.await(second.load(player), 3)

			t.isTrue(result.ok, "stale lock should be taken over")
			t.eq(storedEntry("player_102").l.o, "server-b", "new lock owner")
		end)

		t.it("flushes and clears the lock on release", function()
			local player = { UserId = 103 }
			local store = playerStoreFor("server-a", function()
				return 1_000
			end)

			local _, _, loaded = t.await(store.load(player))
			t.isTrue(loaded.ok, "load should succeed")
			loaded.value.update(function(current)
				return { coins = current.coins + 5, name = current.name }
			end)

			t.await(store.release(player), 3)

			local entry = storedEntry("player_103")
			t.eq(entry.d.coins, 5, "final value flushed")
			t.eq(entry.l, nil, "lock cleared")
		end)

		t.it("refuses to write once another server has taken the lock", function()
			local player = { UserId = 104 }
			local clock = { ms = 1_000 }
			local first = playerStoreFor("server-a", function()
				return clock.ms
			end)

			local _, _, loaded = t.await(first.load(player))
			t.isTrue(loaded.ok, "load should succeed")

			-- The lock goes stale and a second server takes it over.
			clock.ms = 40_000
			local second = playerStoreFor("server-b", function()
				return clock.ms
			end)
			t.await(second.load(player), 3)

			-- The original server comes back and tries to flush its outdated value.
			loaded.value.update(function(current)
				return { coins = 999, name = current.name }
			end)
			local _, _, saved = t.await(loaded.value.save(), 3)

			t.isFalse(saved.ok, "the stale server must not win the write")
			t.eq(saved.error.name, "StoreLockedError", "error name")
			t.eq(storedEntry("player_104").d.coins, 0, "the taker's value survives")
		end)

		t.it("refreshes the lock and flushes on a heartbeat tick", function()
			local player = { UserId = 106 }
			local scheduler = manualScheduler()
			local clock = { ms = 1_000 }
			local store = playerStoreFor("server-a", function()
				return clock.ms
			end, { scheduler = scheduler })

			local _, _, loaded = t.await(store.load(player))
			t.isTrue(loaded.ok, "load should succeed")
			loaded.value.update(function(current)
				return { coins = 12, name = current.name }
			end)

			clock.ms = 5_000
			scheduler.runAll()
			-- Let the queued write settle.
			t.await(store.save(player), 3)

			local entry = storedEntry("player_106")
			t.eq(entry.d.coins, 12, "pending changes flushed")
			t.eq(entry.l.h, 5_000, "lock refreshed")
			t.await(store.release(player), 3)
		end)

		t.it("rejects a write through a released document", function()
			local player = { UserId = 105 }
			local store = playerStoreFor("server-a", function()
				return 1_000
			end)

			local _, _, loaded = t.await(store.load(player))
			t.await(store.release(player), 3)

			t.isFalse(loaded.value.isActive(), "document should be closed")
			local late = loaded.value.set({ coins = 1, name = "ada" })
			t.isFalse(late.ok, "late write should fail")
			t.eq(late.error.name, "StoreClosedError", "error name")
		end)
	end)

	-- Persisted format v1 through the real DataStore adapter
	-- (docs/stores.md, "Persisted format v1").
	t.describe("persisted format v1", function()
		local function seed(key, value)
			-- Writing through a store first creates the fake's entry table.
			local store = storeModule.createStore(definition(), { createBackend = backendFor })
			t.await(store.save("seed", { coins = 0, name = "seed" }))
			fakes.dataStores.entriesFor("player.profile")[key] = value
		end

		t.it("round-trips an envelope v1", function()
			local store = storeModule.createStore(definition({ version = 2 }), {
				createBackend = backendFor,
				nowMs = function()
					return 77
				end,
			})
			t.await(store.save("v1-trip", { coins = 4, name = "ada" }))

			local entry = storedEntry("v1-trip")
			t.eq(entry["$aruna"], 1, "marker carries the envelope format")
			t.eq(entry.v, 2, "user version")
			t.eq(entry.t, 77, "write time")
			t.eq(entry.d.coins, 4, "data")
			t.eq(entry.m, nil, "no metadata written when there is none")
			t.eq(entry.l, nil, "no lock written by a keyed store")

			local _, _, loaded = t.await(store.loadSnapshot("v1-trip"))
			t.isTrue(loaded.ok, "load should succeed")
			t.eq(loaded.value.version, 2, "version read back")
			t.eq(loaded.value.value.coins, 4, "value read back")
		end)

		t.it("adopts a raw legacy value at version 0 and saves it as v1", function()
			seed("legacy", { gold = 9 })
			local seen = {}
			local store = storeModule.createStore(
				definition({
					migrate = function(stored, from)
						table.insert(seen, from)
						return { coins = stored.gold, name = "adopted" }
					end,
				}),
				{ createBackend = backendFor }
			)

			local _, _, loaded = t.await(store.loadSnapshot("legacy"))
			t.isTrue(loaded.ok, "adopted load should succeed")
			t.eq(loaded.value.version, 0, "legacy is version 0")
			t.eq(seen[1], 0, "migrate saw version 0")

			t.await(store.save("legacy", loaded.value.value))
			local entry = storedEntry("legacy")
			t.eq(entry["$aruna"], 1, "saved as v1")
			t.eq(entry.v, 1, "at the store's version")
			t.eq(entry.d.coins, 9, "with the adopted data")
		end)

		t.it("does not mistake { v = 1, t = 2 } for an envelope", function()
			seed("lookalike", { v = 1, t = 2 })
			t.eq(storeModule.readStoreRecord({ v = 1, t = 2 }).kind, "legacy", "classified as legacy")
			local received = {}
			local store = storeModule.createStore(
				definition({
					migrate = function(stored, from)
						received.value = stored
						received.from = from
						return { coins = 0, name = "adopted" }
					end,
				}),
				{ createBackend = backendFor }
			)

			local _, _, loaded = t.await(store.load("lookalike"))
			t.isTrue(loaded.ok, "adopted through migrate")
			t.eq(received.from, 0, "at version 0")
			t.eq(received.value.v, 1, "migrate got the whole table")
			t.eq(received.value.t, 2, "migrate got the whole table")
		end)

		t.it("keeps the metadata slot out of migrate and through the next write", function()
			seed("meta", {
				["$aruna"] = 1,
				v = 1,
				t = 0,
				d = { coins = 7 },
				m = {
					["!r"] = { "receipt-1", "receipt-2" },
					h = { k = "token", x = 99 },
					e = 3,
					-- A key a newer Aruna added, without the must-understand marker.
					later = { n = 1 },
				},
			})
			local migrateInput = {}
			local store = storeModule.createStore(
				definition({
					version = 2,
					migrate = function(stored)
						migrateInput.value = stored
						return { coins = stored.coins, name = "v2" }
					end,
				}),
				{ createBackend = backendFor }
			)

			local _, _, updated = t.await(store.update("meta", function(current)
				return { coins = current.coins + 1, name = current.name }
			end))
			t.isTrue(updated.ok, "update should succeed")
			t.eq(migrateInput.value.m, nil, "migrate never sees the metadata")
			t.eq(migrateInput.value.coins, 7, "migrate sees the data")

			local entry = storedEntry("meta")
			t.eq(entry.v, 2, "migrated version written")
			t.eq(entry.d.coins, 8, "updated data written")
			t.eq(#entry.m["!r"], 2, "receipts kept")
			t.eq(entry.m["!r"][2], "receipt-2", "receipts kept in order")
			t.eq(entry.m.h.k, "token", "handoff token kept")
			t.eq(entry.m.e, 3, "erasure marker kept")
			t.eq(entry.m.later.n, 1, "unknown may-ignore key carried verbatim")
		end)

		t.it("evicts the oldest receipt ids beyond the bound", function()
			local meta = { receipts = {} }
			local limit = storeModule.STORE_MAX_RECEIPTS
			for index = 1, limit + 2 do
				meta = storeModule.recordStoreReceipt(meta, "receipt-" .. index).value
			end
			t.eq(#meta.receipts, limit, "bounded")
			t.eq(meta.receipts[1], "receipt-3", "oldest two evicted")
			t.isFalse(storeModule.hasStoreReceipt(meta, "receipt-2"), "evicted id gone")
			t.isTrue(storeModule.hasStoreReceipt(meta, "receipt-" .. (limit + 2)), "newest kept")
		end)

		t.it("refuses a record in a newer envelope format", function()
			seed("format-ahead", { ["$aruna"] = 2, v = 1, t = 0, d = { coins = 1, name = "a" } })
			local store = storeModule.createStore(definition(), { createBackend = backendFor })

			local _, _, loaded = t.await(store.load("format-ahead"))
			t.isFalse(loaded.ok, "load should fail")
			t.eq(loaded.error.name, "StoreVersionAheadError", "error name")
			local _, _, saved = t.await(store.save("format-ahead", { coins = 2, name = "a" }))
			t.eq(saved.error.name, "StoreVersionAheadError", "save refused")
			t.eq(storedEntry("format-ahead")["$aruna"], 2, "record untouched")
		end)

		t.it("refuses an unknown must-understand metadata key and never writes it back", function()
			seed("meta-ahead", {
				["$aruna"] = 1,
				v = 1,
				t = 0,
				d = { coins = 1, name = "a" },
				m = { ["!grants"] = { "g-1" } },
			})
			t.eq(storeModule.STORE_MUST_UNDERSTAND_PREFIX, "!")
			local store = storeModule.createStore(definition(), { createBackend = backendFor })

			local _, _, loaded = t.await(store.load("meta-ahead"))
			t.eq(loaded.error.name, "StoreVersionAheadError", "load refused")
			t.contains(loaded.error.message, "!grants")
			local _, _, saved = t.await(store.save("meta-ahead", { coins = 2, name = "a" }))
			t.eq(saved.error.name, "StoreVersionAheadError", "save refused")
			local entry = storedEntry("meta-ahead")
			t.eq(entry.d.coins, 1, "record untouched")
			t.eq(entry.m["!grants"][1], "g-1", "metadata untouched")
		end)

		t.it("refuses preserved metadata over the bound and an unknown top-level field", function()
			local bound = storeModule.STORE_MAX_PRESERVED_META_BYTES
			t.eq(bound, 4096)
			local function withMeta(length)
				return { ["$aruna"] = 1, v = 1, t = 0, d = { coins = 1, name = "a" }, m = { k = string.rep("x", length) } }
			end
			-- `{"k":"…"}` is 8 bytes plus the string.
			t.eq(storeModule.readStoreRecord(withMeta(bound - 8)).kind, "envelope", "at the bound")
			t.eq(storeModule.readStoreRecord(withMeta(bound - 7)).kind, "malformed", "one byte over")
			local extra = { ["$aruna"] = 1, v = 1, t = 0, d = { coins = 1, name = "a" }, x = 1 }
			t.eq(storeModule.readStoreRecord(extra).kind, "malformed", "top level is closed")

			seed("meta-over", withMeta(bound - 7))
			local store = storeModule.createStore(definition(), { createBackend = backendFor })
			local _, _, loaded = t.await(store.load("meta-over"))
			t.eq(loaded.error.name, "StoreValidationError", "over the bound is malformed")
			local _, _, saved = t.await(store.save("meta-over", { coins = 2, name = "a" }))
			t.eq(saved.error.name, "StoreValidationError", "and never rewritten")
			t.eq(#storedEntry("meta-over").m.k, bound - 7, "not truncated")
		end)
	end)

	t.describe("store values", function()
		t.it("names a real Instance", function()
			-- A TypeScript spec cannot build a real Instance under Lune; @lune/roblox
			-- can, and `typeIs(value, "Instance")` is the branch this reaches.
			local part = require("@lune/roblox").Instance.new("Part")
			local message = storeModule.findStoreValueViolation({ part = part })
			t.contains(message, "part")
			t.contains(message, "is a Roblox Instance, which DataStores cannot encode")
		end)
	end)
end
