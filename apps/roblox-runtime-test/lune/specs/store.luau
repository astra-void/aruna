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
			entries["corrupt"] = { v = 1, t = 0, d = { coins = "lots" } }

			local _, _, result = t.await(store.load("corrupt"))
			t.isFalse(result.ok, "load should fail")
			t.eq(result.error.name, "StoreValidationError", "error name")

			-- And the corrupt record is still there to inspect: a failed read never
			-- turns into a write.
			local written = t.await(store.save("corrupt", { coins = 1, name = "ada" }))
			t.isTrue(written, "save should settle")
			t.eq(entries["corrupt"].d.coins, "lots", "corrupt record untouched")
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
			t.eq(storedEntry("player_100").lock.owner, "server-a", "lock owner")
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
			t.eq(storedEntry("player_102").lock.owner, "server-b", "new lock owner")
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
			t.eq(entry.lock, nil, "lock cleared")
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
			t.eq(entry.lock.heartbeatMs, 5_000, "lock refreshed")
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
end
