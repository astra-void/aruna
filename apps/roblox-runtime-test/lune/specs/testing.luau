--!nocheck
-- Covers `aruna/testing` compiled to Luau: the surface a game project's specs
-- are written against has to run in the runtime that ships, not just typecheck.
-- Both halves are exercised — the in-process harness (dispatch, lifecycle,
-- recorded signals, client round trip) and the framework (collection, hooks,
-- async bodies, matchers).
return function(ctx)
	local t = ctx.t
	local testing = ctx.load("testing")
	local schema = ctx.load("schema").schema

	local function purchaseSignals()
		return {
			["shop.purchased"] = {
				id = "shop.purchased",
				payload = schema.object({ item = schema.string() }),
			},
		}
	end

	local function buyAction()
		return {
			id = "shop.buy",
			input = schema.object({ item = schema.string() }),
			run = function(_self, context, input)
				context.publisher.to(context.player, "shop.purchased", { item = input.item })
				return { ok = true }
			end,
		}
	end

	t.describe("testing harness", function()
		t.it("creates player doubles with distinct user ids", function()
			local first = testing.createTestPlayer()
			local second = testing.createTestPlayer({ name = "Ada", userId = 99 })
			t.isTrue(first.UserId ~= second.UserId, "user ids should differ")
			t.eq(second.Name, "Ada")
			t.eq(second.UserId, 99)
		end)

		t.it("dispatches through validation and returns the output", function()
			local harness = testing.createTestServerApp({
				actions = { ["shop.buy"] = buyAction() },
				signals = purchaseSignals(),
			})
			local player = testing.createTestPlayer()

			local settled, ok, output = t.await(harness.invoke(player, "shop.buy", { item = "sword" }))
			t.isTrue(settled and ok, "invoke should resolve")
			t.isTrue(output.ok, "action returned ok")

			harness.dispose()
		end)

		t.it("rejects input the schema does not accept", function()
			local harness = testing.createTestServerApp({
				actions = { ["shop.buy"] = buyAction() },
				signals = purchaseSignals(),
			})
			local settled, ok, reason =
				t.await(harness.invoke(testing.createTestPlayer(), "shop.buy", { item = 42 }))
			t.isTrue(settled, "invoke settled")
			t.isFalse(ok, "invalid input should reject")
			t.contains(reason.message, "invalid action input")

			harness.dispose()
		end)

		t.it("records every published signal with its recipient", function()
			local harness = testing.createTestServerApp({
				actions = { ["shop.buy"] = buyAction() },
				signals = purchaseSignals(),
			})
			local player = testing.createTestPlayer()

			t.await(harness.invoke(player, "shop.buy", { item = "shield" }))

			local records = harness.published()
			t.eq(#records, 1)
			t.eq(records[1].signalId, "shop.purchased")
			t.eq(records[1].payload.item, "shield")
			t.eq(records[1].player, player)

			-- takePublished drains the log.
			t.eq(#harness.takePublished(), 1)
			t.eq(#harness.published(), 0)

			harness.dispose()
		end)

		t.it("drives the player lifecycle: sessions and hooks", function()
			local joined = {}
			local left = {}
			local harness = testing.createTestServerApp({
				actions = {
					whoami = {
						id = "whoami",
						run = function(_self, context, _input)
							return { visits = context.session.visits, name = context.player.Name }
						end,
					},
				},
				createSession = function(_player)
					return { visits = 1 }
				end,
				onPlayerAdded = function(player, _session)
					table.insert(joined, player.Name)
				end,
				onPlayerRemoving = function(player, _session)
					table.insert(left, player.Name)
				end,
			})

			local player = testing.createTestPlayer({ name = "Linus" })
			harness.join(player)
			t.eq(#joined, 1)
			t.eq(joined[1], "Linus")
			t.eq(#harness.players(), 1)

			local settled, ok, output = t.await(harness.invoke(player, "whoami", nil))
			t.isTrue(settled and ok, "whoami should resolve")
			t.eq(output.visits, 1)
			t.eq(output.name, "Linus")

			harness.leave(player)
			t.eq(#left, 1)
			t.eq(#harness.players(), 0)

			harness.dispose()
		end)

		t.it("enforces the app's rate limit", function()
			local harness = testing.createTestServerApp({
				actions = {
					ping = {
						id = "ping",
						rateLimit = { key = "player", windowMs = 60000, max = 1 },
						run = function(_self, _context, _input)
							return "pong"
						end,
					},
				},
			})
			local player = testing.createTestPlayer()

			local _, firstOk = t.await(harness.invoke(player, "ping", nil))
			t.isTrue(firstOk, "first call allowed")
			local settled, secondOk, reason = t.await(harness.invoke(player, "ping", nil))
			t.isTrue(settled, "second call settled")
			t.isFalse(secondOk, "second call throttled")
			t.contains(reason.message, "rate limited")

			harness.dispose()
		end)

		t.it("routes a client's invoke and its subscriber through the server", function()
			local harness = testing.createTestServerApp({
				actions = { ["shop.buy"] = buyAction() },
				signals = purchaseSignals(),
			})
			local player = testing.createTestPlayer()
			local other = testing.createTestPlayer()
			local client = harness.client(player)

			local received = {}
			client.subscriber.on("shop.purchased", function(payload)
				table.insert(received, payload.item)
			end)

			local settled, ok = t.await(client.invoke("shop.buy", { item = "rope" }))
			t.isTrue(settled and ok, "client invoke should resolve")
			t.eq(#received, 1)
			t.eq(received[1], "rope")

			-- A signal aimed at someone else must not reach this client.
			t.await(harness.invoke(other, "shop.buy", { item = "lamp" }))
			t.eq(#received, 1)

			harness.dispose()
		end)
	end)

	t.describe("testing framework", function()
		t.it("collects tests, runs them, and counts pass/fail", function()
			testing.resetTests()
			testing.describe("math", function()
				testing.it("adds", function()
					testing.expect(1 + 1).toBe(2)
				end)
				testing.it("fails loudly", function()
					testing.expect(1).toBe(2)
				end)
			end)
			t.eq(testing.collectedTestCount(), 2)

			local settled, ok, report = t.await(testing.runTests())
			t.isTrue(settled and ok, "runTests should resolve")
			t.eq(report.passed, 1)
			t.eq(report.failed, 1)
			t.eq(report.outcomes[1].name, "math > adds")
			t.contains(report.outcomes[2].message, "expected 1 to be 2")
			testing.resetTests()
		end)

		t.it("awaits promise-returning bodies and records rejections", function()
			testing.resetTests()
			testing.describe("async", function()
				testing.it("resolves", function()
					return ctx.Promise.resolve(nil)
				end)
				testing.it("rejects", function()
					return ctx.Promise.reject({ message = "boom" })
				end)
			end)

			local _, _, report = t.await(testing.runTests())
			t.eq(report.passed, 1)
			t.eq(report.failed, 1)
			t.eq(report.outcomes[2].message, "boom")
			testing.resetTests()
		end)

		t.it("runs hooks outermost-in, and afterEach even after a failure", function()
			testing.resetTests()
			local order = {}
			testing.describe("outer", function()
				testing.beforeEach(function()
					table.insert(order, "outer:before")
				end)
				testing.afterEach(function()
					table.insert(order, "outer:after")
				end)
				testing.describe("inner", function()
					testing.beforeEach(function()
						table.insert(order, "inner:before")
					end)
					testing.afterEach(function()
						table.insert(order, "inner:after")
					end)
					testing.it("fails", function()
						table.insert(order, "test")
						error("nope")
					end)
				end)
			end)

			local _, _, report = t.await(testing.runTests())
			t.eq(report.failed, 1)
			t.eq(table.concat(order, ","), "outer:before,inner:before,test,inner:after,outer:after")
			testing.resetTests()
		end)

		t.it("keeps skipped tests visible without running them", function()
			testing.resetTests()
			local ran = false
			testing.describe("suite", function()
				testing.itSkip("not yet", function()
					ran = true
				end)
			end)

			local _, _, report = t.await(testing.runTests())
			t.isFalse(ran, "skipped body should not run")
			t.eq(report.skipped, 1)
			t.eq(report.outcomes[1].name, "suite > not yet")
			testing.resetTests()
		end)

		t.it("matches structurally, negates, and reads both rejection shapes", function()
			testing.expect({ a = { 1, 2 } }).toEqual({ a = { 1, 2 } })
			-- `not` is a Luau keyword, so the negated matcher set is reached by index here;
			-- a project's specs are TypeScript and just write `.not`.
			testing.expect(1)["not"].toBe(2)
			testing.expect("hello").toContain("ell")
			testing.expect({ 1, 2, 3 }).toHaveLength(3)
			testing.expect(function()
				error("kaboom")
			end).toThrow("kaboom")

			local settled, ok = t.await(
				testing.expect(ctx.Promise.reject({ message = "rate limited" })).rejects.toThrow("rate limited")
			)
			t.isTrue(settled and ok, "rejects.toThrow should pass")
		end)
	end)
end
