--!nocheck
-- Covers the app-level in-process dispatch surface: `createServerApp` exposes
-- `actions` and `dispatch(actionId, ctx, input)` — the supported way to
-- exercise actions from tests without a RemoteEvent.
return function(ctx)
	local t = ctx.t
	local serverApp = ctx.load("server-app")
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
end
