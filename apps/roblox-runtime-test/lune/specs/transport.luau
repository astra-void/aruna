--!nocheck
return function(ctx)
	local t = ctx.t
	local transport = ctx.load("roblox-runtime")
	local createActionRegistry = ctx.load("server-runtime").createActionRegistry

	t.describe("RemoteEvent transport", function()
		local registry = createActionRegistry({
			ping = {
				id = "ping",
				run = function(_self, _context, input)
					return { reply = input.msg }
				end,
			},
		})
		-- Bind the server first so the shared remote exists, then build a client
		-- invoker that waits for it.
		local binding = transport.bindDefaultRobloxActionRemoteEvent(registry)
		local invoke = transport.createDefaultRobloxActionInvoker()

		t.it("completes a client -> server -> client round trip", function()
			local settled, ok, value = t.await(invoke("ping", { msg = "hello" }))
			t.isTrue(settled, "round trip settled")
			t.isTrue(ok, "invoker resolved")
			t.eq(value.reply, "hello")
		end)

		t.it("rejects when the server reports a failure", function()
			local settled, ok, value = t.await(invoke("missing", {}))
			t.isTrue(settled, "round trip settled")
			t.isFalse(ok, "invoker rejected")
			t.contains(value, "unknown action")
		end)

		t.it("rejects with a timeout when no response arrives", function()
			-- Drop the server listener so requests get no reply.
			binding.disconnect()
			local timedInvoke = transport.createDefaultRobloxActionInvoker({ requestTimeoutMs = 20 })
			local settled, ok, value = t.await(timedInvoke("ping", { msg = "x" }), 0.5)
			t.isTrue(settled, "timeout settled")
			t.isFalse(ok, "invoker rejected")
			t.contains(value, "timed out")
		end)
	end)
end
