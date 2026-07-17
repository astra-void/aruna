--!nocheck
-- Covers the app-level in-process dispatch surface: `createServerApp` exposes
-- `actions` and `dispatch(actionId, ctx, input)` — the supported way to
-- exercise actions from tests without a RemoteEvent.
return function(ctx)
	local t = ctx.t
	local serverApp = ctx.load("server-app")
	local schema = ctx.load("schema").schema
	local fakes = ctx.fakes

	local player = { UserId = 1, Name = "Tester" }

	t.describe("server app", function()
		t.it("exposes the action map it was created with", function()
			local actions = {
				echo = {
					id = "echo",
					run = function(_self, _context, input)
						return { value = input.value }
					end,
				},
			}
			local app = serverApp.createServerApp({ actions = actions })
			t.eq(app.actions, actions)
			app.dispose()
		end)

		t.it("dispatch resolves with the action output", function()
			local app = serverApp.createServerApp({
				actions = {
					echo = {
						id = "echo",
						run = function(_self, _context, input)
							return { value = input.value }
						end,
					},
				},
			})
			local settled, ok, output = t.await(app.dispatch("echo", { player = player }, { value = 7 }))
			t.isTrue(settled and ok, "dispatch should resolve")
			t.eq(output.value, 7)
			app.dispose()
		end)

		t.it("dispatch rejects with the error string on failure", function()
			local app = serverApp.createServerApp({
				actions = {
					boom = {
						id = "boom",
						run = function(_self, _context, _input)
							error("kaboom")
						end,
					},
				},
			})
			local settled, ok, reason = t.await(app.dispatch("boom", { player = player }, nil))
			t.isTrue(settled, "dispatch settled")
			t.isFalse(ok, "dispatch should reject on action error")
			t.contains(reason.message, "kaboom")

			local settledMissing, okMissing, missingReason = t.await(app.dispatch("missing", { player = player }, nil))
			t.isTrue(settledMissing, "missing-action dispatch settled")
			t.isFalse(okMissing, "missing action should reject")
			t.contains(missingReason.message, "unknown action")
			app.dispose()
		end)

		t.it("owns the PlayerRemoving connection for per-player cleanup", function()
			local removed = {}
			local app = serverApp.createServerApp({
				actions = {},
				onPlayerRemoving = function(leaving)
					table.insert(removed, leaving.UserId)
				end,
			})

			fakes.playerRemoving:Fire({ UserId = 7, Name = "Leaver" })
			t.eq(#removed, 1)
			t.eq(removed[1], 7)

			-- Disposing the app disconnects the hook.
			app.dispose()
			fakes.playerRemoving:Fire({ UserId = 8, Name = "Late" })
			t.eq(#removed, 1, "no callback after dispose")
		end)

		t.it("dispatch passes the ctx player through to the action", function()
			local app = serverApp.createServerApp({
				actions = {
					whoami = {
						id = "whoami",
						run = function(_self, context, _input)
							return { userId = context.player.UserId }
						end,
					},
				},
			})
			local _, _, output = t.await(app.dispatch("whoami", { player = player }, nil))
			t.eq(output.userId, 1)
			app.dispose()
		end)
	end)

	t.describe("player sessions and lifecycle", function()
		t.it("injects the per-player session into ctx.session", function()
			local seen = {}
			local app = serverApp.createServerApp({
				actions = {
					hit = {
						id = "hit",
						run = function(_self, context, _input)
							table.insert(seen, { userId = context.player.UserId, hp = context.session.hp })
							return { ok = true }
						end,
					},
				},
				createSession = function(joining)
					return { hp = 100, owner = joining.UserId }
				end,
			})

			local sessionPlayer = { UserId = 7, Name = "Ada" }
			fakes.playerAdded:Fire(sessionPlayer)
			local settled, ok = t.await(app.dispatch("hit", { player = sessionPlayer }, nil))
			t.isTrue(settled, "dispatch settled")
			t.isTrue(ok, "dispatch resolved")
			t.eq(#seen, 1)
			t.eq(seen[1].hp, 100)
			app.dispose()
		end)

		t.it("fires onPlayerAdded with the session and drops it on leave", function()
			local joins = {}
			local leaves = {}
			local app = serverApp.createServerApp({
				actions = {},
				createSession = function(_joining)
					return { hp = 50 }
				end,
				onPlayerAdded = function(joining, session)
					table.insert(joins, { userId = joining.UserId, hp = session.hp })
				end,
				onPlayerRemoving = function(leaving, session)
					table.insert(leaves, { userId = leaving.UserId, hp = session ~= nil and session.hp or -1 })
				end,
			})

			local lifecyclePlayer = { UserId = 3, Name = "Bee" }
			fakes.playerAdded:Fire(lifecyclePlayer)
			fakes.playerRemoving:Fire(lifecyclePlayer)
			t.eq(#joins, 1)
			t.eq(joins[1].hp, 50)
			t.eq(#leaves, 1)
			t.eq(leaves[1].hp, 50)
			app.dispose()
		end)

		t.it("boot-backfills onPlayerAdded for players already present", function()
			table.clear(fakes.playerList)
			table.insert(fakes.playerList, { UserId = 11, Name = "Pre1" })
			table.insert(fakes.playerList, { UserId = 12, Name = "Pre2" })

			local joined = {}
			local app = serverApp.createServerApp({
				actions = {},
				onPlayerAdded = function(joining, _session)
					table.insert(joined, joining.UserId)
				end,
			})

			t.eq(#joined, 2)
			t.eq(joined[1], 11)
			t.eq(joined[2], 12)
			app.dispose()
			table.clear(fakes.playerList)
		end)
	end)

	t.describe("input defaults", function()
		t.it("fills a defaulted input field before the handler runs", function()
			local seen = {}
			local app = serverApp.createServerApp({
				actions = {
					buy = {
						id = "buy",
						input = schema.object({
							item = schema.string(),
							count = schema.number().default(1),
						}),
						run = function(_self, _context, input)
							seen.item = input.item
							seen.count = input.count
							return { ok = true }
						end,
					},
				},
			})

			-- The caller omits `count`; the server fills the default.
			local settled, ok = t.await(app.dispatch("buy", { player = player }, { item = "sword" }))
			t.isTrue(settled, "settled")
			t.isTrue(ok, "resolved")
			t.eq(seen.item, "sword")
			t.eq(seen.count, 1)

			-- A provided value is kept.
			t.await(app.dispatch("buy", { player = player }, { item = "shield", count = 3 }))
			t.eq(seen.count, 3)
			app.dispose()
		end)
	end)
end
